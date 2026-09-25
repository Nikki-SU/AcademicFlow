/**
 * 设置页 —— 分组折叠（手机设置模式）
 * 四组：AI 服务 / 文献处理 / 数据维护 / 诊断与调试。
 * 诊断类面板（连通性、双引擎、后端能力、Secrets 明细、Pipeline 看板）默认折叠。
 */
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  Database,
  FileText,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import APIKeyInput from '../components/settings/APIKeyInput'
import DualEngineTestPanel from '../components/settings/DualEngineTestPanel'
import ConnectivityPanel from '../components/settings/ConnectivityPanel'


import { PipelineDebugPanel } from '../components/PipelineDebugPanel'
import BackendCapabilitiesPanel from '../components/settings/BackendCapabilitiesPanel'
import PdfCleanupPanel from '../components/settings/PdfCleanupPanel'
import { isChatModel } from '../services/ai/models'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { DEFAULT_WORKSPACE_REPO_NAME } from '../constants/skeleton'
import { CODE_LANGS } from '../constants/codeLangs'
import { syncAllSecrets, type SecretItemStatus } from '../services/repoSecrets'
import type { AIProviderMode, AIThinkingMode, AISlotThinking } from '../types'
import { AI_PROVIDERS } from '../types'

/**
 * 槽位级推理模式选项 —— 多一个「不干预」。
 * 交互式调用（问 AI、双引擎、检索）加这个开关之前从来不发 thinking 参数，
 * 默认必须是「什么都不发」，否则等于替用户改了一次行为。
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

/** 思考模式下拉选项 —— off 关闭，其余为开启并控制强度 */
const THINKING_OPTIONS: { value: AIThinkingMode; label: string }[] = [
  { value: 'off', label: '关闭思考（推荐）' },
  { value: 'low', label: '开启 · 低强度' },
  { value: 'high', label: '开启 · 高强度' },
  { value: 'max', label: '开启 · 最高强度' },
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

/** 分组卡片：组头可点击折叠，展开区以分隔线区隔各子块 */
function SettingsGroup(props: {
  icon: LucideIcon
  title: string
  summary: string
  badge?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const { icon: Icon, title, summary, badge, open, onToggle, children } = props
  return (
    <section className="overflow-hidden rounded-xl border border-ink-200 bg-paper-50 shadow-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-paper-100"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-paper-100">
          <Icon className="h-4 w-4 text-ink-600" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink-900">{title}</div>
          <div className="truncate text-xs text-ink-500">{summary}</div>
        </div>
        {badge}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="divide-y divide-ink-100 border-t border-ink-200 px-5 py-5">{children}</div>
      )}
    </section>
  )
}

/** 组内子块：小节标题 + 一行说明 + 内容 */
function SubBlock(props: { title: string; hint?: string; children: ReactNode }) {
  const { title, hint, children } = props
  return (
    <div className="space-y-3 pt-5 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
      </div>
      {children}
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
    simpletexSecret,
    thinkingAi1,
    thinkingAi2,
    updateSettings,
    refreshModels,
    init,
  } = store

  // 分组折叠状态：前两组默认展开，诊断类默认收起
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    ai: true,
    processing: true,
    data: false,
    diag: false,
  })
  const toggleGroup = (k: string) =>
    setOpenGroups((s) => ({ ...s, [k]: !s[k] }))

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
        mineruToken: 'MinerU Token',
        simpletexToken: 'SimpleTex 令牌',
        simpletexSecret: 'SimpleTex APP Secret',
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
   *  行为：每次配置变了 → debounce 800ms → syncAllSecrets 把 7 个都 PUT 到 GitHub
   *        → 等 1.5s GitHub 索引 → GET list 回查确认存在
   *        → 每条结果存进 state，UI 一条条亮给用户看（拒绝黑箱）
   *  mount 后自动跑一次（didMountSyncRef 确保只跑一次）
   */
  const secretSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didMountSyncRef = useRef(false)
  const [secretSyncing, setSecretSyncing] = useState(false)
  /** 最近一次 syncAllSecrets 返回的每条 secret 的明细状态 */
  const [secretItems, setSecretItems] = useState<SecretItemStatus[]>([])

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
        customAi1BaseUrl,
        customAi1ApiKey,
        customAi1Model,
        customAi2BaseUrl,
        customAi2ApiKey,
        customAi2Model,
        mineruToken,
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
    customAi1BaseUrl, customAi1ApiKey, customAi1Model,
    customAi2BaseUrl, customAi2ApiKey, customAi2Model,
    mineruToken,
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
      <div className="flex min-h-screen items-center justify-center bg-paper-100">
        <div className="flex items-center gap-3 text-ink-600">
          <Loader2 className="h-5 w-5 animate-spin text-seal-600" />
          <span className="text-sm">正在加载设置…</span>
        </div>
      </div>
    )
  }

  // ── AI-1 位：当前 provider 对应的 key 槽位（custom 模式走自定义 Key，不用此槽位） ──
  const slot1Key = aiProviderMode === 'deepseek' ? deepseekApiKey : ''
  const setSlot1Key = (v: string) => {
    if (aiProviderMode === 'deepseek') updateSettings({ deepseekApiKey: v })
  }

  // ── AI-2 位：当前 provider 对应的 key2 槽位（与 AI-1 完全对称） ──
  const slot2Key = ai2ProviderMode === 'deepseek' ? deepseekApiKey2 : ''
  const setSlot2Key = (v: string) => {
    if (ai2ProviderMode === 'deepseek') updateSettings({ deepseekApiKey2: v })
  }

  /** 拉取某槽位的真实模型清单（runner 代拉该槽位 provider 的 /v1/models） */
  const handleFetchModels = async (slot: 1 | 2) => {
    try {
      const models = await refreshModels(slot, true)
      toast.success(`AI-${slot} 槽位已拉取 ${models.length} 个模型`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`AI-${slot} 槽位拉取失败：${msg}`, { duration: 8000 })
    }
  }

  // 拉取清单过滤出 chat 类（下拉用），AI-1 / AI-2 对称
  const slot1ChatIds = slot1Models.map((m) => m.id).filter(isChatModel)
  const slot2ChatIds = slot2Models.map((m) => m.id).filter(isChatModel)

  // AI 服务组头的同步状态徽章：一眼确认 key 已生效，明细在诊断组
  const syncOkCount = secretItems.filter((it) => it.putOk).length
  const syncBadge = secretSyncing ? (
    <span className="flex shrink-0 items-center gap-1 text-xs text-ink-400">
      <Loader2 className="h-3 w-3 animate-spin" />同步中
    </span>
  ) : secretItems.length > 0 ? (
    <span
      className={`shrink-0 text-xs ${
        syncOkCount === secretItems.length ? 'text-green-600' : 'text-amber-600'
      }`}
    >
      {syncOkCount}/{secretItems.length} 已同步
    </span>
  ) : null

  return (
    <div className="min-h-full bg-paper-100">
      {/* 顶栏 */}
      <header className="sticky top-0 z-10 border-b border-ink-200 bg-paper-50">
        <div className="page-container flex items-center justify-between py-2.5">
          <span className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
            <SettingsIcon className="h-4 w-4 text-ink-400" />
            设置
          </span>
          <Link
            to="/tracking"
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-ink-600 transition hover:bg-seal-50 hover:text-seal-600"
          >
            <ArrowLeft className="w-4 h-4" />
            返回追踪页
          </Link>
        </div>
      </header>

      <main className="page-container py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {/* ── AI 服务 ── */}
          <SettingsGroup
            icon={Sparkles}
            title="AI 服务"
            summary="AI-1 生成位 / AI-2 审阅位 · Key、模型与推理模式"
            badge={syncBadge}
            open={openGroups.ai}
            onToggle={() => toggleGroup('ai')}
          >
            {/* 高级模式 */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-ink-800">高级模式</h3>
                <p className="mt-0.5 text-xs text-ink-500">解锁自定义 OpenAI 兼容端点</p>
              </div>
              <button
                type="button"
                onClick={() => updateSettings({ advancedMode: !advancedMode })}
                aria-label="切换高级模式"
              >
                {advancedMode ? (
                  <ToggleRight className="h-6 w-6 text-seal-600" />
                ) : (
                  <ToggleLeft className="h-6 w-6 text-ink-400" />
                )}
              </button>
            </div>

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
            <SubBlock
              title="思考模式（reasoning）"
              hint="机械任务建议关闭：思考与正文共用输出预算"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {THINKING_ROWS.map(({ field, label, desc }) => (
                  <div key={field} className="space-y-1">
                    <label className="block text-sm font-medium text-ink-700">{label}</label>
                    <select
                      value={store[field]}
                      onChange={(e) =>
                        store.updateSettings({ [field]: e.target.value as AIThinkingMode })
                      }
                      className="w-full rounded-lg border border-ink-300 bg-paper-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                    >
                      {THINKING_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-ink-400">{desc}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-ink-400">
                只管文献处理管线；问 AI / 双引擎走各槽位自己的「推理模式」。
              </p>
            </SubBlock>
          </SettingsGroup>

          {/* ── 文献处理 ── */}
          <SettingsGroup
            icon={FileText}
            title="文献处理"
            summary="PDF 转换、公式识图与转换后的自动任务"
            open={openGroups.processing}
            onToggle={() => toggleGroup('processing')}
          >
            <SubBlock
              title="MinerU Token"
              hint="PDF → Markdown 转换必需"
            >
              <input
                type="password"
                placeholder="eyJ...（MinerU JWT token）"
                value={mineruToken}
                onChange={(e) => updateSettings({ mineruToken: e.target.value })}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
              <p className="text-xs text-ink-400">
                在{' '}
                <a href="https://op.mineru.ai" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                  MinerU 用户中心
                </a>{' '}
                生成，填入后自动同步到后端。
              </p>
            </SubBlock>

            <SubBlock
              title="SimpleTex 令牌"
              hint="写作页「公式识图」用"
            >
              <input
                type="password"
                placeholder="UAT 或 APP ID"
                value={simpletexToken}
                onChange={(e) => updateSettings({ simpletexToken: e.target.value })}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
              <input
                type="password"
                placeholder="APP Secret（仅 APP 鉴权需要，UAT 留空）"
                value={simpletexSecret}
                onChange={(e) => updateSettings({ simpletexSecret: e.target.value })}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
              <p className="text-xs text-ink-400">
                在{' '}
                <a href="https://simpletex.cn/user/center" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                  SimpleTex 用户中心
                </a>{' '}
                创建。仅存本机，识图时临时传给后端，不写进私库。
              </p>
            </SubBlock>

            <SubBlock
              title="转换后自动任务"
              hint="PDF 转换成功后自动生成全文翻译与核心单词"
            >
              <div className="flex items-center gap-4">
                <label className="text-sm font-medium text-ink-700 whitespace-nowrap">单词生成数量</label>
                <input
                  type="range"
                  min={10}
                  max={50}
                  step={1}
                  value={store.wordGenCount ?? 15}
                  onChange={(e) => store.updateSettings({ wordGenCount: parseInt(e.target.value, 10) })}
                  className="flex-1 h-2 bg-ink-200 rounded-lg appearance-none cursor-pointer accent-seal-600"
                />
                <span className="text-sm font-semibold text-seal-600 w-12 text-center">
                  {store.wordGenCount ?? 15}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <label className="text-sm font-medium text-ink-700 whitespace-nowrap">长难句提取数量</label>
                <input
                  type="range"
                  min={3}
                  max={30}
                  step={1}
                  value={store.sentenceGenCount ?? 8}
                  onChange={(e) => store.updateSettings({ sentenceGenCount: parseInt(e.target.value, 10) })}
                  className="flex-1 h-2 bg-ink-200 rounded-lg appearance-none cursor-pointer accent-seal-600"
                />
                <span className="text-sm font-semibold text-seal-600 w-12 text-center">
                  {store.sentenceGenCount ?? 8}
                </span>
              </div>
              <p className="text-xs text-ink-400">数量越多，耗时与 token 消耗越大。例句必须逐字来自原文献。</p>
            </SubBlock>

            <SubBlock title="编辑器偏好" hint="写作页与阅读笔记共用">
              <div className="flex items-center gap-3">
                <label className="whitespace-nowrap text-sm font-medium text-ink-700">
                  代码块默认语言
                </label>
                <select
                  value={store.defaultCodeLang ?? 'python'}
                  onChange={(e) => updateSettings({ defaultCodeLang: e.target.value })}
                  className="flex-1 rounded-lg border border-ink-300 bg-paper-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-seal-500"
                >
                  {CODE_LANGS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-ink-400">
                点工具栏「代码块」时预选的语言；插入前还可以改成别的。
              </p>
            </SubBlock>
          </SettingsGroup>

          {/* ── 数据维护 ── */}
          <SettingsGroup
            icon={Database}
            title="数据维护"
            summary="清理已转换文献的 PDF，释放仓库空间"
            open={openGroups.data}
            onToggle={() => toggleGroup('data')}
          >
            <SubBlock
              title="清理已转换的 PDF"
              hint="只列转换成功的文献；md、图片、词汇表不受影响"
            >
              <PdfCleanupPanel />
            </SubBlock>
          </SettingsGroup>

          {/* ── 诊断与调试 ── */}
          <SettingsGroup
            icon={Wrench}
            title="诊断与调试"
            summary="连通性测试、双引擎试运行、后端能力、Secrets 明细、Pipeline 看板"
            open={openGroups.diag}
            onToggle={() => toggleGroup('diag')}
          >
            <SubBlock title="服务连通性" hint="GitHub / AI / MinerU，排查问题时用">
              <ConnectivityPanel />
            </SubBlock>

            <SubBlock title="双引擎试运行" hint="用当前配置跑一次事实核查，验证生成 + 审阅链路">
              <DualEngineTestPanel />
            </SubBlock>

            <SubBlock title="后端处理能力" hint="GitHub Actions 工作流状态">
              <BackendCapabilitiesPanel />
            </SubBlock>

            <SubBlock
              title="Secrets 同步状态"
              hint={`写入 ${owner}/${repoName}，配置变更后自动同步`}
            >
              <div className="overflow-hidden rounded-lg border border-ink-200 bg-paper-100">
                <div className="flex items-center justify-between px-3 py-1.5 bg-ink-100 border-b border-ink-200 text-xs">
                  <span className="font-medium text-ink-700">同步明细</span>
                  <button
                    type="button"
                    onClick={runSync}
                    disabled={secretSyncing}
                    className="flex items-center gap-1 rounded-lg border border-ink-300 bg-paper-50 px-2 py-0.5 text-[11px] hover:bg-paper-100 disabled:text-ink-400"
                  >
                    {secretSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    手动同步
                  </button>
                </div>
                {secretItems.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-ink-400">等待首次同步…</div>
                ) : (
                  <div className="divide-y divide-ink-200 text-[11px] font-mono">
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
                        <div key={it.name} className="flex items-center gap-2 px-3 py-1.5">
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
            </SubBlock>

            <SubBlock title="Pipeline 调试看板" hint="每次 PDF 转换的完整链路：每步 Prompt / 输入 / 输出 / 耗时">
              <PipelineDebugPanel />
            </SubBlock>
          </SettingsGroup>

          <div className="pt-2 text-center text-xs text-ink-400">
            所有凭据仅存本机 IndexedDB · License AGPL-3.0-or-later
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
  // 拉取过后：推荐组只显示真实存在的模型（防接不存在的模型）；未拉取时显示全部推荐
  const verifiedRecs = hasFetched ? recs.filter((m) => fetchedSet.has(m.id)) : recs
  const recIds = new Set(recs.map((m) => m.id))
  // 第二组：拉取清单里推荐之外的真实模型
  const extraFetched = Array.from(new Set(fetchedModels.filter((id) => !recIds.has(id)))).sort()
  // 下拉显示值：优先用户已选且真实存在的；死模型回落到第一个已验证推荐（或清单首项）
  const displayIds = hasFetched
    ? new Set([...verifiedRecs.map((m) => m.id), ...fetchedModels])
    : recIds
  const fallbackModel = hasFetched
    ? (verifiedRecs[0]?.id ?? fetchedModels[0])
    : (defaultModel || model)
  const shownModel = displayIds.has(model) ? model : fallbackModel
  /** 当前选中模型的官方价目（只有预置 provider 的推荐模型带 pricing，自定义端点没有） */
  const selectedPricing = recs.find((m) => m.id === shownModel)?.pricing

  // 已拉取且存储的模型被证实不存在 → 自动纠正（防止 secrets 同步把死模型带给 runner）
  useEffect(() => {
    if (isCustom || !hasFetched || !model) return
    if (!fetchedSet.has(model) && fallbackModel && fallbackModel !== model) {
      onModelChange(fallbackModel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustom, hasFetched, model, fallbackModel])

  return (
    <div className="space-y-4 pt-5 first:pt-0">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-800">
            <Sparkles className="h-4 w-4 text-seal-600" />
            {title}
          </h3>
          <p className="mt-0.5 text-xs text-ink-500">{desc}</p>
        </div>
        {!isCustom && cfg.apiKeyUrl && (
          <a
            href={cfg.apiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-seal-600 hover:text-seal-800 whitespace-nowrap"
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
            className={`rounded-lg border px-3 py-2 text-sm transition ${
              providerMode === mode
                ? 'bg-seal-50 border-seal-400 text-seal-800 font-medium'
                : 'bg-paper-50 border-ink-300 text-ink-600 hover:border-ink-400'
            } ${mode === 'custom' && !advancedMode ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {AI_PROVIDERS[mode].label}
          </button>
        ))}
      </div>
      {!isCustom && (
        <p className="text-xs text-ink-500">{cfg.note}</p>
      )}

      {isCustom ? (
        <div className="space-y-2 rounded-lg border border-ink-200 bg-paper-100 p-3">
          <input
            type="text"
            value={customBaseUrl}
            onChange={(e) => onCustomBaseUrlChange(e.target.value)}
            placeholder="Base URL，如 https://api.openai.com/v1"
            className="w-full rounded-lg border border-ink-300 px-3 py-2 font-mono text-sm
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
            className="w-full rounded-lg border border-ink-300 px-3 py-2 font-mono text-sm
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
            <p className="text-xs text-amber-600 -mt-2">{fallbackKeyNote}</p>
          )}

          {/* 拉取真实模型清单（runner 代拉该槽位 provider 的 /v1/models） */}
          <div className="flex items-center justify-between">
            <div className="text-xs text-ink-500">
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
              className="flex items-center gap-1 rounded-lg border border-ink-300 px-2.5 py-1 text-xs
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
            <label className="block text-sm font-medium text-ink-700">模型</label>
            <select
              value={shownModel}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full rounded-lg border border-ink-300 bg-paper-50 px-3 py-2 font-mono text-sm
                         focus:border-transparent focus:outline-none focus:ring-2 focus:ring-seal-500"
            >
              {verifiedRecs.length > 0 && (
                <optgroup label={hasFetched ? '推荐（已验证存在）' : '推荐'}>
                  {verifiedRecs.map((m) => (
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
            <div className="rounded-lg border border-ink-200 bg-paper-100/70 p-3 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-ink-600">官方价目</span>
                <span className="text-[11px] font-mono text-ink-400 truncate">{shownModel}</span>
              </div>
              <table className="w-full text-[11px] tabular-nums">
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
              <p className="text-[11px] text-ink-400">
                元 / 百万 tokens · 高峰 = 工作日 9–12 / 14–18 时 · 重写复核命中前缀缓存，输入按缓存价计
              </p>
            </div>
          )}
        </>
      )}

      {/* 推理模式 —— 本槽位的交互式调用：问 AI / 双引擎 / 联网检索 */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-sm font-medium text-ink-700">
          <Brain className="w-3.5 h-3.5 text-violet-500" />
          推理模式
        </label>
        <select
          value={thinking}
          onChange={(e) => onThinkingChange(e.target.value as AISlotThinking)}
          className="w-full rounded-lg border border-ink-300 bg-paper-50 px-3 py-2 text-sm
                     focus:border-transparent focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {SLOT_THINKING_OPTIONS.map((o) => (
            <option key={o.value || 'default'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-ink-400">{thinkingHint}</p>
      </div>
    </div>
  )
}

export default Settings
