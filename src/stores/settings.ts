/**
 * 设置状态管理 (Zustand)
 * -------------------------------------------------
 * 对应 SPEC v0.3 §6 / §7.3 / §9.2。存储所有 API keys / AI 模型选择 / 高级模式开关。
 * 数据持久层：IndexedDB via ../services/db.ts（settings KV store）。
 *
 * 关键设计：
 * - 每个字段单独一行 KV，方便未来扩展与迁移
 * - updateSettings(patch) 支持局部更新，写入 state + 同步落 IndexedDB
 * - init() 从 IndexedDB rehydrate 所有字段，未存过的走 DEFAULT_SETTINGS
 * - refreshModels() 拉 /v1/models + 缓存（TTL 24h，与 SPEC §9.3 对齐）
 * - runFactCheckTest() 走 dual-engine（AI-1 生成 + AI-2 忠实性核查）
 *   · M3.5.1: 增加可选 onProgress 回调，透传给 runDualEngine
 */
import { create } from 'zustand'
import {
  fetchSiliconflowModels,
  loadCachedModels,
  loadCachedModelsFetchedAt,
  saveModelsCache,
  SILICONFLOW_BASE_URL,
} from '../services/ai/models'
import { runDualEngine } from '../services/ai/dual-engine'
import { getSetting, putSetting, SETTING_KEYS } from '../services/db'
import type {
  AIModel,
  DualEngineProgressCallback,
  DualEngineResult,
  SettingsData,
  SettingsState,
} from '../types'

/** SPEC v0.3 §7.3 默认值 */
const DEFAULT_SETTINGS: SettingsData = {
  advancedMode: false,
  aiProviderMode: 'siliconflow',
  siliconflowApiKey: '',
  ai1Model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
  ai2Model: 'deepseek-ai/DeepSeek-V3.2',
  customAi1BaseUrl: '',
  customAi1ApiKey: '',
  customAi1Model: '',
  customAi2BaseUrl: '',
  customAi2ApiKey: '',
  customAi2Model: '',
}

/** SettingsData 字段 → SETTING_KEYS 映射 */
const KEY_MAP: Record<keyof SettingsData, string> = {
  advancedMode: SETTING_KEYS.ADVANCED_MODE,
  aiProviderMode: SETTING_KEYS.AI_PROVIDER_MODE,
  siliconflowApiKey: SETTING_KEYS.SILICONFLOW_API_KEY,
  ai1Model: SETTING_KEYS.AI_1_MODEL,
  ai2Model: SETTING_KEYS.AI_2_MODEL,
  customAi1BaseUrl: SETTING_KEYS.CUSTOM_AI_1_BASE_URL,
  customAi1ApiKey: SETTING_KEYS.CUSTOM_AI_1_API_KEY,
  customAi1Model: SETTING_KEYS.CUSTOM_AI_1_MODEL,
  customAi2BaseUrl: SETTING_KEYS.CUSTOM_AI_2_BASE_URL,
  customAi2ApiKey: SETTING_KEYS.CUSTOM_AI_2_API_KEY,
  customAi2Model: SETTING_KEYS.CUSTOM_AI_2_MODEL,
}

/** 字段 → 序列化/反序列化（boolean 需转字符串） */
function serialize(_key: keyof SettingsData, value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value ?? '')
}
function deserialize(
  key: keyof SettingsData,
  raw: string | null,
): SettingsData[typeof key] {
  const def = DEFAULT_SETTINGS[key]
  if (raw === null) return def as SettingsData[typeof key]
  if (typeof def === 'boolean') {
    return (raw === '1') as SettingsData[typeof key]
  }
  if (key === 'aiProviderMode') {
    return (raw === 'custom'
      ? 'custom'
      : 'siliconflow') as SettingsData[typeof key]
  }
  return raw as SettingsData[typeof key]
}

interface SettingsActions {
  /** 应用启动时调用：从 IndexedDB 恢复所有设置 + 加载模型清单缓存 */
  init: () => Promise<void>
  /** 局部更新：state + IndexedDB 同步 */
  updateSettings: (patch: Partial<SettingsData>) => Promise<void>
  /** 拉取硅基流动 /v1/models（force=true 忽略 24h 缓存） */
  refreshModels: (force?: boolean) => Promise<AIModel[]>
  /** 用当前设置跑一次双引擎试运行（M3.5：忠实性核查 · M3.5.1：分阶段进度回调） */
  runFactCheckTest: (
    sourceMaterial: string,
    ai1Instruction?: string,
    onProgress?: DualEngineProgressCallback,
  ) => Promise<DualEngineResult>
  /** 清空错误提示 */
  clearError: () => void
  /** 重置为默认值（保留 API keys 不清，避免误伤） */
  resetToDefaults: () => Promise<void>
}

const initialState: SettingsState = {
  ...DEFAULT_SETTINGS,
  isInitialized: false,
  siliconflowModels: [],
  siliconflowModelsFetchedAt: null,
  isLoadingModels: false,
  isRunningDualEngine: false,
  lastDualEngineResult: null,
  error: null,
}

/** M3.5 默认 AI-1 指令 */
const DEFAULT_AI1_INSTRUCTION =
  '用 2-3 句话简洁忠实地总结上述源材料，保留关键事实。'

export const useSettingsStore = create<SettingsState & SettingsActions>(
  (set, get) => ({
    ...initialState,

    init: async () => {
      // 1. rehydrate 所有 SettingsData 字段
      const entries = await Promise.all(
        (Object.keys(KEY_MAP) as (keyof SettingsData)[]).map(async (field) => {
          const raw = await getSetting(KEY_MAP[field])
          return [field, deserialize(field, raw)] as const
        }),
      )
      const patch: Partial<SettingsData> = {}
      for (const [field, value] of entries) {
        // @ts-expect-error runtime-safe: field 与 value 一一对应
        patch[field] = value
      }

      // 2. 加载模型清单缓存
      const cachedModels = await loadCachedModels()
      const fetchedAt = await loadCachedModelsFetchedAt()

      set({
        ...patch,
        siliconflowModels: cachedModels ?? [],
        siliconflowModelsFetchedAt: fetchedAt,
        isInitialized: true,
      })
    },

    updateSettings: async (patch) => {
      set(patch)
      await Promise.all(
        (Object.keys(patch) as (keyof SettingsData)[]).map((field) =>
          putSetting(KEY_MAP[field], serialize(field, patch[field])),
        ),
      )
    },

    refreshModels: async (force = false) => {
      const state = get()
      const apiKey = state.siliconflowApiKey.trim()
      if (!apiKey) {
        set({ error: '请先填写硅基流动 API Key' })
        throw new Error('missing siliconflow api key')
      }

      if (!force) {
        const cached = await loadCachedModels()
        if (cached && cached.length > 0) {
          const at = await loadCachedModelsFetchedAt()
          set({
            siliconflowModels: cached,
            siliconflowModelsFetchedAt: at,
          })
          return cached
        }
      }

      set({ isLoadingModels: true, error: null })
      try {
        const models = await fetchSiliconflowModels(apiKey)
        const at = await saveModelsCache(models)
        set({
          siliconflowModels: models,
          siliconflowModelsFetchedAt: at,
          isLoadingModels: false,
        })
        return models
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        set({ isLoadingModels: false, error: msg })
        throw err
      }
    },

    runFactCheckTest: async (
      sourceMaterial,
      ai1Instruction = DEFAULT_AI1_INSTRUCTION,
      onProgress,
    ) => {
      const state = get()

      let ai1BaseUrl: string
      let ai1ApiKey: string
      let ai1Model: string
      let ai2BaseUrl: string
      let ai2ApiKey: string
      let ai2Model: string

      if (state.aiProviderMode === 'custom' && state.advancedMode) {
        ai1BaseUrl = state.customAi1BaseUrl.trim()
        ai1ApiKey = state.customAi1ApiKey.trim()
        ai1Model = state.customAi1Model.trim()
        ai2BaseUrl = state.customAi2BaseUrl.trim()
        ai2ApiKey = state.customAi2ApiKey.trim()
        ai2Model = state.customAi2Model.trim()
        if (!ai1BaseUrl || !ai1ApiKey || !ai1Model) {
          throw new Error('高级模式下 AI-1 端点/Key/模型均需填写')
        }
        if (!ai2BaseUrl || !ai2ApiKey || !ai2Model) {
          throw new Error('高级模式下 AI-2 端点/Key/模型均需填写')
        }
      } else {
        const apiKey = state.siliconflowApiKey.trim()
        if (!apiKey) throw new Error('请先填写硅基流动 API Key')
        ai1BaseUrl = SILICONFLOW_BASE_URL
        ai1ApiKey = apiKey
        ai1Model = state.ai1Model
        ai2BaseUrl = SILICONFLOW_BASE_URL
        ai2ApiKey = apiKey
        ai2Model = state.ai2Model
      }

      set({ isRunningDualEngine: true, error: null })
      try {
        const result = await runDualEngine({
          taskType: 'faithfulness_check',
          sourceMaterial,
          ai1Instruction,
          ai1: { baseUrl: ai1BaseUrl, apiKey: ai1ApiKey, model: ai1Model },
          ai2: { baseUrl: ai2BaseUrl, apiKey: ai2ApiKey, model: ai2Model },
          onProgress,
        })
        set({ isRunningDualEngine: false, lastDualEngineResult: result })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        set({ isRunningDualEngine: false, error: msg })
        throw err
      }
    },

    clearError: () => set({ error: null }),

    resetToDefaults: async () => {
      const keep: Partial<SettingsData> = {
        siliconflowApiKey: get().siliconflowApiKey,
        customAi1ApiKey: get().customAi1ApiKey,
        customAi2ApiKey: get().customAi2ApiKey,
      }
      const merged: SettingsData = { ...DEFAULT_SETTINGS, ...keep }
      set(merged)
      await Promise.all(
        (Object.keys(merged) as (keyof SettingsData)[]).map((field) =>
          putSetting(KEY_MAP[field], serialize(field, merged[field])),
        ),
      )
    },
  }),
)
