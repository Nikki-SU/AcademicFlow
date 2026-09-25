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
import type { AIProviderMode, AIThinkingMode, AISlotThinking } from "../types"
import { AI_THINKING_MODES, AI_SLOT_THINKING_MODES } from '../types'
import { runDualEngine } from '../services/ai/dual-engine'
import { MODELS_CACHE_TTL_MS } from '../services/ai/models'
import { getSetting, putSetting, SETTING_KEYS } from '../services/db'
import { loadGlobalSettings, saveGlobalSettings } from '../services/globalSettings'
import { dispatchAiCall } from '../services/workflowClient'
import { readRepoTextFile } from '../services/github'
import { useAuthStore } from './auth'
import { useWorkspaceStore } from './workspace'
import type {
  AIModel,
  AISlotConfig,
  DualEngineProgressCallback,
  DualEngineResult,
  SettingsData,
  SettingsState,
} from '../types'
import { AI_PROVIDERS } from '../types'

/** 合法 provider 值（由 AI_PROVIDERS 的 key 派生，避免两处不同步） */
const VALID_PROVIDER_MODES = Object.keys(AI_PROVIDERS) as AIProviderMode[]

/** provider 值归一化：只认合法值，历史/非法值（如 siliconflow）一律回退 fallback。
 *  与 normalizeThinking 同风格 —— 反序列化 / global.md 手改坏后都靠它兜底。 */
function normalizeProviderMode(
  raw: string | null | undefined,
  fallback: AIProviderMode,
): AIProviderMode {
  return raw && (VALID_PROVIDER_MODES as readonly string[]).includes(raw)
    ? (raw as AIProviderMode)
    : fallback
}

/** 模型清单归属 provider 归一化：历史 provider → ''（清单不属于任何 provider） */
function normalizeModelsProvider(raw: string | null | undefined): AIProviderMode | '' {
  return raw && (VALID_PROVIDER_MODES as readonly string[]).includes(raw)
    ? (raw as AIProviderMode)
    : ''
}

/** 根据 provider mode + store 状态拿到对应的 apiKey 字段值 */
function getProviderApiKey(mode: keyof typeof AI_PROVIDERS, s: SettingsData): string {
  switch (mode) {
    case 'deepseek': return s.deepseekApiKey.trim()
    default: return ''
  }
}

/** SPEC v0.3 §7.3 默认值 */
const DEFAULT_SETTINGS: SettingsData = {
  advancedMode: false,
  aiProviderMode: 'deepseek',
  deepseekApiKey: '',
  // 2026-09 实测：deepseek-chat 已从 DeepSeek 官方 API 下线，默认改为现役的 deepseek-flash
  ai1Model: 'deepseek-flash',
  ai2Model: 'deepseek-flash',
  ai2ProviderMode: 'deepseek',
  deepseekApiKey2: '',
  customAi1BaseUrl: '',
  customAi1ApiKey: '',
  customAi1Model: '',
  customAi2BaseUrl: '',
  customAi2ApiKey: '',
  customAi2Model: '',
  mineruToken: '',
  simpletexToken: '',
  simpletexSecret: '',
  extractCoverImage: true,
  autoExtractWords: false,
  mineruDebugMode: true,
  wordGenCount: 15,
  sentenceGenCount: 8,
  /** 写代码块默认用 Python —— 这个项目的主要用户是科研场景 */
  defaultCodeLang: 'python',
  // 思考模式默认：四个阶段全部关掉（输出预算全给正文，且省钱）。
  // 用户仍可在设置里逐阶段手动开启并调强度 —— 默认值只决定"没动过时"的行为。
  thinkingClean: 'off',
  thinkingTag: 'off',
  thinkingTranslate: 'off',
  thinkingWords: 'off',
  // 槽位级默认「不干预」：交互式调用（问 AI / 双引擎 / 联网检索）以前就没发过
  // thinking 字段，默认值必须是「什么都不发」，否则等于替用户改了一次行为。
  thinkingAi1: '',
  thinkingAi2: '',
}

/** 敏感字段（只存 IndexedDB，不进 GitHub md 文件）—— SPEC §2.3/§4.8 */
const SENSITIVE_FIELDS: (keyof SettingsData)[] = [
  'deepseekApiKey',
  'customAi1ApiKey',
  'customAi2ApiKey',
  'deepseekApiKey2',
  'mineruToken',
  'simpletexToken',
  'simpletexSecret',
]

/** 非敏感字段也存 IndexedDB 做本地备份
 *  —— 没登录 GitHub / GitHub API 挂了也不丢，
 *     syncFromGitHub 成功后会被覆盖（GitHub 是跨设备主存储） */
const NON_SENSITIVE_LOCAL_BACKUP: { field: keyof SettingsData; key: string }[] = [
  { field: 'extractCoverImage', key: SETTING_KEYS.EXTRACT_COVER_IMAGE },
  { field: 'autoExtractWords', key: SETTING_KEYS.AUTO_EXTRACT_WORDS },
  { field: 'mineruDebugMode', key: SETTING_KEYS.MINERU_DEBUG_MODE },
  { field: 'wordGenCount', key: SETTING_KEYS.WORD_GEN_COUNT },
  { field: 'sentenceGenCount', key: SETTING_KEYS.SENTENCE_GEN_COUNT },
  { field: 'defaultCodeLang', key: SETTING_KEYS.DEFAULT_CODE_LANG },
  { field: 'ai2ProviderMode', key: SETTING_KEYS.AI_2_PROVIDER_MODE },
  { field: 'thinkingClean', key: SETTING_KEYS.THINKING_CLEAN },
  { field: 'thinkingTag', key: SETTING_KEYS.THINKING_TAG },
  { field: 'thinkingTranslate', key: SETTING_KEYS.THINKING_TRANSLATE },
  { field: 'thinkingWords', key: SETTING_KEYS.THINKING_WORDS },
  { field: 'thinkingAi1', key: SETTING_KEYS.THINKING_AI_1 },
  { field: 'thinkingAi2', key: SETTING_KEYS.THINKING_AI_2 },
]

/** 思考模式字段（pipeline 阶段）—— 校验时复用同一套合法值 */
const THINKING_FIELDS = [
  'thinkingClean',
  'thinkingTag',
  'thinkingTranslate',
  'thinkingWords',
] as const

/** 槽位级思考字段 —— 合法值多一个 ''（不干预） */
const SLOT_THINKING_FIELDS = ['thinkingAi1', 'thinkingAi2'] as const

/** 敏感字段 → IndexedDB SETTING_KEYS 映射 */
const SENSITIVE_KEY_MAP: Record<string, string> = {
  deepseekApiKey: SETTING_KEYS.DEEPSEEK_API_KEY,
  customAi1ApiKey: SETTING_KEYS.CUSTOM_AI_1_API_KEY,
  customAi2ApiKey: SETTING_KEYS.CUSTOM_AI_2_API_KEY,
  deepseekApiKey2: SETTING_KEYS.DEEPSEEK_API_KEY_2,
  mineruToken: SETTING_KEYS.MINERU_TOKEN,
  simpletexToken: SETTING_KEYS.SIMPLETEX_TOKEN,
  simpletexSecret: SETTING_KEYS.SIMPLETEX_SECRET,
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
  if (key === 'aiProviderMode' || key === 'ai2ProviderMode') {
    // 只接受合法 provider 名，历史值（已下线 provider 等）回退到 deepseek
    return normalizeProviderMode(raw, 'deepseek') as SettingsData[typeof key]
  }
  if ((THINKING_FIELDS as readonly string[]).includes(key)) {
    const ok = (AI_THINKING_MODES as readonly string[]).includes(raw ?? '')
    return (ok ? raw : DEFAULT_SETTINGS[key]) as SettingsData[typeof key]
  }
  if ((SLOT_THINKING_FIELDS as readonly string[]).includes(key)) {
    const ok = (AI_SLOT_THINKING_MODES as readonly string[]).includes(raw ?? '')
    return (ok ? raw : DEFAULT_SETTINGS[key]) as SettingsData[typeof key]
  }
  return raw as SettingsData[typeof key]
}

/** 思考模式值校验：非法值回退到 fallback（global.md 可能被手改坏） */
function normalizeThinking(raw: string, fallback: AIThinkingMode): AIThinkingMode {
  return (AI_THINKING_MODES as readonly string[]).includes(raw)
    ? (raw as AIThinkingMode)
    : fallback
}

/** 槽位级思考值校验：同 normalizeThinking，但 ''（不干预）也是合法值 */
function normalizeSlotThinking(raw: string, fallback: AISlotThinking): AISlotThinking {
  return (AI_SLOT_THINKING_MODES as readonly string[]).includes(raw)
    ? (raw as AISlotThinking)
    : fallback
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
    'customAi1ApiKey',
    'customAi2ApiKey',
    'deepseekApiKey2',
    'mineruToken',
    'simpletexToken',
    'simpletexSecret',
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
  /** 按 AI 槽位拉取该槽位 provider 的 /v1/models 真实清单（runner 代拉；
   *  slot=1 用 AI-1 位配置，slot=2 用 AI-2 位配置，两端对称） */
  refreshModels: (slot: 1 | 2, force?: boolean) => Promise<AIModel[]>
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
    ai1: AISlotConfig
    ai2: AISlotConfig
  }
  /** 清空错误提示 */
  clearError: () => void
  /** 重置为默认值（保留 API keys 不清，避免误伤） */
  resetToDefaults: () => Promise<void>
}

const initialState: SettingsState = {
  ...DEFAULT_SETTINGS,
  isInitialized: false,
  slot1Models: [],
  slot1ModelsProvider: '',
  slot1ModelsFetchedAt: null,
  isLoadingSlot1Models: false,
  slot2Models: [],
  slot2ModelsProvider: '',
  slot2ModelsFetchedAt: null,
  isLoadingSlot2Models: false,
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
        ai2ProviderMode: s.ai2ProviderMode,
        customAi1BaseUrl: s.customAi1BaseUrl,
        customAi1Model: s.customAi1Model,
        customAi2BaseUrl: s.customAi2BaseUrl,
        customAi2Model: s.customAi2Model,
        extractCoverImage: s.extractCoverImage,
        autoExtractWords: s.autoExtractWords,
        mineruDebugMode: s.mineruDebugMode,
        wordGenCount: s.wordGenCount,
        sentenceGenCount: s.sentenceGenCount,
        defaultCodeLang: s.defaultCodeLang,
        thinkingClean: s.thinkingClean,
        thinkingTag: s.thinkingTag,
        thinkingTranslate: s.thinkingTranslate,
        thinkingWords: s.thinkingWords,
        thinkingAi1: s.thinkingAi1,
        thinkingAi2: s.thinkingAi2,
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

      // 2. 模型拉取清单初始为空（AI-1 / AI-2 两个槽位对称）；
      //    下拉的静态推荐清单由 AI_PROVIDERS 常量直接提供，
      //    真实清单由用户在设置页各槽位点「拉取」触发 runner 代拉
      set({
        ...patch,
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
            // 合法值原样，历史/非法值（如 siliconflow）回退 deepseek
            patch.aiProviderMode = normalizeProviderMode(loaded.aiProviderMode, 'deepseek')
          }
          // model 一致性校验：残留的别家模型名回退该家默认，
          // 但从拉取清单选的非推荐模型不误杀（推荐清单 ∪ 该槽位拉取清单）
          if (loaded.ai1Model !== undefined) {
            const m1: AIProviderMode = (patch.aiProviderMode ?? get().aiProviderMode) as AIProviderMode
            const cfg1 = AI_PROVIDERS[m1]
            const ok1 = m1 === 'custom'
              || cfg1.recommendedModels.some((m) => m.id === loaded.ai1Model)
              || get().slot1Models.some((m) => m.id === loaded.ai1Model)
            patch.ai1Model = ok1 ? loaded.ai1Model : (cfg1.defaultModel1 || loaded.ai1Model)
          }
          if (loaded.ai2Model !== undefined) {
            const m2: AIProviderMode = (patch.ai2ProviderMode ?? get().ai2ProviderMode) as AIProviderMode
            const cfg2 = AI_PROVIDERS[m2]
            const ok2 = m2 === 'custom'
              || cfg2.recommendedModels.some((m) => m.id === loaded.ai2Model)
              || get().slot2Models.some((m) => m.id === loaded.ai2Model)
            patch.ai2Model = ok2 ? loaded.ai2Model : (cfg2.defaultModel2 || loaded.ai2Model)
          }
          if (loaded.ai2ProviderMode !== undefined) {
            patch.ai2ProviderMode = normalizeProviderMode(loaded.ai2ProviderMode, 'deepseek')
          }
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
          if (loaded.sentenceGenCount !== undefined) {
            const n = Number(loaded.sentenceGenCount)
            if (!isNaN(n)) patch.sentenceGenCount = Math.min(30, Math.max(3, Math.floor(n)))
          }
          if (loaded.defaultCodeLang !== undefined) {
            patch.defaultCodeLang = String(loaded.defaultCodeLang)
          }
          // 思考模式：非法值回退默认，避免手改坏 global.md 后 runner 收到脏参数
          if (loaded.thinkingClean !== undefined) patch.thinkingClean = normalizeThinking(loaded.thinkingClean, DEFAULT_SETTINGS.thinkingClean)
          if (loaded.thinkingTag !== undefined) patch.thinkingTag = normalizeThinking(loaded.thinkingTag, DEFAULT_SETTINGS.thinkingTag)
          if (loaded.thinkingTranslate !== undefined) patch.thinkingTranslate = normalizeThinking(loaded.thinkingTranslate, DEFAULT_SETTINGS.thinkingTranslate)
          if (loaded.thinkingWords !== undefined) patch.thinkingWords = normalizeThinking(loaded.thinkingWords, DEFAULT_SETTINGS.thinkingWords)
          // 槽位级推理模式：''（不干预）是合法值，不能用 truthy 判断跳过
          if (loaded.thinkingAi1 !== undefined) patch.thinkingAi1 = normalizeSlotThinking(loaded.thinkingAi1, DEFAULT_SETTINGS.thinkingAi1)
          if (loaded.thinkingAi2 !== undefined) patch.thinkingAi2 = normalizeSlotThinking(loaded.thinkingAi2, DEFAULT_SETTINGS.thinkingAi2)
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

    refreshModels: async (slot: 1 | 2, force = false) => {
      const state = get()

      // ── 解析该槽位的 baseUrl + apiKey（与 getDualEngineConfig 对称一致） ──
      let baseUrl: string
      let apiKey: string
      let mode: AIProviderMode
      if (slot === 1) {
        mode = state.aiProviderMode
        if (mode === 'custom') {
          baseUrl = state.customAi1BaseUrl.trim()
          apiKey = state.customAi1ApiKey.trim()
        } else {
          baseUrl = AI_PROVIDERS[mode].baseUrl
          apiKey = getProviderApiKey(mode, state)
        }
      } else {
        mode = state.ai2ProviderMode
        if (mode === 'custom') {
          baseUrl = state.customAi2BaseUrl.trim()
          apiKey = state.customAi2ApiKey.trim()
        } else {
          baseUrl = AI_PROVIDERS[mode].baseUrl
          // AI-2 位 key：独立槽位优先；同家留空沿用 AI-1 位 key
          const key2 = state.deepseekApiKey2.trim()
          apiKey = key2 || (mode === state.aiProviderMode ? getProviderApiKey(mode, state) : '')
        }
      }

      // ── 缓存检查（TTL 24h，与 SPEC §9.3 对齐） ──
      const cachedModels = slot === 1 ? state.slot1Models : state.slot2Models
      const cachedAt = slot === 1 ? state.slot1ModelsFetchedAt : state.slot2ModelsFetchedAt
      if (
        !force &&
        cachedAt &&
        Date.now() - cachedAt < MODELS_CACHE_TTL_MS &&
        cachedModels.length > 0
      ) {
        return cachedModels
      }

      if (!baseUrl || !apiKey) {
        if (slot === 1) {
          throw new Error(`请先填写 AI-1 位的 ${AI_PROVIDERS[state.aiProviderMode].label} API Key`)
        }
        throw new Error(
          mode === state.aiProviderMode
            ? `请先填写 AI-2 位的 ${AI_PROVIDERS[mode].label} API Key（或 AI-1 位的 key）`
            : `请先填写 AI-2 位的 ${AI_PROVIDERS[mode].label} API Key`,
        )
      }

      // ── 后端上下文 ──
      const auth = useAuthStore.getState()
      const ws = useWorkspaceStore.getState()
      const owner = auth.user?.login ?? ''
      const repo = ws.repo?.name ?? ''
      const token = auth.token ?? ''
      if (!token || !owner || !repo) {
        // 未登录 → 空列表，不给静态猜测
        // 理由：静态列表可能过时、可能跟用户实际选的 provider 不匹配，
        // 调到不存在的模型一定报错。登录后 runner 拉真实清单才有意义。
        if (slot === 1) {
          set({ slot1Models: [], slot1ModelsFetchedAt: null, error: null })
        } else {
          set({ slot2Models: [], slot2ModelsFetchedAt: null, error: null })
        }
        return []
      }

      set(
        slot === 1
          ? { isLoadingSlot1Models: true, error: null }
          : { isLoadingSlot2Models: true, error: null },
      )

      // ── dispatch list_models 到 runner ──
      const ts = Date.now()
      const rand = Math.random().toString(36).slice(2, 8)
      const outputPath = `temp/ai/models/slot${slot}_models_${ts}_${rand}.json`
      const taskId = `list_models_s${slot}_${rand}`

      try {
        await dispatchAiCall(
          taskId, 'list_models',
          { baseUrl, apiKey },
          outputPath, 1,
          owner, repo, token,
        )
      } catch (e: any) {
        set(
          slot === 1
            ? { isLoadingSlot1Models: false, error: `触发后端拉模型失败: ${e?.message || e}` }
            : { isLoadingSlot2Models: false, error: `触发后端拉模型失败: ${e?.message || e}` },
        )
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

      set(
        slot === 1
          ? { isLoadingSlot1Models: false }
          : { isLoadingSlot2Models: false },
      )

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

      set(
        slot === 1
          ? { slot1Models: models, slot1ModelsProvider: normalizeModelsProvider(mode), slot1ModelsFetchedAt: Date.now(), error: null }
          : { slot2Models: models, slot2ModelsProvider: normalizeModelsProvider(mode), slot2ModelsFetchedAt: Date.now(), error: null },
      )
      return models
    },

    /** AI-1 / AI-2 两端完全对称解析：各自 provider + 各自槽位 key + 各自模型。
     *  与 repoSecrets → runner secrets 逻辑保持一致。 */
    getDualEngineConfig: () => {
      const state = get()

      // ── AI-1（生成位）──
      let ai1: AISlotConfig
      if (state.aiProviderMode === 'custom') {
        const baseUrl = state.customAi1BaseUrl.trim()
        const apiKey = state.customAi1ApiKey.trim()
        const model = state.customAi1Model.trim()
        if (!baseUrl || !apiKey || !model) {
          throw new Error('AI-1 自定义端点：Base URL / Key / 模型均需填写')
        }
        ai1 = { baseUrl, apiKey, model }
      } else {
        const cfg = AI_PROVIDERS[state.aiProviderMode]
        const apiKey = getProviderApiKey(state.aiProviderMode, state)
        if (!apiKey) {
          throw new Error(`请先填写 AI-1 位的 ${cfg.label} API Key`)
        }
        ai1 = {
          baseUrl: cfg.baseUrl,
          apiKey,
          // 模型必须属于本 provider：推荐清单 ∪ AI-1 槽位拉取清单；
          // 都没有（历史残留的别家模型名）→ 回退默认
          model: cfg.recommendedModels.some((m) => m.id === state.ai1Model)
            || state.slot1Models.some((m) => m.id === state.ai1Model)
            ? state.ai1Model
            : cfg.defaultModel1,
        }
      }

      // ── AI-2（审阅位）：与 AI-1 完全对称 ──
      let ai2: AISlotConfig
      if (state.ai2ProviderMode === 'custom') {
        const baseUrl = state.customAi2BaseUrl.trim()
        const apiKey = state.customAi2ApiKey.trim()
        const model = state.customAi2Model.trim()
        if (!baseUrl || !apiKey || !model) {
          throw new Error('AI-2 自定义端点：Base URL / Key / 模型均需填写')
        }
        ai2 = { baseUrl, apiKey, model }
      } else {
        const cfg2 = AI_PROVIDERS[state.ai2ProviderMode]
        // AI-2 位 key 按公司独立槽位，与 AI-1 位平等；
        // 同公司且 AI-2 位留空 → 沿用 AI-1 位 key（同 key 双模型的平滑默认）
        const key2Raw = state.deepseekApiKey2.trim()
        const apiKey2 = key2Raw || (state.ai2ProviderMode === state.aiProviderMode ? ai1.apiKey : '')
        if (!apiKey2) {
          throw new Error(`请先填写 AI-2 位的 ${cfg2.label} API Key`)
        }
        ai2 = {
          baseUrl: cfg2.baseUrl,
          apiKey: apiKey2,
          model: cfg2.recommendedModels.some((m) => m.id === state.ai2Model)
            || state.slot2Models.some((m) => m.id === state.ai2Model)
            ? state.ai2Model
            : cfg2.defaultModel2,
        }
      }

      // 推理模式：'' = 不干预 → 不挂 thinking 字段，后端就不会往请求体里拼，
      // 行为和加这个开关之前完全一致。只有用户明确选了 off/low/high/max 才生效。
      if (state.thinkingAi1) ai1.thinking = state.thinkingAi1
      if (state.thinkingAi2) ai2.thinking = state.thinkingAi2

      return { ai1, ai2 }
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
        customAi1ApiKey: get().customAi1ApiKey,
        customAi2ApiKey: get().customAi2ApiKey,
        deepseekApiKey2: get().deepseekApiKey2,
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
          ai2ProviderMode: merged.ai2ProviderMode,
          customAi1BaseUrl: merged.customAi1BaseUrl,
          customAi1Model: merged.customAi1Model,
          customAi2BaseUrl: merged.customAi2BaseUrl,
          customAi2Model: merged.customAi2Model,
          extractCoverImage: merged.extractCoverImage,
          autoExtractWords: merged.autoExtractWords,
          mineruDebugMode: merged.mineruDebugMode,
          wordGenCount: merged.wordGenCount,
          sentenceGenCount: merged.sentenceGenCount,
          defaultCodeLang: merged.defaultCodeLang,
          thinkingClean: merged.thinkingClean,
          thinkingTag: merged.thinkingTag,
          thinkingTranslate: merged.thinkingTranslate,
          thinkingWords: merged.thinkingWords,
          thinkingAi1: merged.thinkingAi1,
          thinkingAi2: merged.thinkingAi2,
        })
      } catch (err) {
        console.error('[settings] 重置后保存到 GitHub 失败:', err)
      }
    },
  }),
)
