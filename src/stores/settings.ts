/**
 * 设置状态管理 (Zustand)
 * -------------------------------------------------
 * 对应 SPEC v0.3 §6 / §7.3 / §9.2 / §4.8。
 *
 * 存储分层（SPEC §2.3 硬性禁忌 + §4.8）：
 * - 敏感凭据（API key / Token）→ IndexedDB settings object store（本机，不进 md）
 * - 非敏感设置（AI 模型选择 / 模式开关等）→ GitHub 私库 settings/global.md
 *
 * 关键设计：
 * - init() 只从 IndexedDB 恢复敏感凭据，非敏感字段走默认值
 * - syncFromGitHub() 在 workspace 就绪后从私库加载非敏感设置
 * - updateSettings(patch) 敏感→IndexedDB，非敏感→防抖写 GitHub global.md
 * - refreshModels() 拉 /v1/models + 缓存（TTL 24h，与 SPEC §9.3 对齐）
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
import { loadGlobalSettings, saveGlobalSettings } from '../services/globalSettings'
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
  ai1Model: 'Qwen/Qwen3.6-27B',
  ai2Model: 'deepseek-ai/DeepSeek-V3.2',
  customAi1BaseUrl: '',
  customAi1ApiKey: '',
  customAi1Model: '',
  customAi2BaseUrl: '',
  customAi2ApiKey: '',
  customAi2Model: '',
  mineruToken: '',
  mineruWorkerUrl: '',
  extractCoverImage: true,
  mineruDebugMode: true,
}

/** 敏感字段（只存 IndexedDB，不进 GitHub md 文件）—— SPEC §2.3/§4.8 */
const SENSITIVE_FIELDS: (keyof SettingsData)[] = [
  'siliconflowApiKey',
  'customAi1ApiKey',
  'customAi2ApiKey',
  'mineruToken',
]

/** 敏感字段 → IndexedDB SETTING_KEYS 映射 */
const SENSITIVE_KEY_MAP: Record<string, string> = {
  siliconflowApiKey: SETTING_KEYS.SILICONFLOW_API_KEY,
  customAi1ApiKey: SETTING_KEYS.CUSTOM_AI_1_API_KEY,
  customAi2ApiKey: SETTING_KEYS.CUSTOM_AI_2_API_KEY,
  mineruToken: SETTING_KEYS.MINERU_TOKEN,
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

/**
 * 检测受污染的 secret 字段
 * -------------------------------------------------
 * 场景：Chrome/Edge 密码管理器保存了 Login 页的 GitHub PAT (ghp_/github_pat_/gho_/ghu_)，
 * 之后 autofill 到 Settings 页的 SiliconFlow / MinerU / Custom AI key 字段。
 * 检测规则：这些字段绝不可能以 GitHub token 前缀开头（SiliconFlow 用 sk-*，MinerU 用 JWT eyJ*）
 */
function detectPatContamination(
  patch: Partial<SettingsData>,
): (keyof SettingsData)[] {
  const secretFields: (keyof SettingsData)[] = [
    'siliconflowApiKey',
    'customAi1ApiKey',
    'customAi2ApiKey',
    'mineruToken',
  ]
  const patPrefixes = ['ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_']
  return secretFields.filter((field) => {
    const val = String(patch[field] ?? '').trim()
    return val.length > 0 && patPrefixes.some((p) => val.startsWith(p))
  })
}

interface SettingsActions {
  /** 应用启动时调用：从 IndexedDB 恢复敏感凭据 + 加载模型清单缓存 */
  init: () => Promise<void>
  /** workspace 就绪后调用：从 GitHub 私库 settings/global.md 加载非敏感设置 */
  syncFromGitHub: () => Promise<void>
  /** 局部更新：敏感→IndexedDB，非敏感→防抖写 GitHub global.md */
  updateSettings: (patch: Partial<SettingsData>) => Promise<void>
  /** 拉取硅基流动 /v1/models（force=true 忽略 24h 缓存） */
  refreshModels: (force?: boolean) => Promise<AIModel[]>
  /** 用当前设置跑一次双引擎试运行（M3.5：忠实性核查 · M3.5.1：分阶段进度回调） */
  runFactCheckTest: (
    sourceMaterial: string,
    ai1Instruction?: string,
    onProgress?: DualEngineProgressCallback,
  ) => Promise<DualEngineResult>
  /** 解析当前设置 → 双引擎两侧端点配置（AI-1 / AI-2）。
   *  供写作页 / 学习页 / 期刊模板提取 / 题图识别等所有"AI 可信检索"场景复用，
   *  确保各场景走同一套凭据来源（硅基流动或自定义端点）。 */
  getDualEngineConfig: () => {
    ai1: { baseUrl: string; apiKey: string; model: string }
    ai2: { baseUrl: string; apiKey: string; model: string }
  }
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

/** 非敏感设置防抖写 GitHub global.md（避免频繁 API 调用） */
let globalSettingsSyncTimer: ReturnType<typeof setTimeout> | null = null
const GLOBAL_SETTINGS_SYNC_DEBOUNCE_MS = 2000

function scheduleGlobalSettingsSync(getState: () => SettingsState & SettingsActions): void {
  if (globalSettingsSyncTimer) clearTimeout(globalSettingsSyncTimer)
  globalSettingsSyncTimer = setTimeout(async () => {
    globalSettingsSyncTimer = null
    try {
      const s = getState()
      await saveGlobalSettings({
        advancedMode: s.advancedMode,
        aiProviderMode: s.aiProviderMode,
        ai1Model: s.ai1Model,
        ai2Model: s.ai2Model,
        customAi1BaseUrl: s.customAi1BaseUrl,
        customAi1Model: s.customAi1Model,
        customAi2BaseUrl: s.customAi2BaseUrl,
        customAi2Model: s.customAi2Model,
        mineruWorkerUrl: s.mineruWorkerUrl,
        extractCoverImage: s.extractCoverImage,
        mineruDebugMode: s.mineruDebugMode,
      })
    } catch (err) {
      console.error('[settings] 保存非敏感设置到 GitHub 失败:', err)
    }
  }, GLOBAL_SETTINGS_SYNC_DEBOUNCE_MS)
}

/** M3.5 默认 AI-1 指令 */
const DEFAULT_AI1_INSTRUCTION =
  '用 2-3 句话简洁忠实地总结上述源材料，保留关键事实。'

export const useSettingsStore = create<SettingsState & SettingsActions>(
  (set, get) => ({
    ...initialState,

    init: async () => {
      // 1. 只从 IndexedDB 恢复敏感凭据（SPEC §2.3：API key/Token 只存 IndexedDB）
      const sensitiveEntries = await Promise.all(
        SENSITIVE_FIELDS.map(async (field) => {
          const raw = await getSetting(SENSITIVE_KEY_MAP[field])
          return [field, deserialize(field, raw)] as const
        }),
      )
      const patch: Partial<SettingsData> = {}
      for (const [field, value] of sensitiveEntries) {
        // @ts-expect-error runtime-safe: field 与 value 一一对应
        patch[field] = value
      }

      // 1.5. 数据清洗：修复历史上被浏览器密码管理器 autofill 污染的字段
      const contamination = detectPatContamination(patch)
      if (contamination.length > 0) {
        for (const field of contamination) {
          // @ts-expect-error 清空受污染的 string 字段
          patch[field] = ''
          await putSetting(SENSITIVE_KEY_MAP[field], '')
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('af:credential-cleaned', {
              detail: { fields: contamination },
            }),
          )
        }
      }

      // 2. 加载模型清单缓存（IndexedDB，TTL 24h）
      const cachedModels = await loadCachedModels()
      const fetchedAt = await loadCachedModelsFetchedAt()

      set({
        ...patch,
        siliconflowModels: cachedModels ?? [],
        siliconflowModelsFetchedAt: fetchedAt,
        isInitialized: true,
      })
    },

    syncFromGitHub: async () => {
      // 从 GitHub 私库 settings/global.md 加载非敏感设置（SPEC §4.8）
      try {
        const loaded = await loadGlobalSettings()
        if (loaded) {
          const patch: Partial<SettingsData> = {}
          if (loaded.advancedMode !== undefined) patch.advancedMode = loaded.advancedMode
          if (loaded.aiProviderMode !== undefined) patch.aiProviderMode = loaded.aiProviderMode as 'siliconflow' | 'custom'
          if (loaded.ai1Model !== undefined) patch.ai1Model = loaded.ai1Model
          if (loaded.ai2Model !== undefined) patch.ai2Model = loaded.ai2Model
          if (loaded.customAi1BaseUrl !== undefined) patch.customAi1BaseUrl = loaded.customAi1BaseUrl
          if (loaded.customAi1Model !== undefined) patch.customAi1Model = loaded.customAi1Model
          if (loaded.customAi2BaseUrl !== undefined) patch.customAi2BaseUrl = loaded.customAi2BaseUrl
          if (loaded.customAi2Model !== undefined) patch.customAi2Model = loaded.customAi2Model
          if (loaded.mineruWorkerUrl !== undefined) patch.mineruWorkerUrl = loaded.mineruWorkerUrl
          if (loaded.extractCoverImage !== undefined) patch.extractCoverImage = loaded.extractCoverImage
          if (loaded.mineruDebugMode !== undefined) patch.mineruDebugMode = loaded.mineruDebugMode
          set(patch)
        }
      } catch (err) {
        console.warn('[settings] 从 GitHub 同步非敏感设置失败，使用默认值:', err)
      }
    },

    updateSettings: async (patch) => {
      set(patch)

      // 敏感字段 → IndexedDB（立即写）
      const sensitivePatches = (Object.keys(patch) as (keyof SettingsData)[]).filter(
        (field) => SENSITIVE_FIELDS.includes(field),
      )
      if (sensitivePatches.length > 0) {
        await Promise.all(
          sensitivePatches.map((field) =>
            putSetting(SENSITIVE_KEY_MAP[field], serialize(field, patch[field])),
          ),
        )
      }

      // 非敏感字段 → 防抖写 GitHub global.md
      const nonSensitivePatches = (Object.keys(patch) as (keyof SettingsData)[]).filter(
        (field) => !SENSITIVE_FIELDS.includes(field),
      )
      if (nonSensitivePatches.length > 0) {
        scheduleGlobalSettingsSync(get)
      }
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

    getDualEngineConfig: () => {
      const state = get()
      if (state.aiProviderMode === 'custom' && state.advancedMode) {
        const ai1BaseUrl = state.customAi1BaseUrl.trim()
        const ai1ApiKey = state.customAi1ApiKey.trim()
        const ai1Model = state.customAi1Model.trim()
        const ai2BaseUrl = state.customAi2BaseUrl.trim()
        const ai2ApiKey = state.customAi2ApiKey.trim()
        const ai2Model = state.customAi2Model.trim()
        if (!ai1BaseUrl || !ai1ApiKey || !ai1Model) {
          throw new Error('高级模式下 AI-1 端点/Key/模型均需填写')
        }
        if (!ai2BaseUrl || !ai2ApiKey || !ai2Model) {
          throw new Error('高级模式下 AI-2 端点/Key/模型均需填写')
        }
        return {
          ai1: { baseUrl: ai1BaseUrl, apiKey: ai1ApiKey, model: ai1Model },
          ai2: { baseUrl: ai2BaseUrl, apiKey: ai2ApiKey, model: ai2Model },
        }
      }
      const apiKey = state.siliconflowApiKey.trim()
      if (!apiKey) throw new Error('请先填写硅基流动 API Key')
      return {
        ai1: { baseUrl: SILICONFLOW_BASE_URL, apiKey, model: state.ai1Model },
        ai2: { baseUrl: SILICONFLOW_BASE_URL, apiKey, model: state.ai2Model },
      }
    },

    runFactCheckTest: async (
      sourceMaterial,
      ai1Instruction = DEFAULT_AI1_INSTRUCTION,
      onProgress,
    ) => {
      const state = get()
      if (state.isRunningDualEngine) {
        throw new Error('双引擎测试正在运行中，请等待完成')
      }

      const { ai1, ai2 } = get().getDualEngineConfig()

      set({ isRunningDualEngine: true, error: null })
      try {
        const result = await runDualEngine({
          taskType: 'faithfulness_check',
          sourceMaterial,
          ai1Instruction,
          ai1,
          ai2,
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

      // 敏感字段 → IndexedDB
      await Promise.all(
        SENSITIVE_FIELDS.map((field) =>
          putSetting(SENSITIVE_KEY_MAP[field], serialize(field, merged[field])),
        ),
      )

      // 非敏感字段 → GitHub global.md
      try {
        await saveGlobalSettings({
          advancedMode: merged.advancedMode,
          aiProviderMode: merged.aiProviderMode,
          ai1Model: merged.ai1Model,
          ai2Model: merged.ai2Model,
          customAi1BaseUrl: merged.customAi1BaseUrl,
          customAi1Model: merged.customAi1Model,
          customAi2BaseUrl: merged.customAi2BaseUrl,
          customAi2Model: merged.customAi2Model,
          mineruWorkerUrl: merged.mineruWorkerUrl,
          extractCoverImage: merged.extractCoverImage,
          mineruDebugMode: merged.mineruDebugMode,
        })
      } catch (err) {
        console.error('[settings] 重置后保存到 GitHub 失败:', err)
      }
    },
  }),
)
