/**
 * 设置页 —— 左栏大纲（服务 / 数据 / 开发者中心）+ 右栏内容，比例 1:4。
 */
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Brain,
  Check,
  Copy,
  FlaskConical,
  Gauge,
  Loader2,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import APIKeyInput from '../components/settings/APIKeyInput'
import DualEngineTestPanel from '../components/settings/DualEngineTestPanel'
import ConnectivityPanel from '../components/settings/ConnectivityPanel'
import AsrTestPanel from '../components/settings/AsrTestPanel'
import AsrModelPicker, { type ModelPreset } from '../components/settings/AsrModelPicker'
import { PipelineDebugPanel } from '../components/PipelineDebugPanel'
import BackendCapabilitiesPanel from '../components/settings/BackendCapabilitiesPanel'
import PdfCleanupPanel from '../components/settings/PdfCleanupPanel'
import { isChatModel, isAsrModel } from '../services/ai/models'
import { fetchModelIds } from '../services/asr'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { DEFAULT_WORKSPACE_REPO_NAME } from '../constants/skeleton'
import { CODE_LANGS } from '../constants/codeLangs'
import { syncAllSecrets, type SecretItemStatus } from '../services/repoSecrets'
import type { AIProviderMode, AIThinkingMode, AISlotThinking, SettingsData } from '../types'
import { AI_PROVIDERS } from '../types'

/**
 * 槽位级推理模式选项 —— 多一个「不干预」。
 * 「不干预」= 请求体里不带 thinking 字段，沿用模型自己的默认；
 * 「关闭思考」= 明确发 thinking:{type:'disabled'}。
 * 默认值是「关闭思考」（见 DEFAULT_SETTINGS）—— 这两个槽位干的都是格式搬运 / 抽取，
 * 不需要推理，而推理会和正文抢同一个输出预算。
 */
const SLOT_THINKING_OPTIONS: {
  value: AISlotThinking
  label: string
  hint: string
}[] = [
  { value: '', label: '不干预（模型默认）', hint: '不发 thinking 参数' },
  { value: 'off', label: '关闭思考', hint: '输出预算全部留给正文' },
  { value: 'low', label: '开启 · 低强度', hint: 'reasoning_effort=low' },
  { value: 'high', label: '开启 · 高强度', hint: 'reasoning_effort=high' },
  { value: 'max', label: '开启 · 最高强度', hint: 'reasoning_effort=max（最慢最贵）' },
]

/**
 * 「provider × 槽位」→ API Key 存在 SettingsData 的哪个字段。
 *
 * key 按公司独立存：切 provider 只是换字段读写，不会把别家的 key 洗掉
 * （不然切回来还得重填）。custom 的 key 与自己的 baseUrl 配套，不走这张表。
 */
const SLOT_KEY_FIELDS: Record<AIProviderMode, { 1?: keyof SettingsData; 2?: keyof SettingsData }> = {
  deepseek: { 1: 'deepseekApiKey', 2: 'deepseekApiKey2' },
  zhipu: { 1: 'zhipuApiKey', 2: 'zhipuApiKey2' },
  xfyun: { 1: 'xfyunApiKey', 2: 'xfyunApiKey2' },
  'volcengine-coding': { 1: 'volcengineCodingApiKey', 2: 'volcengineCodingApiKey2' },
  'volcengine-agent': { 1: 'volcengineAgentApiKey', 2: 'volcengineAgentApiKey2' },
  openrouter: { 1: 'openrouterApiKey', 2: 'openrouterApiKey2' },
  // 硅基流动与「会议转写」共用同一把 key：两个槽位都指向 asrApiKey
  siliconflow: { 1: 'asrApiKey', 2: 'asrApiKey' },
  custom: {},
}

/** 思考模式下拉选项 —— off 关闭，其余为开启并控制强度 */
const THINKING_OPTIONS: { value: AIThinkingMode; label: string }[] = [
  { value: 'off', label: '关闭思考（推荐）' },
  { value: 'low', label: '开启 · 低强度' },
  { value: 'high', label: '开启 · 高强度' },
  { value: 'max', label: '开启 · 最高强度' },
]

/**
 * 会议转写三个模型下拉的「推荐」预置（官方免费 / 常用）。
 * 不是硬性清单 —— 旁边「拉取清单」会按用户 Key 列出真实可用模型，
 * 预置只是给「没拉取也能直接用」的默认选项，且把快慢差异标注出来。
 */
const ASR_TRANSCRIBE_PRESETS: ModelPreset[] = [
  { value: 'FunAudioLLM/SenseVoiceSmall', label: 'FunAudioLLM/SenseVoiceSmall · 出字快（推荐）' },
  { value: 'TeleAI/TeleSpeechASR', label: 'TeleAI/TeleSpeechASR · 中文准但较慢' },
]
const ASR_TRANSLATE_PRESETS: ModelPreset[] = [
  { value: 'tencent/Hunyuan-MT-7B', label: 'tencent/Hunyuan-MT-7B · 专用翻译（免费）' },
  { value: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen/Qwen2.5-7B-Instruct · 通用（免费）' },
]
const ASR_POLISH_PRESETS: ModelPreset[] = [
  { value: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen/Qwen2.5-7B-Instruct · 通用（免费）' },
]

/** 按阶段的思考模式设置行 */
const THINKING_ROWS: {
  field: 'thinkingClean' | 'thinkingTag' | 'thinkingTranslate' | 'thinkingWords'
  label: string
  desc: string
}[] = [
  { field: 'thinkingClean', label: '清理正文', desc: '去页眉页脚、拼回断段' },
  { field: 'thinkingTag', label: '打标', desc: '判断标题/图注/列表类型' },
  { field: 'thinkingTranslate', label: '翻译', desc: '逐段与表格翻译' },
  { field: 'thinkingWords', label: '提词核验', desc: '筛选学术词汇' },
]

function formatFetchedAt(ts: number | null): string {
  if (!ts) return '未拉取'
  const diffMs = Date.now() - ts
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return new Date(ts).toLocaleString()
}

/** 左栏大纲：三个分组，每组列出可跳转的设置锚点 */
const OUTLINE: { group: string; items: { id: string; label: string; icon: LucideIcon }[] }[] = [
  {
    group: '服务',
    items: [
      { id: 'ai-service', label: 'AI 服务', icon: Sparkles },
      { id: 'lit-service', label: '文献服务', icon: BookOpen },
    ],
  },
  {
    group: '数据',
    items: [
      { id: 'pdf-cleanup', label: '清理 PDF', icon: Trash2 },
      { id: 'backend-rewrite', label: '重写后端', icon: Server },
    ],
  },
  {
    group: '开发者中心',
    items: [
      { id: 'connectivity', label: '连通性检测', icon: Activity },
      { id: 'dual-engine', label: '双引擎试运行', icon: FlaskConical },
      { id: 'secrets-sync', label: 'Secrets 同步', icon: Wrench },
      { id: 'pipeline-debug', label: 'Pipeline 看板', icon: Gauge },
      { id: 'advanced-mode', label: '高级模式', icon: SlidersHorizontal },
    ],
  },
]

/** 右栏分区卡片：带锚点 id 的标题 + 内容 */
function Section(props: {
  id: string
  icon: LucideIcon
  title: string
  badge?: ReactNode
  children: ReactNode
}) {
  const { id, icon: Icon, title, badge, children } = props
  return (
    <section
      id={id}
      className="scroll-mt-14 overflow-hidden rounded-card border border-ink-200 bg-paper-50 shadow-card"
    >
      <div className="af-line-b flex items-center gap-2.5 px-ui-gap-lg py-3">
        <Icon className="h-ui-icon w-ui-icon text-ink-500" strokeWidth={1.75} />
        <h2 className="text-ui-sm font-semibold text-ink-900">{title}</h2>
        {badge && <span className="ml-auto flex items-center">{badge}</span>}
      </div>
      <div className="space-y-ui-gap-lg px-ui-gap-lg py-4">{children}</div>
    </section>
  )
}

/** 分区内的子标题，只留标题 */
function SubHeading(props: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-ui-sm font-semibold text-ink-800">{props.title}</h3>
      {props.children}
    </div>
  )
}

function Settings() {
  const store = useSettingsStore()
  const auth = useAuthStore()
  const ws = useWorkspaceStore()
  const owner = auth.user?.login ?? ''
  const repoName = ws.repo?.name ?? ''
  const {
    isInitialized,
    advancedMode,
    aiProviderMode,
    deepseekApiKey,
    ai1Model,
    ai2Model,
    ai2ProviderMode,
    deepseekApiKey2,
    zhipuApiKey,
    zhipuApiKey2,
    xfyunApiKey,
    xfyunApiKey2,
    volcengineCodingApiKey,
    volcengineCodingApiKey2,
    volcengineAgentApiKey,
    volcengineAgentApiKey2,
    openrouterApiKey,
    openrouterApiKey2,
    customAi1BaseUrl,
    customAi1ApiKey,
    customAi1Model,
    customAi2BaseUrl,
    customAi2ApiKey,
    customAi2Model,
    slot1Models,
    slot1ModelsProvider,
    slot1ModelsFetchedAt,
    isLoadingSlot1Models,
    slot2Models,
    slot2ModelsProvider,
    slot2ModelsFetchedAt,
    isLoadingSlot2Models,
    mineruToken,
    simpletexToken,
    asrApiKey,
    asrBaseUrl,
    asrModel,
    asrTranslateModel,
    asrPolishModel,
    asrTranslateToZh,
    thinkingAi1,
    thinkingAi2,
    updateSettings,
    refreshModels,
    init,
  } = store

  useEffect(() => {
    if (!isInitialized) init()
  }, [isInitialized, init])

  /** 监听 settings store 触发的凭据清洗事件：向用户解释一次为什么 Key 被清空 */
  useEffect(() => {
    const onCleaned = (e: Event) => {
      const detail = (e as CustomEvent<{ fields: string[] }>).detail
      const fieldLabelMap: Record<string, string> = {
        deepseekApiKey: 'DeepSeek API Key',
        customAi1ApiKey: '自定义 AI-1 API Key',
        customAi2ApiKey: '自定义 AI-2 API Key',
        deepseekApiKey2: 'DeepSeek API Key（AI-2 位）',
        zhipuApiKey: '智谱 GLM API Key',
        zhipuApiKey2: '智谱 GLM API Key（AI-2 位）',
        xfyunApiKey: '讯飞星火 API Key',
        xfyunApiKey2: '讯飞星火 API Key（AI-2 位）',
        volcengineCodingApiKey: '火山方舟 Coding Plan API Key',
        volcengineCodingApiKey2: '火山方舟 Coding Plan API Key（AI-2 位）',
        volcengineAgentApiKey: '火山方舟 Agent Plan API Key',
        volcengineAgentApiKey2: '火山方舟 Agent Plan API Key（AI-2 位）',
        openrouterApiKey: 'OpenRouter API Key',
        openrouterApiKey2: 'OpenRouter API Key（AI-2 位）',
        mineruToken: 'MinerU Token',
        simpletexToken: 'SimpleTex 令牌',
        asrApiKey: '硅基流动 API Key',
      }
      const labels = detail.fields.map((f) => fieldLabelMap[f] ?? f).join('、')
      toast.warning(
        `检测到浏览器密码管理器将 GitHub PAT 误填到 ${labels}，已自动清空。请重新填写正确的 Key。`,
        { duration: 8000 },
      )
    }
    window.addEventListener('af:credential-cleaned', onCleaned)
    return () => window.removeEventListener('af:credential-cleaned', onCleaned)
  }, [])

  /** ──── Secrets 自动同步 + 验证（前端 → GitHub Actions Secrets） ────
   *
   *  行为：每次配置变了 → debounce 800ms → syncAllSecrets 把 8 个都 PUT 到 GitHub
   *        → 等 1.5s GitHub 索引 → GET list 回查确认存在
   *        → 每条结果存进 state，UI 一条条亮给用户看（拒绝黑箱）
   *  mount 后自动跑一次（didMountSyncRef 确保只跑一次）
   */
  const secretSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didMountSyncRef = useRef(false)
  const [secretSyncing, setSecretSyncing] = useState(false)
  /** 最近一次 syncAllSecrets 返回的每条 secret 的明细状态 */
  const [secretItems, setSecretItems] = useState<SecretItemStatus[]>([])
  /** 「防休眠」区：本站地址是否刚被复制（1.5s 后复位） */
  const [copiedSite, setCopiedSite] = useState(false)

  /** 一键复制本站地址：粘进浏览器「始终保持活动」例外名单 */
  const handleCopySite = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin)
      setCopiedSite(true)
      setTimeout(() => setCopiedSite(false), 1500)
    } catch {
      toast.error('复制失败，请手动复制地址栏')
    }
  }

  const runSync = async () => {
    if (!owner || !auth.token || !isInitialized) return
    // ──── 硬保险：secrets 只写到固定私库 academicflow-workspace ────
    // 绝对不能用 ws.repo.name，因为 ws.repo.name 在某些初始化阶段可能
    // 暂时是空/主仓库名（导致 secrets 错误写入 AGPL v3 主仓库）。
    const targetRepo = DEFAULT_WORKSPACE_REPO_NAME
    if (ws.repo?.name && ws.repo.name !== targetRepo) {
      // 只有在 ws.repo 已设置但指向其他 repo 时才警告
      toast.error(
        `⚠️ workspace repo 是 ${ws.repo.name}，但 secrets 强制写到私库 ${targetRepo}`
      )
    }
    setSecretSyncing(true)
    console.log(`[syncAllSecrets] target repo (FORCE): ${owner}/${targetRepo}`)
    try {
      const items = await syncAllSecrets(owner, targetRepo, auth.token!, {
        aiProviderMode,
        deepseekApiKey,
        ai1Model,
        ai2Model,
        ai2ProviderMode,
        deepseekApiKey2,
        zhipuApiKey,
        zhipuApiKey2,
        xfyunApiKey,
        xfyunApiKey2,
        volcengineCodingApiKey,
        volcengineCodingApiKey2,
        volcengineAgentApiKey,
        volcengineAgentApiKey2,
        openrouterApiKey,
        openrouterApiKey2,
        customAi1BaseUrl,
        customAi1ApiKey,
        customAi1Model,
        customAi2BaseUrl,
        customAi2ApiKey,
        customAi2Model,
        mineruToken,
        simpletexToken,
        siliconflowApiKey: asrApiKey,
      })
      setSecretItems(items)
      didMountSyncRef.current = true
    } catch (e: any) {
      // 整批炸了 —— 用一条假 error item 顶上，让用户看到
      setSecretItems([{
        name: 'AI1_BASE_URL', putOk: false, putStatus: 0, verified: false,
        valueWanted: '', error: `syncAllSecrets 整体异常: ${e?.message || String(e)}`,
      }])
    } finally {
      setSecretSyncing(false)
    }
  }

  // 用户改值 → debounce 800ms 后 sync
  useEffect(() => {
    if (!owner || !auth.token || !isInitialized) return
    if (secretSyncTimer.current) clearTimeout(secretSyncTimer.current)
    secretSyncTimer.current = setTimeout(runSync, 800)
    return () => { if (secretSyncTimer.current) clearTimeout(secretSyncTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isInitialized, owner, auth.token,
    aiProviderMode, advancedMode,
    deepseekApiKey, ai1Model, ai2Model,
    ai2ProviderMode,
    deepseekApiKey2,
    zhipuApiKey,
    zhipuApiKey2,
    xfyunApiKey,
    xfyunApiKey2,
    volcengineCodingApiKey,
    volcengineCodingApiKey2,
    volcengineAgentApiKey,
    volcengineAgentApiKey2,
    openrouterApiKey,
    openrouterApiKey2,
    customAi1BaseUrl, customAi1ApiKey, customAi1Model,
    customAi2BaseUrl, customAi2ApiKey, customAi2Model,
    mineruToken,
    simpletexToken,
    asrApiKey,
  ])

  // mount 后强制 sync 一次（即便依赖项没变）
  useEffect(() => {
    if (didMountSyncRef.current) return
    if (!isInitialized || !owner || !auth.token) return
    runSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized, owner, auth.token])

  if (!isInitialized) {
    return (
      <div className="flex min-h-full items-center justify-center bg-paper-100">
        <div className="flex items-center gap-3 text-ink-600">
          <Loader2 className="h-5 w-5 animate-spin text-seal-600" />
          <span className="text-ui-sm">正在加载设置…</span>
        </div>
      </div>
    )
  }

  // ── 槽位 key：按「当前 provider × 槽位」读写对应字段（custom 不用此槽位） ──
  const keyField1 = SLOT_KEY_FIELDS[aiProviderMode][1]
  const slot1Key = keyField1 ? (store[keyField1] as string) : ''
  const setSlot1Key = (v: string) => {
    if (keyField1) updateSettings({ [keyField1]: v } as Partial<SettingsData>)
  }

  // ── AI-2 位：与 AI-1 完全对称（key 同样按公司独立存） ──
  const keyField2 = SLOT_KEY_FIELDS[ai2ProviderMode][2]
  const slot2Key = keyField2 ? (store[keyField2] as string) : ''
  const setSlot2Key = (v: string) => {
    if (keyField2) updateSettings({ [keyField2]: v } as Partial<SettingsData>)
  }

  /** 拉取某槽位的真实模型清单（runner 代拉该槽位 provider 的 /v1/models） */
  const handleFetchModels = async (slot: 1 | 2) => {
    try {
      await refreshModels(slot, true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`AI-${slot} 槽位拉取失败：${msg}`, { duration: 8000 })
    }
  }

  // ── 会议转写：模型清单拉取（浏览器直连硅基流动 GET /models，三处下拉共用） ──
  const [asrModelIds, setAsrModelIds] = useState<string[]>([])
  const [asrListLoading, setAsrListLoading] = useState(false)
  const [asrListFetchedAt, setAsrListFetchedAt] = useState<number | null>(null)

  const handleFetchAsrList = async () => {
    if (!asrApiKey.trim()) {
      toast.error('先填硅基流动 API Key')
      return
    }
    setAsrListLoading(true)
    try {
      const ids = await fetchModelIds(asrBaseUrl, asrApiKey)
      setAsrModelIds(ids)
      setAsrListFetchedAt(Date.now())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`模型清单拉取失败：${msg}`, { duration: 8000 })
    } finally {
      setAsrListLoading(false)
    }
  }

  // 同一份原始清单，按用途过滤：转写 → ASR 类；翻译 / 修饰 → chat 类
  const asrTranscribeIds = asrModelIds.filter(isAsrModel)
  const asrChatIds = asrModelIds.filter(isChatModel)
  const asrFetchedLabel =
    asrModelIds.length > 0
      ? `清单 ${asrModelIds.length} 个（转写可用 ${asrTranscribeIds.length}） · ${formatFetchedAt(asrListFetchedAt)}`
      : '未拉取 —— 点「拉取清单」按你的 Key 列出可用模型'

  // 拉取清单过滤出 chat 类（下拉用），AI-1 / AI-2 对称
  const slot1ChatIds = slot1Models.map((m) => m.id).filter(isChatModel)
  const slot2ChatIds = slot2Models.map((m) => m.id).filter(isChatModel)

  // AI 服务组头的同步状态徽章：一眼确认 key 已生效，明细在诊断组
  const syncOkCount = secretItems.filter((it) => it.putOk).length
  const syncBadge = secretSyncing ? (
    <span className="flex shrink-0 items-center gap-1 text-ui-xs text-ink-400">
      <Loader2 className="h-3 w-3 animate-spin" />同步中
    </span>
  ) : secretItems.length > 0 ? (
    <span
      className={`shrink-0 text-ui-xs ${
        syncOkCount === secretItems.length ? 'text-green-600' : 'text-amber-600'
      }`}
    >
      {syncOkCount}/{secretItems.length} 已同步
    </span>
  ) : null

  return (
    <div className="flex h-full flex-col bg-paper-100">
      {/* 顶栏 */}
      <header className="shrink-0 border-b border-ink-200 bg-paper-50">
        <div className="page-container flex items-center justify-between py-2.5">
          <span className="flex items-center gap-1.5 text-ui-sm font-medium text-ink-900">
            <SettingsIcon className="h-4 w-4 text-ink-400" />
            设置
          </span>
          <Link
            to="/tracking"
            className="flex items-center gap-1 rounded-control px-2.5 py-1.5 text-ui-sm text-ink-600 transition hover:bg-seal-50 hover:text-seal-600"
          >
            <ArrowLeft className="w-4 h-4" />
            返回追踪页
          </Link>
        </div>
      </header>

      <main className="page-container flex min-h-0 flex-1 flex-col py-ui-page">
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-ui-gap lg:grid-cols-ratio-14 lg:grid-rows-[minmax(0,1fr)]">
          <aside className="min-w-0 min-h-0 overflow-y-auto">
            <nav className="rounded-card border border-ink-200 bg-paper-50 p-1.5 shadow-sm">
              {OUTLINE.map((g) => (
                <div key={g.group} className="space-y-0.5 pt-1">
                  <div className="px-ui-gap-sm py-1 text-ui-2xs font-medium text-ink-400">
                    {g.group}
                  </div>
                  {g.items.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() =>
                        document
                          .getElementById(it.id)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                      className="flex w-full items-center gap-ui-gap-sm rounded-control-sm px-ui-gap-sm py-2 text-left text-ui-sm font-medium text-ink-600 transition hover:bg-paper-100 hover:text-ink-800"
                    >
                      <it.icon className="h-ui-icon w-ui-icon" strokeWidth={1.75} />
                      {it.label}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
          </aside>

          <div className="min-w-0 min-h-0 overflow-y-auto space-y-ui-gap">
          {/* ── AI 服务 ── */}
          <Section id="ai-service" icon={Sparkles} title="AI 服务" badge={syncBadge}>
            <AISlotSection
              slot={1}
              title="AI-1（生成位）"
              desc="清理、打标、单词提取"
              advancedMode={advancedMode}
              providerMode={aiProviderMode}
              onProviderChange={(mode) => {
                // 切 provider 时自动填该家的生成位默认模型（防跨家模型名残留）
                const cfg = AI_PROVIDERS[mode]
                updateSettings({ aiProviderMode: mode, ai1Model: cfg.defaultModel1 || ai1Model })
              }}
              apiKey={slot1Key}
              onApiKeyChange={setSlot1Key}
              model={ai1Model}
              onModelChange={(v) => updateSettings({ ai1Model: v })}
              customBaseUrl={customAi1BaseUrl}
              onCustomBaseUrlChange={(v) => updateSettings({ customAi1BaseUrl: v })}
              customApiKey={customAi1ApiKey}
              onCustomApiKeyChange={(v) => updateSettings({ customAi1ApiKey: v })}
              customModel={customAi1Model}
              onCustomModelChange={(v) => updateSettings({ customAi1Model: v })}
              thinking={thinkingAi1}
              onThinkingChange={(v) => updateSettings({ thinkingAi1: v })}
              fetchedModels={slot1ChatIds}
              fetchedProvider={slot1ModelsProvider}
              fetchedAt={slot1ModelsFetchedAt}
              isFetching={isLoadingSlot1Models}
              canFetch={
                aiProviderMode === 'custom'
                  ? !!(customAi1BaseUrl.trim() && customAi1ApiKey.trim())
                  : !!slot1Key.trim()
              }
              onFetch={() => handleFetchModels(1)}
            />

            <AISlotSection
              slot={2}
              title="AI-2（审阅位）"
              desc="翻译、核验"
              advancedMode={advancedMode}
              providerMode={ai2ProviderMode}
              onProviderChange={(mode) => {
                // 切 provider 时自动填该家的审阅位默认模型
                const cfg = AI_PROVIDERS[mode]
                updateSettings({ ai2ProviderMode: mode, ai2Model: cfg.defaultModel2 || ai2Model })
              }}
              apiKey={slot2Key}
              onApiKeyChange={setSlot2Key}
              model={ai2Model}
              onModelChange={(v) => updateSettings({ ai2Model: v })}
              customBaseUrl={customAi2BaseUrl}
              onCustomBaseUrlChange={(v) => updateSettings({ customAi2BaseUrl: v })}
              customApiKey={customAi2ApiKey}
              onCustomApiKeyChange={(v) => updateSettings({ customAi2ApiKey: v })}
              customModel={customAi2Model}
              onCustomModelChange={(v) => updateSettings({ customAi2Model: v })}
              thinking={thinkingAi2}
              onThinkingChange={(v) => updateSettings({ thinkingAi2: v })}
              fallbackKeyNote={
                slot2Key.trim() === '' &&
                ai2ProviderMode !== 'custom' &&
                ai2ProviderMode === aiProviderMode
                  ? `未填写：将沿用 AI-1 位的 ${AI_PROVIDERS[ai2ProviderMode].label} Key（同 key 双模型）`
                  : undefined
              }
              fetchedModels={slot2ChatIds}
              fetchedProvider={slot2ModelsProvider}
              fetchedAt={slot2ModelsFetchedAt}
              isFetching={isLoadingSlot2Models}
              canFetch={
                ai2ProviderMode === 'custom'
                  ? !!(customAi2BaseUrl.trim() && customAi2ApiKey.trim())
                  : !!(slot2Key.trim() ||
                      (ai2ProviderMode === aiProviderMode && slot1Key.trim()))
              }
              onFetch={() => handleFetchModels(2)}
            />

            {/* 思考模式：按文献管线阶段控制 */}
            <SubHeading title="思考模式（reasoning）">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {THINKING_ROWS.map(({ field, label, desc }) => (
                  <div key={field} className="space-y-1">
                    <label className="block text-ui-sm font-medium text-ink-700">{label}</label>
                    <select
                      value={store[field]}
                      onChange={(e) =>
                        store.updateSettings({ [field]: e.target.value as AIThinkingMode })
                      }
                      className="w-full rounded-control border border-ink-300 bg-paper-50 px-ui-gap py-2 text-ui-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                    >
                      {THINKING_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-ui-xs text-ink-400">{desc}</p>
                  </div>
                ))}
              </div>
            </SubHeading>

            {/* 会议转写：浏览器直连硅基流动 */}
            <SubHeading title="会议转写">
              <APIKeyInput
                label="硅基流动 API Key"
                fieldId="asr"
                value={asrApiKey}
                onChange={(v) => updateSettings({ asrApiKey: v })}
                hint="转写与翻译共用此 Key；聊天管道若选「硅基流动」也直接复用这一把，无需再填。"
              />
              <AsrTestPanel />
              <div className="space-y-2">
                <label className="block text-ui-sm font-medium text-ink-700">转写 Base URL</label>
                <input
                  type="text"
                  value={asrBaseUrl}
                  onChange={(e) => updateSettings({ asrBaseUrl: e.target.value })}
                  placeholder="https://api.siliconflow.cn/v1"
                  spellCheck={false}
                  className="w-full rounded-control border border-ink-300 px-ui-gap py-2 font-mono text-ui-sm focus:outline-none focus:ring-2 focus:ring-seal-500"
                />
              </div>
              <AsrModelPicker
                label="转写模型"
                value={asrModel}
                onChange={(v) => updateSettings({ asrModel: v })}
                presets={ASR_TRANSCRIBE_PRESETS}
                fetched={asrTranscribeIds}
                canFetch={!!asrApiKey.trim()}
                isFetching={asrListLoading}
                fetchedLabel={asrFetchedLabel}
                onFetch={() => void handleFetchAsrList()}
                hint="SenseVoiceSmall 出字快、多语言；TeleSpeechASR 中文更准但明显更慢，易拖过超时线。"
              />
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-seal-600"
                  checked={asrTranslateToZh}
                  onChange={(e) => updateSettings({ asrTranslateToZh: e.target.checked })}
                />
                <span className="text-ui-sm font-medium text-ink-700">非中文自动译成中文</span>
              </label>
              <AsrModelPicker
                label="翻译模型"
                value={asrTranslateModel}
                onChange={(v) => updateSettings({ asrTranslateModel: v })}
                presets={ASR_TRANSLATE_PRESETS}
                fetched={asrChatIds}
                canFetch={!!asrApiKey.trim()}
                isFetching={asrListLoading}
                fetchedLabel={asrFetchedLabel}
                onFetch={() => void handleFetchAsrList()}
                allowEmpty
                emptyLabel="留空 = 不翻译"
              />
              <AsrModelPicker
                label="转写稿 AI 修饰模型"
                value={asrPolishModel}
                onChange={(v) => updateSettings({ asrPolishModel: v })}
                presets={ASR_POLISH_PRESETS}
                fetched={asrChatIds}
                canFetch={!!asrApiKey.trim()}
                isFetching={asrListLoading}
                fetchedLabel={asrFetchedLabel}
                onFetch={() => void handleFetchAsrList()}
                allowEmpty
                emptyLabel="留空 = 不启用"
                hint="用通用对话模型把口语化转写整理成书面段落。"
              />

              <details className="rounded-control border border-ink-200 bg-paper-100/60 px-ui-gap py-2.5 text-ui-xs text-ink-600">
                <summary className="flex cursor-pointer items-center gap-2">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-seal-500" />
                  长时间录音不中断 · 保活与加固
                </summary>
                <div className="mt-2 space-y-2 leading-relaxed">
                  <p>
                    录音期间会自动输出一段听不见的静音音源并占住系统锁，浏览器一般不会把本页冻结或回收。
                  </p>
                  <p>
                    若仍被打断，可把本站加入浏览器「内存节省程序」例外名单（Chrome：设置 → 性能 →
                    始终保持这些网站处于活动状态），或访问{' '}
                    <code className="font-mono text-ink-700">chrome://discards</code> 关掉自动丢弃。
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleCopySite()}
                    className="flex items-center gap-1.5 rounded-control-sm border border-ink-200 bg-paper-50 px-2 py-1 text-ui-xs font-medium text-ink-600 transition hover:bg-paper-100 hover:text-ink-800"
                  >
                    {copiedSite ? (
                      <Check className="h-3.5 w-3.5 text-green-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedSite ? '已复制' : '复制本站地址'}
                  </button>
                </div>
              </details>
            </SubHeading>
          </Section>

          {/* ── 文献服务 ── */}
          <Section id="lit-service" icon={BookOpen} title="文献服务">
            <SubHeading title="MinerU Token">
              <input
                type="password"
                placeholder="eyJ...（MinerU JWT token）"
                value={mineruToken}
                onChange={(e) => updateSettings({ mineruToken: e.target.value })}
                className="w-full rounded-control border border-ink-300 px-ui-gap py-2 font-mono text-ui-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
              <p className="text-ui-xs text-ink-400">
                在{' '}
                <a href="https://op.mineru.ai" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                  MinerU 用户中心
                </a>{' '}
                生成，填入后自动同步到后端。
              </p>
            </SubHeading>

            <SubHeading title="SimpleTex 令牌">
              <input
                type="password"
                placeholder="用户授权令牌（UAT）"
                value={simpletexToken}
                onChange={(e) => updateSettings({ simpletexToken: e.target.value })}
                className="w-full rounded-control border border-ink-300 px-ui-gap py-2 font-mono text-ui-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
              <p className="text-ui-xs text-ink-400">
                在{' '}
                <a href="https://simpletex.cn/user/center" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                  SimpleTex 用户中心
                </a>{' '}
                的「用户授权令牌」里创建；填入后自动同步到后端。
              </p>
            </SubHeading>

            <SubHeading title="转换后自动任务">
              <div className="flex items-center gap-4">
                <label className="text-ui-sm font-medium text-ink-700 whitespace-nowrap">单词生成数量</label>
                <input
                  type="range"
                  min={10}
                  max={50}
                  step={1}
                  value={store.wordGenCount ?? 15}
                  onChange={(e) => store.updateSettings({ wordGenCount: parseInt(e.target.value, 10) })}
                  className="flex-1 h-2 bg-ink-200 rounded-control appearance-none cursor-pointer accent-seal-600"
                />
                <span className="text-ui-sm font-semibold text-seal-600 w-12 text-center">
                  {store.wordGenCount ?? 15}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <label className="text-ui-sm font-medium text-ink-700 whitespace-nowrap">长难句提取数量</label>
                <input
                  type="range"
                  min={3}
                  max={30}
                  step={1}
                  value={store.sentenceGenCount ?? 8}
                  onChange={(e) => store.updateSettings({ sentenceGenCount: parseInt(e.target.value, 10) })}
                  className="flex-1 h-2 bg-ink-200 rounded-control appearance-none cursor-pointer accent-seal-600"
                />
                <span className="text-ui-sm font-semibold text-seal-600 w-12 text-center">
                  {store.sentenceGenCount ?? 8}
                </span>
              </div>
            </SubHeading>

            <SubHeading title="翻译判分标准">
              <div className="flex items-center gap-4">
                <label className="text-ui-sm font-medium text-ink-700 whitespace-nowrap">低分线</label>
                <input
                  type="range"
                  min={50}
                  max={95}
                  step={5}
                  value={store.translationLowScore ?? 70}
                  onChange={(e) => store.updateSettings({ translationLowScore: parseInt(e.target.value, 10) })}
                  className="flex-1 h-2 bg-ink-200 rounded-control appearance-none cursor-pointer accent-seal-600"
                />
                <span className="text-ui-sm font-semibold text-seal-600 w-12 text-center">
                  {store.translationLowScore ?? 70}
                </span>
              </div>
            </SubHeading>

            <SubHeading title="编辑器偏好">
              <div className="flex items-center gap-3">
                <label className="whitespace-nowrap text-ui-sm font-medium text-ink-700">
                  代码块默认语言
                </label>
                <select
                  value={store.defaultCodeLang ?? 'python'}
                  onChange={(e) => updateSettings({ defaultCodeLang: e.target.value })}
                  className="flex-1 rounded-control border border-ink-300 bg-paper-50 px-ui-gap py-2 text-ui-sm focus:outline-none focus:ring-2 focus:ring-seal-500"
                >
                  {CODE_LANGS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-seal-600"
                  checked={store.editorZebra ?? true}
                  onChange={(e) => updateSettings({ editorZebra: e.target.checked })}
                />
                <span className="text-ui-sm font-medium text-ink-700">间隔上色</span>
              </label>
            </SubHeading>
          </Section>

          {/* ── 数据 ── */}
          <Section id="pdf-cleanup" icon={Trash2} title="清理 PDF">
            <PdfCleanupPanel />
          </Section>

          <Section id="backend-rewrite" icon={Server} title="后端工作流">
            <BackendCapabilitiesPanel />
          </Section>

          {/* ── 开发者中心 ── */}
          <Section id="connectivity" icon={Activity} title="连通性检测">
            <ConnectivityPanel />
          </Section>

          <Section id="dual-engine" icon={FlaskConical} title="双引擎试运行">
            <DualEngineTestPanel />
          </Section>

          <Section id="secrets-sync" icon={Wrench} title="Secrets 同步">
            <div className="overflow-hidden rounded-control border border-ink-200 bg-paper-100">
              <div className="af-line-b flex items-center justify-between px-ui-gap py-1.5 bg-ink-100 text-ui-xs">
                <span className="font-medium text-ink-700">同步明细</span>
                <button
                  type="button"
                  onClick={runSync}
                  disabled={secretSyncing}
                  className="flex items-center gap-1 rounded-control border border-ink-300 bg-paper-50 px-2 py-0.5 text-ui-xs hover:bg-paper-100 disabled:text-ink-400"
                >
                  {secretSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  手动同步
                </button>
              </div>
              {secretItems.length === 0 ? (
                <div className="px-ui-gap py-2 text-ui-xs text-ink-400">等待首次同步…</div>
              ) : (
                <div className="af-divided text-ui-xs font-mono">
                  {secretItems.map((it) => {
                    const isSkipped = !it.valueWanted && it.putStatus === 0
                    const isFailed = !it.putOk
                    const isDelayed = it.putOk && it.valueWanted && !it.verified

                    let icon: string, color: string, label: string
                    if (isSkipped) { icon = '—'; color = 'text-ink-400'; label = '未填写（跳过）' }
                    else if (isFailed) { icon = '✗'; color = 'text-red-600'; label = it.error || `PUT 失败 HTTP ${it.putStatus}` }
                    else if (isDelayed) {
                      icon = '⏳'; color = 'text-amber-600'
                      // PUT 已成功（201/204），只是 secrets 列表还没列出来；
                      // workflow 运行时 GitHub Actions 通常能直接读到值
                      label = it.error || 'GitHub 回查未命中（已重试多次，PUT 实际成功）'
                    }
                    else { icon = '✓'; color = 'text-green-600'; label = '已写入 + 已回查确认' }

                    const valPreview = isSkipped ? '' : (() => {
                      const v = it.valueWanted
                      if (!v) return ''
                      if (v.length <= 12) return v
                      return v.slice(0, 8) + '…' + v.slice(-4)
                    })()

                    return (
                      <div key={it.name} className="flex items-center gap-2 px-ui-gap py-1.5">
                        <span className={`${color} w-4 text-center shrink-0`}>{icon}</span>
                        <span className="text-ink-700 w-40 shrink-0 truncate" title={it.name}>{it.name}</span>
                        {valPreview && (
                          <span className="text-ink-400 truncate flex-1 max-w-[12.5rem]" title={it.valueWanted}>
                            {valPreview}
                          </span>
                        )}
                        <span className={`${color} ml-auto truncate max-w-[16.25rem]`}>{label}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <details className="text-ui-xs text-ink-500">
              <summary className="cursor-pointer select-none">同步目标</summary>
              <p className="mt-1 leading-relaxed">写入 {owner}/{repoName}，配置变更后自动同步。</p>
            </details>
          </Section>

          <Section id="pipeline-debug" icon={Gauge} title="Pipeline 看板">
            <PipelineDebugPanel />
          </Section>

          <Section id="advanced-mode" icon={SlidersHorizontal} title="高级模式">
            <button
              type="button"
              onClick={() => updateSettings({ advancedMode: !advancedMode })}
              className="flex items-center gap-2 rounded-control border border-ink-200 bg-paper-50 px-ui-gap py-2 text-ui-sm font-medium text-ink-700 transition hover:bg-paper-100"
            >
              {advancedMode ? (
                <ToggleRight className="h-5 w-5 text-seal-600" />
              ) : (
                <ToggleLeft className="h-5 w-5 text-ink-400" />
              )}
              解锁自定义 OpenAI 兼容端点
            </button>
          </Section>

          <div className="pt-2 text-center text-ui-xs text-ink-400">
            所有凭据仅存本机 IndexedDB · License AGPL-3.0-or-later
          </div>
          </div>
        </div>
      </main>
    </div>
  )
}

/** AI 槽位配置块 —— AI-1（生成位）/ AI-2（审阅位）共用同一组件，保证完全对称。
 *  每个槽位：Provider 选择 + 该家该位的 API Key + 该家的模型下拉；
 *  Provider 为 custom 时展开 Base URL / Key / Model 三件套。 */
function AISlotSection(props: {
  slot: 1 | 2
  title: string
  desc: string
  advancedMode: boolean
  providerMode: AIProviderMode
  onProviderChange: (mode: AIProviderMode) => void
  /** 当前 provider 对应本槽位的 key 值（custom 模式下不用） */
  apiKey: string
  onApiKeyChange: (v: string) => void
  model: string
  onModelChange: (v: string) => void
  customBaseUrl: string
  onCustomBaseUrlChange: (v: string) => void
  customApiKey: string
  onCustomApiKeyChange: (v: string) => void
  customModel: string
  onCustomModelChange: (v: string) => void
  /** 本槽位交互式调用的推理模式（'' = 不干预） */
  thinking: AISlotThinking
  onThinkingChange: (v: AISlotThinking) => void
  /** 本槽位 key 留空时的共用提示（仅 AI-2 位会出现） */
  fallbackKeyNote?: string
  /** 从 runner 拉取的真实模型 id 清单（已过滤 chat 类，下拉第二组） */
  fetchedModels: string[]
  /** 拉取清单对应的 provider —— 与当前 provider 不一致时旧清单不适用于过滤 */
  fetchedProvider: string
  /** 真实清单最后一次拉取时间 */
  fetchedAt: number | null
  /** 正在拉取 */
  isFetching: boolean
  /** baseUrl + key 已填，可以拉取 */
  canFetch: boolean
  /** 触发拉取 */
  onFetch: () => void
}) {
  const {
    slot, title, desc, advancedMode, providerMode, onProviderChange,
    apiKey, onApiKeyChange, model, onModelChange,
    customBaseUrl, onCustomBaseUrlChange, customApiKey, onCustomApiKeyChange,
    customModel, onCustomModelChange, thinking, onThinkingChange, fallbackKeyNote,
    fetchedModels, fetchedProvider, fetchedAt, isFetching, canFetch, onFetch,
  } = props
  const thinkingHint = SLOT_THINKING_OPTIONS.find((o) => o.value === thinking)?.hint ?? ''

  const isCustom = providerMode === 'custom'
  const cfg = AI_PROVIDERS[providerMode]
  const defaultModel = slot === 1 ? cfg.defaultModel1 : cfg.defaultModel2
  const recs = cfg.recommendedModels
  // 清单只在「有内容 且 属于当前 provider」时才可用于验证（防切 provider 后误用旧清单）
  const hasFetched = fetchedModels.length > 0 && fetchedProvider === providerMode
  const fetchedSet = new Set(fetchedModels)
  // 推荐组**永远**显示全部推荐项，不用拉取到的清单去过滤。
  // 理由：/models 不保证是全集。实测智谱 glm-4.7-flash 能正常调用（200 OK），
  // 但该账号的 /models 里根本没有这个 id —— 一旦按清单过滤，下面的自动纠正会把
  // 用户选好的 glm-4.7-flash 悄悄换成清单里的第一个模型，界面上还看不出来。
  const recIds = new Set(recs.map((m) => m.id))
  // 第二组：拉取清单里推荐之外的真实模型
  const extraFetched = Array.from(new Set(fetchedModels.filter((id) => !recIds.has(id)))).sort()
  // 下拉显示值：优先用户已选且确实可用的；死模型回落到第一个推荐（或清单首项）
  const displayIds = hasFetched
    ? new Set([...recs.map((m) => m.id), ...fetchedModels])
    : recIds
  const fallbackModel = hasFetched
    ? (recs[0]?.id ?? fetchedModels[0])
    : (defaultModel || model)
  const shownModel = displayIds.has(model) ? model : fallbackModel
  /** 当前选中模型的官方价目（只有预置 provider 的推荐模型带 pricing，自定义端点没有） */
  const selectedPricing = recs.find((m) => m.id === shownModel)?.pricing

  // 已拉取且存储的模型既不在推荐清单、也不在真实清单里 → 判定为死模型并自动纠正
  // （防止 secrets 同步把死模型带给 runner）。推荐项永远豁免，理由见上方注释。
  useEffect(() => {
    if (isCustom || !hasFetched || !model) return
    if (!recIds.has(model) && !fetchedSet.has(model) && fallbackModel && fallbackModel !== model) {
      onModelChange(fallbackModel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustom, hasFetched, model, fallbackModel])

  return (
    <div className="space-y-4 pt-5 first:pt-0">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-ui-sm font-semibold text-ink-800">
            <Sparkles className="h-4 w-4 text-seal-600" />
            {title}
          </h3>
          <p className="mt-0.5 text-ui-xs text-ink-500">{desc}</p>
        </div>
        {!isCustom && cfg.apiKeyUrl && (
          <a
            href={cfg.apiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ui-xs text-seal-600 hover:text-seal-800 whitespace-nowrap"
          >
            去获取 API Key →
          </a>
        )}
      </div>

      {/* Provider 选择 —— 两个槽位完全一致 */}
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(AI_PROVIDERS) as AIProviderMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={mode === 'custom' && !advancedMode}
            onClick={() => onProviderChange(mode)}
            className={`rounded-control border px-ui-gap py-2 text-ui-sm transition ${
              providerMode === mode
                ? 'bg-seal-50 border-seal-400 text-seal-800 font-medium'
                : 'bg-paper-50 border-ink-300 text-ink-600 hover:border-ink-400'
            } ${mode === 'custom' && !advancedMode ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {AI_PROVIDERS[mode].label}
          </button>
        ))}
      </div>

      {isCustom ? (
        <div className="space-y-2 rounded-control border border-ink-200 bg-paper-100 p-3">
          <input
            type="text"
            value={customBaseUrl}
            onChange={(e) => onCustomBaseUrlChange(e.target.value)}
            placeholder="Base URL，如 https://api.openai.com/v1"
            className="w-full rounded-control border border-ink-300 px-ui-gap py-2 font-mono text-ui-sm
                       focus:outline-none focus:ring-2 focus:ring-seal-500"
          />
          <APIKeyInput
            label="API Key"
            fieldId={`custom-ai${slot}`}
            value={customApiKey}
            onChange={onCustomApiKeyChange}
          />
          <input
            type="text"
            value={customModel}
            onChange={(e) => onCustomModelChange(e.target.value)}
            placeholder="Model ID，如 gpt-4o-mini"
            className="w-full rounded-control border border-ink-300 px-ui-gap py-2 font-mono text-ui-sm
                       focus:outline-none focus:ring-2 focus:ring-seal-500"
          />
        </div>
      ) : (
        <>
          <APIKeyInput
            label={`${cfg.label} API Key（AI-${slot} 位）`}
            fieldId={`ai${slot}-${providerMode}`}
            value={apiKey}
            onChange={onApiKeyChange}
            hint="仅存本机"
          />
          {fallbackKeyNote && (
            <p className="text-ui-xs text-amber-600 -mt-2">{fallbackKeyNote}</p>
          )}

          {/* 拉取真实模型清单（runner 代拉该槽位 provider 的 /v1/models） */}
          <div className="flex items-center justify-between">
            <div className="text-ui-xs text-ink-500">
              模型清单：
              {hasFetched
                ? `${fetchedModels.length} 个`
                : fetchedModels.length > 0
                  ? '已切换 Provider，旧清单不适用'
                  : '未拉取'}
              {' '}· <span className="font-mono">{formatFetchedAt(fetchedAt)}</span>
            </div>
            <button
              type="button"
              onClick={onFetch}
              disabled={isFetching || !canFetch}
              className="flex items-center gap-1 rounded-control border border-ink-300 px-2.5 py-1 text-ui-xs
                         hover:bg-paper-100 disabled:cursor-not-allowed disabled:text-ink-300"
            >
              {isFetching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              拉取
            </button>
          </div>

          <div className="space-y-1.5">
            <label className="block text-ui-sm font-medium text-ink-700">模型</label>
            <select
              value={shownModel}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full rounded-control border border-ink-300 bg-paper-50 px-ui-gap py-2 font-mono text-ui-sm
                         focus:border-transparent focus:outline-none focus:ring-2 focus:ring-seal-500"
            >
              {recs.length > 0 && (
                <optgroup label="推荐">
                  {recs.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} · {m.desc}
                    </option>
                  ))}
                </optgroup>
              )}
              {extraFetched.length > 0 && (
                <optgroup label={`拉取清单（${extraFetched.length} 个）`}>
                  {extraFetched.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {/* 官方价目：空闲 / 高峰双价 + 缓存命中价。
              重试/复核会命中前缀缓存，输入按缓存价计（约为未命中的 1/50）。 */}
          {selectedPricing && (
            <div className="rounded-control border border-ink-200 bg-paper-100/70 p-3 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-ui-xs font-medium text-ink-600">官方价目</span>
                <span className="text-ui-xs font-mono text-ink-400 truncate">{shownModel}</span>
              </div>
              <table className="w-full text-ui-xs tabular-nums">
                <thead>
                  <tr className="text-ink-400">
                    <th className="text-left font-normal">时段</th>
                    <th className="text-right font-normal">输入 · 缓存命中</th>
                    <th className="text-right font-normal">输入 · 未命中</th>
                    <th className="text-right font-normal">输出</th>
                  </tr>
                </thead>
                <tbody className="text-ink-600">
                  <tr>
                    <td>空闲</td>
                    <td className="text-right">{selectedPricing.offPeak.cacheHit}</td>
                    <td className="text-right">{selectedPricing.offPeak.cacheMiss}</td>
                    <td className="text-right">{selectedPricing.offPeak.output}</td>
                  </tr>
                  <tr>
                    <td>高峰</td>
                    <td className="text-right">{selectedPricing.peak.cacheHit}</td>
                    <td className="text-right">{selectedPricing.peak.cacheMiss}</td>
                    <td className="text-right">{selectedPricing.peak.output}</td>
                  </tr>
                </tbody>
              </table>
              <p className="text-ui-xs text-ink-400">
                元 / 百万 tokens · 高峰 = 工作日 9–12 / 14–18 时 · 重写复核命中前缀缓存，输入按缓存价计
              </p>
            </div>
          )}
        </>
      )}

      {/* 推理模式 —— 本槽位的交互式调用：问 AI / 双引擎 / 联网检索 */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-ui-sm font-medium text-ink-700">
          <Brain className="w-3.5 h-3.5 text-violet-500" />
          推理模式
        </label>
        <select
          value={thinking}
          onChange={(e) => onThinkingChange(e.target.value as AISlotThinking)}
          className="w-full rounded-control border border-ink-300 bg-paper-50 px-ui-gap py-2 text-ui-sm
                     focus:border-transparent focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {SLOT_THINKING_OPTIONS.map((o) => (
            <option key={o.value || 'default'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="text-ui-xs text-ink-400">{thinkingHint}</p>
      </div>
    </div>
  )
}

export default Settings
