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
import type { AIProviderMode } from "../types"
import { runDualEngine } from '../services/ai/dual-engine'
import { MODELS_CACHE_TTL_MS } from '../services/ai/models'
import { getSetting, putSetting, SETTING_KEYS } from '../services/db'
import { loadGlobalSettings, saveGlobalSettings } from '../services/globalSettings'
import { dispatchAi } from '../services/workflowClient'
import { readRepoTextFile } from '../services/github'
import { useAuthStore } from './auth'
import { useWorkspaceStore } from './workspace'
import type {
  AIModel,
  DualEngineProgressCallback,
  DualEngineResult,
  SettingsData,
  SettingsState,
} from '../types'
import { AI_PROVIDERS } from '../types'

/** 根据 provider 拿到对应的 baseUrl */
function getProviderBaseUrl(mode: keyof typeof AI_PROVIDERS): string {
  return AI_PROVIDERS[mode].baseUrl
}

/** 根据 provider mode + store 状态拿到对应的 apiKey 字段值 */
function getProviderApiKey(mode: keyof typeof AI_PROVIDERS, s: SettingsData): string {
  switch (mode) {
    case 'deepseek': return s.deepseekApiKey.trim()
    case 'kimi': return s.kimiApiKey.trim()
    case 'qiniu': return s.qiniuApiKey.trim()
    default: return ''
  }
}

/** SPEC v0.3 §7.3 默认值 */
const DEFAULT_SETTINGS: SettingsData = {
  advancedMode: false,
  aiProviderMode: 'deepseek',
  deepseekApiKey: '',
  kimiApiKey: '',
  qiniuApiKey: '',
  ai1Model: 'deepseek-chat',
  ai2Model: 'deepseek-chat',
  customAi1BaseUrl: '',
  customAi1ApiKey: '',
  customAi1Model: '',
  customAi2BaseUrl: '',
  customAi2ApiKey: '',
  customAi2Model: '',
  mineruToken: '',
  extractCoverImage: true,
  autoExtractWords: false,
  mineruDebugMode: true,
  wordGenCount: 15,
}

/** 敏感字段（只存 IndexedDB，不进 GitHub md 文件）—— SPEC §2.3/§4.8 */
const SENSITIVE_FIELDS: (keyof SettingsData)[] = [
  'deepseekApiKey',
  'kimiApiKey',
  'qiniuApiKey',
  'customAi1ApiKey',
  'customAi2ApiKey',
  'mineruToken',
]

/** 非敏感字段也存 IndexedDB 做本地备份
 *  —— 没登录 GitHub / GitHub API 挂了也不丢，
 *     syncFromGitHub 成功后会被覆盖（GitHub 是跨设备主存储） */
const NON_SENSITIVE_LOCAL_BACKUP: { field: keyof SettingsData; key: string }[] = [
  { field: 'extractCoverImage', key: SETTING_KEYS.EXTRACT_COVER_IMAGE },
  { field: 'autoExtractWords', key: SETTING_KEYS.AUTO_EXTRACT_WORDS },
  { field: 'mineruDebugMode', key: SETTING_KEYS.MINERU_DEBUG_MODE },
  { field: 'wordGenCount', key: SETTING_KEYS.WORD_GEN_COUNT },
]

/** 敏感字段 → IndexedDB SETTING_KEYS 映射 */
const SENSITIVE_KEY_MAP: Record<string, string> = {
  deepseekApiKey: SETTING_KEYS.DEEPSEEK_API_KEY,
  kimiApiKey: SETTING_KEYS.KIMI_API_KEY,
  qiniuApiKey: SETTING_KEYS.QINIU_API_KEY,
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
    // 只接受合法 provider 名，否则 fallback 到 deepseek
    const valid = ['deepseek', 'kimi', 'qiniu', 'custom'] as const
    const ok = (valid as readonly string[]).includes(raw ?? '')
    return (ok ? raw : 'deepseek') as SettingsData[typeof key]
  }
  return raw as SettingsData[typeof key]
}

/**
 * 检测受污染的 secret 字段
 * -------------------------------------------------
 * 场景：Chrome/Edge 密码管理器保存了 Login 页的 GitHub PAT (ghp_/github_pat_/gho_/ghu_)，
 * 之后 autofill 到 Settings 页的 AI Key / MinerU Token 字段。
 * 检测规则：这些字段绝不可能以 GitHub token 前缀开头。
 */
function detectPatContamination(
  patch: Partial<SettingsData>,
): (keyof SettingsData)[] {
  const secretFields: (keyof SettingsData)[] = [
    'deepseekApiKey',
    'kimiApiKey',
    'qiniuApiKey',
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
        extractCoverImage: s.extractCoverImage,
        autoExtractWords: s.autoExtractWords,
        mineruDebugMode: s.mineruDebugMode,
        wordGenCount: s.wordGenCount,
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

      // 2. 模型清单直接从 AI_PROVIDERS 静态常量拿（不再前端 fetch）
      const defaultMode: AIProviderMode = 'deepseek'
      const defaultModels: AIModel[] = AI_PROVIDERS[defaultMode].recommendedModels.map(
        (m) => ({ id: m.id, object: 'model', owned_by: defaultMode }),
      )

      set({
        ...patch,
        siliconflowModels: defaultModels,
        siliconflowModelsFetchedAt: Date.now(),
        isInitialized: true,
      })

      // 3. 非敏感字段从 IndexedDB 本地备份恢复（没登录 GitHub 也不丢）
      //    syncFromGitHub 成功后会覆盖这些值（GitHub 是跨设备主存储）
      const localBackupPatch: Partial<SettingsData> = {}
      for (const { field, key } of NON_SENSITIVE_LOCAL_BACKUP) {
        const raw = await getSetting(key)
        if (raw !== null && raw !== '') {
          // @ts-expect-error runtime-safe
          localBackupPatch[field] = deserialize(field, raw)
        }
      }
      if (Object.keys(localBackupPatch).length > 0) {
        set(localBackupPatch)
      }
    },

    syncFromGitHub: async () => {
      // 从 GitHub 私库 settings/global.md 加载非敏感设置（SPEC §4.8）
      try {
        const loaded = await loadGlobalSettings()
        if (loaded) {
          const patch: Partial<SettingsData> = {}
          if (loaded.advancedMode !== undefined) patch.advancedMode = loaded.advancedMode
          if (loaded.aiProviderMode !== undefined) {
            const valid = ['deepseek', 'kimi', 'qiniu', 'custom'] as const
            const raw = loaded.aiProviderMode
            // 兼容历史值 siliconflow → deepseek
            const migrated = raw === 'siliconflow' ? 'deepseek' : raw
            patch.aiProviderMode = (valid.includes(migrated as any) ? migrated : 'deepseek') as SettingsData['aiProviderMode']
          }
          if (loaded.ai1Model !== undefined) patch.ai1Model = loaded.ai1Model
          if (loaded.ai2Model !== undefined) patch.ai2Model = loaded.ai2Model
          if (loaded.customAi1BaseUrl !== undefined) patch.customAi1BaseUrl = loaded.customAi1BaseUrl
          if (loaded.customAi1Model !== undefined) patch.customAi1Model = loaded.customAi1Model
          if (loaded.customAi2BaseUrl !== undefined) patch.customAi2BaseUrl = loaded.customAi2BaseUrl
          if (loaded.customAi2Model !== undefined) patch.customAi2Model = loaded.customAi2Model
          if (loaded.extractCoverImage !== undefined) patch.extractCoverImage = loaded.extractCoverImage
          if (loaded.autoExtractWords !== undefined) patch.autoExtractWords = loaded.autoExtractWords
          if (loaded.mineruDebugMode !== undefined) patch.mineruDebugMode = loaded.mineruDebugMode
          if (loaded.wordGenCount !== undefined) {
            const n = Number(loaded.wordGenCount)
            if (!isNaN(n)) patch.wordGenCount = Math.min(50, Math.max(10, Math.floor(n)))
          }
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

      // 非敏感字段 → 防抖写 GitHub global.md + 立即写 IndexedDB 做本地备份
      const nonSensitivePatches = (Object.keys(patch) as (keyof SettingsData)[]).filter(
        (field) => !SENSITIVE_FIELDS.includes(field),
      )
      if (nonSensitivePatches.length > 0) {
        // 本地备份：立即写 IndexedDB（没登录 GitHub 也不丢）
        for (const { field, key } of NON_SENSITIVE_LOCAL_BACKUP) {
          if ((nonSensitivePatches as string[]).includes(field)) {
            await putSetting(key, serialize(field, patch[field]))
          }
        }
        // GitHub 主存储：防抖写
        scheduleGlobalSettingsSync(get)
      }
    },

    refreshModels: async (force = false) => {
      const state = get()
      const mode = state.aiProviderMode

      // ── 缓存检查（TTL 24h，与 SPEC §9.3 对齐） ──
      if (
        !force &&
        state.siliconflowModelsFetchedAt &&
        Date.now() - state.siliconflowModelsFetchedAt < MODELS_CACHE_TTL_MS &&
        state.siliconflowModels.length > 0
      ) {
        return state.siliconflowModels
      }

      // ── 解析 baseUrl + apiKey ──
      let baseUrl: string
      let apiKey: string
      if (mode === 'custom') {
        baseUrl = state.customAi1BaseUrl.trim()
        apiKey = state.customAi1ApiKey.trim()
        if (!baseUrl) {
          const empty: AIModel[] = []
          set({ siliconflowModels: empty, siliconflowModelsFetchedAt: Date.now(), error: null })
          return empty
        }
      } else {
        baseUrl = getProviderBaseUrl(mode)
        apiKey = getProviderApiKey(mode, state)
      }

      // ── 后端上下文 ──
      const auth = useAuthStore.getState()
      const ws = useWorkspaceStore.getState()
      const owner = auth.user?.login ?? ''
      const repo = ws.repo?.name ?? ''
      const token = auth.token ?? ''
      if (!token || !owner || !repo) {
        // 未登录 → fallback 静态推荐列表（首次启动还没 dispatch 能力）
        const fallback: AIModel[] = AI_PROVIDERS[mode].recommendedModels.map((m) => ({
          id: m.id, object: 'model', owned_by: mode,
        }))
        set({ siliconflowModels: fallback, siliconflowModelsFetchedAt: Date.now(), error: null })
        return fallback
      }

      set({ isLoadingModels: true, error: null })

      // ── dispatch list_models 到 runner ──
      const ts = Date.now()
      const rand = Math.random().toString(36).slice(2, 8)
      const outputPath = `temp/ai/models/models_${ts}_${rand}.json`
      const taskId = `list_models_${rand}`

      try {
        await dispatchAi(
          taskId, 'list_models',
          { baseUrl, apiKey },
          outputPath, 1,
          owner, repo, token,
        )
      } catch (e: any) {
        set({ isLoadingModels: false, error: `触发后端拉模型失败: ${e?.message || e}` })
        throw e
      }

      // ── 轮询 output_path（3s × 200 = 10min） ──
      let raw: string | null = null
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        try {
          const result = await readRepoTextFile(owner, repo, outputPath, token)
          if (result?.content) { raw = result.content; break }
        } catch { /* 继续等 */ }
      }

      set({ isLoadingModels: false })

      if (!raw) {
        set({ error: '后端拉模型超时（10min 未返回）' })
        throw new Error('后端拉模型超时')
      }

      let parsed: any
      try { parsed = JSON.parse(raw) } catch {
        set({ error: '后端返回的 JSON 无法解析' })
        throw new Error('后端返回的 JSON 无法解析')
      }

      if (parsed.error) {
        set({ error: `后端拉模型失败: ${parsed.error}` })
        throw new Error(parsed.error)
      }

      const models: AIModel[] = (parsed.data || []).map((m: any) => ({
        id: m.id,
        object: m.object || 'model',
        owned_by: m.owned_by || mode,
      }))

      set({
        siliconflowModels: models,
        siliconflowModelsFetchedAt: Date.now(),
        error: null,
      })
      return models
    },

    getDualEngineConfig: () => {
      const state = get()
      const mode = state.aiProviderMode
      if (mode === 'custom') {
        const ai1BaseUrl = state.customAi1BaseUrl.trim()
        const ai1ApiKey = state.customAi1ApiKey.trim()
        const ai1Model = state.customAi1Model.trim()
        const ai2BaseUrl = state.customAi2BaseUrl.trim()
        const ai2ApiKey = state.customAi2ApiKey.trim()
        const ai2Model = state.customAi2Model.trim()
        if (!ai1BaseUrl || !ai1ApiKey || !ai1Model) {
          throw new Error('自定义端点模式下 AI-1 端点/Key/模型均需填写')
        }
        if (!ai2BaseUrl || !ai2ApiKey || !ai2Model) {
          throw new Error('自定义端点模式下 AI-2 端点/Key/模型均需填写')
        }
        return {
          ai1: { baseUrl: ai1BaseUrl, apiKey: ai1ApiKey, model: ai1Model },
          ai2: { baseUrl: ai2BaseUrl, apiKey: ai2ApiKey, model: ai2Model },
        }
      }
      // 预置 provider：deepseek / kimi / qiniu —— 两端共用 baseUrl + apiKey
      const apiKey = getProviderApiKey(mode, state)
      if (!apiKey) {
        throw new Error(`请先填写 ${AI_PROVIDERS[mode].label} API Key`)
      }
      const baseUrl = getProviderBaseUrl(mode)
      return {
        ai1: { baseUrl, apiKey, model: state.ai1Model },
        ai2: { baseUrl, apiKey, model: state.ai2Model },
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
        deepseekApiKey: get().deepseekApiKey,
        kimiApiKey: get().kimiApiKey,
        qiniuApiKey: get().qiniuApiKey,
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

      // 非敏感字段 → IndexedDB 本地备份
      for (const { field, key } of NON_SENSITIVE_LOCAL_BACKUP) {
        await putSetting(key, serialize(field, merged[field]))
      }

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
          extractCoverImage: merged.extractCoverImage,
          autoExtractWords: merged.autoExtractWords,
          mineruDebugMode: merged.mineruDebugMode,
          wordGenCount: merged.wordGenCount,
        })
      } catch (err) {
        console.error('[settings] 重置后保存到 GitHub 失败:', err)
      }
    },
  }),
)
