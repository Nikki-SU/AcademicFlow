/**
 * 设置页
 * -------------------------------------------------
 * 对应 SPEC v0.3 §5.2 / §7.3 / §8。
 *
 * 功能：
 * - AI-1（生成位）/ AI-2（审阅位）两块完全对称的配置界面：
 *   各自选 Provider、各自填 API Key（按公司独立槽位）、各自选模型
 * - 高级模式 → 每端可切自定义 OpenAI 兼容端点
 * - AI 双引擎试运行（fact_check）
 */
import {
  ArrowLeft,
  BookOpen,
  Brain,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wifi,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
import { syncAllSecrets, type SecretItemStatus } from '../services/repoSecrets'
import type { AIProviderMode, AIThinkingMode, AISlotThinking } from '../types'
import { AI_PROVIDERS } from '../types'

/**
 * 槽位级推理模式选项 —— 多一个「不干预」。
 * 为什么要有「不干预」：AI-1 / AI-2 的交互式调用（问 AI、双引擎、检索）加这个开关
 * 之前从来不发 thinking 参数，默认必须是「什么都不发」，否则等于替用户改了一次行为。
 */
const SLOT_THINKING_OPTIONS: {
  value: AISlotThinking
  label: string
  hint: string
}[] = [
  { value: '', label: '不干预（模型默认）', hint: '不发送 thinking 参数，行为与之前完全一致' },
  { value: 'off', label: '关闭思考', hint: '强制关闭 reasoning，输出预算全部留给正文（省钱）' },
  { value: 'low', label: '开启 · 低强度', hint: '开启思考，reasoning_effort=low' },
  { value: 'high', label: '开启 · 高强度', hint: '开启思考，reasoning_effort=high' },
  { value: 'max', label: '开启 · 最高强度', hint: '开启思考，reasoning_effort=max（最慢最贵）' },
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
  { field: 'thinkingClean', label: '清理正文', desc: '去页眉页脚、拼回断段，纯搬运 → 建议关闭' },
  { field: 'thinkingTag', label: '打标', desc: '判断标题/图注/列表类型，规则明确 → 建议关闭' },
  { field: 'thinkingTranslate', label: '翻译', desc: '逐段与表格翻译，不需要推理 → 建议关闭' },
  { field: 'thinkingWords', label: '提词核验', desc: '筛选学术词汇，机械筛选 → 建议关闭（要更保守可手动开启）' },
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
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-600">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50">
      {/* 顶栏 */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-indigo-100 rounded-md">
              <BookOpen className="w-5 h-5 text-indigo-600" />
            </div>
            <span className="font-bold text-slate-800">AcademicFlow</span>
            <span className="text-slate-300">/</span>
            <span className="text-sm text-slate-600 flex items-center gap-1">
              <SettingsIcon className="w-4 h-4" />
              设置
            </span>
          </div>
          <Link
            to="/tracking"
            className="flex items-center gap-1 px-2.5 py-1.5 text-sm text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
          >
            <ArrowLeft className="w-4 h-4" />
            返回追踪页
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-5">
        {/* 高级模式 toggle */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <button
            type="button"
            onClick={() => updateSettings({ advancedMode: !advancedMode })}
            className="w-full flex items-center justify-between text-left"
          >
            <div>
              <div className="flex items-center gap-2 mb-1">
                {advancedMode ? (
                  <ToggleRight className="w-6 h-6 text-indigo-600" />
                ) : (
                  <ToggleLeft className="w-6 h-6 text-slate-400" />
                )}
                <span className="font-semibold text-slate-800">高级模式</span>
              </div>
              <p className="text-xs text-slate-500 pl-8">
                {advancedMode
                  ? '已解锁自定义 OpenAI 兼容端点 + MinerU / 词典高级选项'
                  : '选择预置 Provider 直接用，或开启高级模式用自定义端点'}
              </p>
            </div>
          </button>
        </section>

        {/* ── AI-1（生成位）—— 与 AI-2 完全对称 ── */}
        <AISlotSection
          slot={1}
          title="AI-1（生成位）"
          desc="生成类任务：清理、打标、单词提取"
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

        {/* ── AI-2（审阅位）—— 与 AI-1 完全对称 ── */}
        <AISlotSection
          slot={2}
          title="AI-2（审阅位）"
          desc="审阅类任务：翻译、核验"
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

        {/* 思考模式（reasoning）—— 按阶段控制 */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Brain className="w-4 h-4 text-violet-600" />
            思考模式（reasoning）
          </h2>
          <p className="text-xs text-slate-500">
            推理模型<b>默认开启思考</b>，而思考内容与正文<b>共用同一个输出预算</b>，且按输出价计费（约为输入价的 4 倍）。
            实测思考可吃掉约 8 成预算，导致正文被截断成空。清理 / 打标 / 翻译都是机械任务，
            建议关闭——预算全部留给正文，同时显著省钱。
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {THINKING_ROWS.map(({ field, label, desc }) => (
              <div key={field} className="space-y-1">
                <label className="block text-sm font-medium text-slate-700">{label}</label>
                <select
                  value={store[field]}
                  onChange={(e) =>
                    store.updateSettings({ [field]: e.target.value as AIThinkingMode })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  {THINKING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-400">{desc}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400">
            保存后写入私库 <code className="font-mono">settings/global.md</code>，Runner 读取后按阶段拼进请求体，无需重新同步 Secrets。
            本段只管文献处理管线的四个阶段；阅读页问 AI / 双引擎 / 联网检索走上面各槽位自己的「推理模式」。
          </p>
        </section>

        {/* 双引擎试运行 */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-green-600" />
            双引擎试运行（fact_check）
          </h2>
          <p className="text-xs text-slate-500">
            用当前配置跑一次事实核查任务，验证 AI-1 生成 + AI-2 审阅链路。
          </p>
          <DualEngineTestPanel />
        </section>

        {/* 服务连通性测试 —— 统一面板：GitHub + AI + MinerU */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Wifi className="w-4 h-4 text-indigo-600" />
            服务连通性测试
          </h2>
          <p className="text-xs text-slate-500">
            GitHub API（前端直连）、AI Provider（Runner 端到端）、MinerU（快速 JWT + Runner 端到端）。
            点"全部测试"串行跑完三项，或各自点独立按钮。Runner 端到端测试各需 1-2 分钟。
          </p>
          <ConnectivityPanel />
        </section>

        {/* 后端处理能力（GitHub Actions） */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-cyan-600" />
            后端处理能力（GitHub Actions）
          </h2>

          <BackendCapabilitiesPanel />

          {/* MinerU API Token — PDF 转换必需（后端 pipeline 从 GitHub Secrets 取） */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-700">
              MinerU API Token
              <span className="ml-1 text-xs text-orange-600">*</span>
            </label>
            <p className="text-xs text-slate-500">
              PDF → Markdown 转换必需。在 <a href="https://op.mineru.ai" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">MinerU 用户中心</a> 生成 API token。
              填入后会自动同步到 GitHub Actions Secrets（MINERU_API_TOKEN）。
            </p>
            <input
              type="password"
              placeholder="eyJ...（MinerU JWT token）"
              value={mineruToken}
              onChange={(e) => updateSettings({ mineruToken: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
          </div>

          {/* SimpleTex 令牌 — 「识图输入公式」用（不走浏览器直连，随识图请求传给 runner） */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-700">SimpleTex 令牌（公式识图）</label>
            <p className="text-xs text-slate-500">
              写作页「公式 → 识图输入公式」用它把图片转成 LaTeX。在{' '}
              <a href="https://simpletex.cn/user/center" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                SimpleTex 用户中心
              </a>{' '}
              创建「用户授权令牌（UAT）」填到第一栏即可；要用 APP 鉴权则填 APP ID + APP Secret。
              浏览器直连 SimpleTex 会被对方 CORS 拦，所以识图改由 GitHub Actions 后端完成：
              令牌只存在本机，识图时随该次请求传给 runner，用完即弃，不写进私库文件。
            </p>
            <input
              type="password"
              placeholder="UAT 或 APP ID"
              value={simpletexToken}
              onChange={(e) => updateSettings({ simpletexToken: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
            <input
              type="password"
              placeholder="APP Secret（只有 APP 鉴权才需要，UAT 请留空）"
              value={simpletexSecret}
              onChange={(e) => updateSettings({ simpletexSecret: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
          </div>

          {/* Secrets 同步明细 —— 每条都亮出来，拒绝黑箱 */}
          <div className="mt-3 border border-slate-200 rounded-md bg-slate-50 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 bg-slate-100 border-b border-slate-200 text-xs">
              <span className="font-medium text-slate-700">
                Secrets 同步状态（写入 <code className="font-mono text-[11px] bg-slate-200 px-1 rounded">{owner}/{repoName}</code>）
              </span>
              <button
                type="button"
                onClick={runSync}
                disabled={secretSyncing}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] border border-slate-300 rounded bg-white hover:bg-slate-50 disabled:text-slate-400"
              >
                {secretSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                手动同步
              </button>
            </div>
            {secretItems.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-400">等待首次同步…</div>
            ) : (
              <div className="divide-y divide-slate-200 text-[11px] font-mono">
                {secretItems.map((it) => {
                  // 状态图标 + 颜色
                  const isSkipped = !it.valueWanted && it.putStatus === 0
                  const isFailed = !it.putOk
                  const isDelayed = it.putOk && it.valueWanted && !it.verified

                  let icon: string, color: string, label: string
                  if (isSkipped) { icon = '—'; color = 'text-slate-400'; label = '未填写（跳过）' }
                  else if (isFailed) { icon = '✗'; color = 'text-red-600'; label = it.error || `PUT 失败 HTTP ${it.putStatus}` }
                  else if (isDelayed) {
                    icon = '⏳'; color = 'text-amber-600'
                    // 已重试 4 次指数退避后仍未命中 —— GitHub 可能还在索引长值 secret
                    // 实际上 PUT 已成功（201/204），只是 secrets 列表还没列出来；
                    // workflow 运行时 GitHub Actions 通常能直接读到值
                    label = it.error || 'GitHub 回查未命中（已重试多次，PUT 实际成功）'
                  }
                  else { icon = '✓'; color = 'text-green-600'; label = '已写入 + 已回查确认' }

                  // 简短的 value 预览（前 8 字符 + ...）
                  const valPreview = isSkipped ? '' : (() => {
                    const v = it.valueWanted
                    if (!v) return ''
                    if (v.length <= 12) return v
                    return v.slice(0, 8) + '…' + v.slice(-4)
                  })()

                  return (
                    <div key={it.name} className="flex items-center gap-2 px-3 py-1.5">
                      <span className={`${color} w-4 text-center shrink-0`}>{icon}</span>
                      <span className="text-slate-700 w-40 shrink-0 truncate" title={it.name}>{it.name}</span>
                      {valPreview && (
                        <span className="text-slate-400 truncate flex-1 max-w-[200px]" title={it.valueWanted}>
                          {valPreview}
                        </span>
                      )}
                      <span className={`${color} ml-auto truncate max-w-[260px]`}>{label}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-600" />
            后置任务设置（PDF 转换后自动执行）
          </h2>
          <p className="text-xs text-slate-500">
            PDF 转换成功后，自动调用 AI-2 生成全文翻译、AI-1 提取核心单词。翻译保存为 translation.md，
            单词合并到全局词汇表。单词数量越多耗时越长、token 越多。
          </p>
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium text-slate-700 whitespace-nowrap">单词生成数量</label>
            <input
              type="range"
              min={10}
              max={50}
              step={1}
              value={store.wordGenCount ?? 15}
              onChange={(e) => store.updateSettings({ wordGenCount: parseInt(e.target.value, 10) })}
              className="flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
            />
            <span className="text-sm font-semibold text-indigo-600 w-12 text-center">
              {store.wordGenCount ?? 15}
            </span>
          </div>
          <p className="text-xs text-slate-400 pl-14">范围 10-50，默认 15。例句必须逐字来自原文献。</p>
        </section>

        {/* PDF 清理（转换成功后的 PDF 体积大且无法检索，可批量清掉） */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-red-600" />
            清理已转换文献的 PDF
          </h2>
          <p className="text-xs text-slate-500">
            PDF 体积大且无法检索，转换成功后就没用了（正文已落成 MinerU 的 full.md，图片在 images/）。
            只列出<b>转换成功</b>的文献，可全选或部分选择。md、图片、词汇表不受影响。
          </p>
          <PdfCleanupPanel />
        </section>

        {/* 调试看板 */}
        <section className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-3">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <span>🔧</span> Pipeline 调试看板
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              查看每次 PDF 转换的完整链路：每步 Prompt / 输入 / AI 输出 / 耗时
            </p>
          </div>
          <PipelineDebugPanel />
        </section>

        <div className="text-center text-xs text-slate-400 pt-4">
          所有凭据仅存本机 IndexedDB · License AGPL-3.0-or-later · Stage M3
        </div>
      </main>
    </div>
  )
}

/** AI 槽位配置卡片 —— AI-1（生成位）/ AI-2（审阅位）共用同一组件，保证界面完全对称。
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

  // 已拉取且存储的模型被证实不存在 → 自动纠正（防止 secrets 同步把死模型带给 runner）
  useEffect(() => {
    if (isCustom || !hasFetched || !model) return
    if (!fetchedSet.has(model) && fallbackModel && fallbackModel !== model) {
      onModelChange(fallbackModel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustom, hasFetched, model, fallbackModel])

  return (
    <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-600" />
            {title}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
        </div>
        {!isCustom && cfg.apiKeyUrl && (
          <a
            href={cfg.apiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
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
            className={`px-3 py-2 text-sm rounded-md border transition ${
              providerMode === mode
                ? 'bg-indigo-50 border-indigo-400 text-indigo-800 font-medium'
                : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
            } ${mode === 'custom' && !advancedMode ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            {AI_PROVIDERS[mode].label}
          </button>
        ))}
      </div>
      {!isCustom && (
        <p className="text-xs text-slate-500">{cfg.note}</p>
      )}

      {isCustom ? (
        <div className="space-y-2 p-3 bg-slate-50 border border-slate-200 rounded-md">
          <input
            type="text"
            value={customBaseUrl}
            onChange={(e) => onCustomBaseUrlChange(e.target.value)}
            placeholder="Base URL，如 https://api.openai.com/v1"
            className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                       focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
            className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                       focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      ) : (
        <>
          <APIKeyInput
            label={`${cfg.label} API Key（AI-${slot} 位）`}
            fieldId={`ai${slot}-${providerMode}`}
            value={apiKey}
            onChange={onApiKeyChange}
            hint="仅存本机 IndexedDB，不上传任何服务器；各家 key 独立保存、切换不丢"
          />
          {fallbackKeyNote && (
            <p className="text-xs text-amber-600 -mt-2">{fallbackKeyNote}</p>
          )}

          {/* 拉取真实模型清单（runner 代拉该槽位 provider 的 /v1/models） */}
          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-500">
              真实清单：
              {hasFetched
                ? `${fetchedModels.length} 个 chat 类`
                : fetchedModels.length > 0
                  ? '已切换 Provider，旧清单不适用'
                  : '未拉取'}
              {' '}· 上次更新 <span className="font-mono">{formatFetchedAt(fetchedAt)}</span>
            </div>
            <button
              type="button"
              onClick={onFetch}
              disabled={isFetching || !canFetch}
              className="flex items-center gap-1 px-2.5 py-1 text-xs border border-slate-300 rounded-md
                         hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed"
            >
              {isFetching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              拉取
            </button>
          </div>
          {!canFetch && (
            <p className="text-[11px] text-slate-400 -mt-2">
              填好 API Key 后可拉取该 Provider 的完整模型清单
            </p>
          )}

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">模型</label>
            <select
              value={shownModel}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                         focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
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
            <p className="text-[11px] text-slate-400">
              {hasFetched
                ? '推荐已按真实清单过滤，不存在的模型不会再出现'
                : '选「拉取」验证后，只显示真实存在的模型'}
            </p>
          </div>
        </>
      )}

      {/* 推理模式（reasoning）—— 本槽位的交互式调用：问 AI / 双引擎 / 联网检索 */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
          <Brain className="w-3.5 h-3.5 text-violet-500" />
          推理模式
        </label>
        <select
          value={thinking}
          onChange={(e) => onThinkingChange(e.target.value as AISlotThinking)}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent bg-white"
        >
          {SLOT_THINKING_OPTIONS.map((o) => (
            <option key={o.value || 'default'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-slate-400">{thinkingHint}</p>
      </div>
    </section>
  )
}

export default Settings
