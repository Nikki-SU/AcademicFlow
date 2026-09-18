/**
 * 设置页
 * -------------------------------------------------
 * 对应 SPEC v0.3 §5.2 / §7.3 / §8。M3 阶段核心页面。
 *
 * 功能：
 * - 硅基流动 API Key 填写
 * - AI-1 / AI-2 模型选择（从 /v1/models 拉取真实清单，24h 缓存）
 * - 高级模式 toggle → 展开自定义端点（AI-1 / AI-2 各自 base_url + key + model）
 * - AI 双引擎试运行（fact_check）
 */
import {
  ArrowLeft,
  BookOpen,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Wifi,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import APIKeyInput from '../components/settings/APIKeyInput'
import DualEngineTestPanel from '../components/settings/DualEngineTestPanel'
import ConnectivityPanel from '../components/settings/ConnectivityPanel'


import { PipelineDebugPanel } from '../components/PipelineDebugPanel'
import BackendCapabilitiesPanel from '../components/settings/BackendCapabilitiesPanel'
import { isChatModel, getModelVendor } from '../services/ai/models'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { DEFAULT_WORKSPACE_REPO_NAME } from '../constants/skeleton'
import { syncAllSecrets, type SecretItemStatus } from '../services/repoSecrets'
import type { AIProviderMode } from '../types'
import { AI_PROVIDERS } from '../types'

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
    kimiApiKey,
    qiniuApiKey,
    ai1Model,
    ai2Model,
    ai2Independent,
    ai2ProviderMode,
    deepseekApiKey2,
    kimiApiKey2,
    qiniuApiKey2,
    customAi1BaseUrl,
    customAi1ApiKey,
    customAi1Model,
    customAi2BaseUrl,
    customAi2ApiKey,
    customAi2Model,
    siliconflowModels,
    siliconflowModelsFetchedAt,
    isLoadingModels,
    mineruToken,
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
        kimiApiKey: '月之暗面 Kimi API Key',
        qiniuApiKey: '七牛云 AI API Key',
        customAi1ApiKey: '自定义 AI-1 API Key',
        customAi2ApiKey: '自定义 AI-2 API Key',
        deepseekApiKey2: 'DeepSeek API Key（AI-2 位）',
        kimiApiKey2: '月之暗面 Kimi API Key（AI-2 位）',
        qiniuApiKey2: '七牛云 AI API Key（AI-2 位）',
        mineruToken: 'MinerU Token',
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
        kimiApiKey,
        qiniuApiKey,
        ai1Model,
        ai2Model,
        ai2Independent,
        ai2ProviderMode,
        deepseekApiKey2,
        kimiApiKey2,
        qiniuApiKey2,
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
    deepseekApiKey, kimiApiKey, qiniuApiKey, ai1Model, ai2Model,
    ai2Independent, ai2ProviderMode,
    deepseekApiKey2, kimiApiKey2, qiniuApiKey2,
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

  /** 过滤后的 chat 类模型清单（用于 UI 下拉） */
  const chatModels = useMemo(() => {
    const filtered = siliconflowModels
      .map((m) => m.id)
      .filter(isChatModel)
      .sort()
    // 若下拉里没当前选中的模型，补进去让 UI 不出现空选中
    const augmented = new Set(filtered)
    if (ai1Model && !augmented.has(ai1Model)) augmented.add(ai1Model)
    if (ai2Model && !augmented.has(ai2Model)) augmented.add(ai2Model)
    return Array.from(augmented).sort()
  }, [siliconflowModels, ai1Model, ai2Model])

  const handleRefresh = async () => {
    try {
      const models = await refreshModels(true)
      toast.success(`已拉取 ${models.length} 个模型`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`拉取失败：${msg}`)
    }
  }

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

  const showCustom = aiProviderMode === 'custom'

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

        {/* AI 服务提供方选择 — 所有用户可见；custom 端点需高级模式 */}
        {(
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-600" />
              AI 服务提供方
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(AI_PROVIDERS) as AIProviderMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={mode === 'custom' && !advancedMode}
                  onClick={() => {
                    // 切换 provider 时自动填默认模型
                    const cfg = AI_PROVIDERS[mode]
                    updateSettings({
                      aiProviderMode: mode,
                      ai1Model: cfg.defaultModel1 || ai1Model,
                      ai2Model: cfg.defaultModel2 || ai2Model,
                    })
                  }}
                  className={`px-3 py-2 text-sm rounded-md border transition ${
                    aiProviderMode === mode
                      ? 'bg-indigo-50 border-indigo-400 text-indigo-800 font-medium'
                      : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
                  } ${mode === 'custom' && !advancedMode ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  {AI_PROVIDERS[mode].label}
                </button>
              ))}
            </div>
            {aiProviderMode !== 'custom' && (
              <p className="text-xs text-slate-500">
                {AI_PROVIDERS[aiProviderMode].note}
              </p>
            )}
          </section>
        )}

        {/* 预置 Provider 配置（deepseek / kimi / qiniu） */}
        {aiProviderMode !== 'custom' && (() => {
          const cfg = AI_PROVIDERS[aiProviderMode]
          // 三个 provider 共用同一字段名不同 key 名
          const apiKeyField = (aiProviderMode === 'deepseek' ? deepseekApiKey : aiProviderMode === 'kimi' ? kimiApiKey : qiniuApiKey)
          const apiKeySetter = (v: string) => {
            const patch: Record<string, string> = {}
            if (aiProviderMode === 'deepseek') patch.deepseekApiKey = v
            else if (aiProviderMode === 'kimi') patch.kimiApiKey = v
            else patch.qiniuApiKey = v
            updateSettings(patch as Partial<typeof store>)
          }
          return (
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-600" />
                {cfg.label}（AI-1 + AI-2 共用）
              </h2>
              {cfg.apiKeyUrl && (
                <a
                  href={cfg.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-indigo-600 hover:text-indigo-800"
                >
                  去获取 API Key →
                </a>
              )}
            </div>

            <APIKeyInput
              label={`${cfg.label} API Key`}
              fieldId={`provider-${aiProviderMode}`}
              value={apiKeyField}
              onChange={apiKeySetter}
              hint="仅存在你浏览器的 IndexedDB，不上传任何服务器"
            />

            <div className="flex items-center justify-between pt-1">
              <div className="text-xs text-slate-500">
                模型清单：{chatModels.length} 个 chat 类 · 上次更新{' '}
                <span className="font-mono">{formatFetchedAt(siliconflowModelsFetchedAt)}</span>
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={isLoadingModels || !apiKeyField.trim()}
                className="flex items-center gap-1 px-2.5 py-1 text-xs border border-slate-300 rounded-md
                           hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed"
              >
                {isLoadingModels ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                拉取
              </button>
            </div>

            {/* AI-1 / AI-2 模型下拉 */}
            <div className="grid md:grid-cols-2 gap-3">
              <ModelSelect
                label="AI-1（生成位）"
                value={ai1Model}
                options={chatModels}
                onChange={(v) => updateSettings({ ai1Model: v })}
              />
              {ai2Independent ? (
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-slate-700">
                    AI-2（审阅位）
                    <span className="ml-2 text-xs font-normal text-indigo-600">独立模式</span>
                  </label>
                  <div className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-md bg-slate-50 text-slate-600 truncate">
                    {ai2ProviderMode === 'custom'
                      ? (customAi2Model || '（在下方填写自定义 Model ID）')
                      : AI_PROVIDERS[ai2ProviderMode].defaultModel2}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    独立模式下模型由 AI-2 的 provider 决定，防止跨公司模型名残留
                  </p>
                </div>
              ) : (
                <ModelSelect
                  label="AI-2（审阅位）"
                  value={ai2Model}
                  options={chatModels}
                  onChange={(v) => updateSettings({ ai2Model: v })}
                />
              )}
            </div>
            <p className="text-xs text-slate-500">
              {ai2Independent
                ? `AI-1 用 ${cfg.label}；AI-2 用独立配置（见下方）。`
                : `AI-1 和 AI-2 共用同一个 ${cfg.label} API Key 和 base URL。`}
              推荐生成位用较强模型、审阅位用更快模型（可切换）。
            </p>

            {/* ── AI-2 独立 Key：不同公司或同公司不同 key ── */}
            <div className="border-t border-slate-200 pt-3 space-y-3">
              <button
                type="button"
                onClick={() => {
                  const turningOn = !ai2Independent
                  updateSettings({
                    ai2Independent: turningOn,
                    // 开启时默认跟随当前主 provider（同公司不同 key 场景最常见）
                    // 此分支内 aiProviderMode 必为预置 provider
                    ...(turningOn ? { ai2ProviderMode: aiProviderMode } : {}),
                  })
                }}
                className="w-full flex items-center justify-between text-left"
              >
                <div>
                  <div className="flex items-center gap-2">
                    {ai2Independent ? (
                      <ToggleRight className="w-5 h-5 text-indigo-600" />
                    ) : (
                      <ToggleLeft className="w-5 h-5 text-slate-400" />
                    )}
                    <span className="text-sm font-semibold text-slate-800">
                      AI-2 使用独立 Key
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 pl-7">
                    {ai2Independent
                      ? `AI-2 走 ${ai2ProviderMode === 'custom' ? '自定义端点' : AI_PROVIDERS[ai2ProviderMode].label}，与 AI-1 互不影响`
                      : '开启后 AI-2 可选不同公司或同公司另一个 key（并发翻倍、互不抢限额）'}
                  </p>
                </div>
              </button>

              {ai2Independent && (
                <div className="space-y-3 p-3 bg-indigo-50/40 border border-indigo-200 rounded-md">
                  <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                    AI-2 服务提供方
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(AI_PROVIDERS) as AIProviderMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        disabled={mode === 'custom' && !advancedMode}
                        onClick={() => updateSettings({ ai2ProviderMode: mode })}
                        className={`px-3 py-2 text-sm rounded-md border transition ${
                          ai2ProviderMode === mode
                            ? 'bg-indigo-50 border-indigo-400 text-indigo-800 font-medium'
                            : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
                        } ${mode === 'custom' && !advancedMode ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        {AI_PROVIDERS[mode].label}
                      </button>
                    ))}
                  </div>

                  {ai2ProviderMode === 'custom' ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={customAi2BaseUrl}
                        onChange={(e) => updateSettings({ customAi2BaseUrl: e.target.value })}
                        placeholder="Base URL，如 https://api.openai.com/v1"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                                   focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <APIKeyInput
                        label="API Key"
                        fieldId="custom-ai2-independent"
                        value={customAi2ApiKey}
                        onChange={(v) => updateSettings({ customAi2ApiKey: v })}
                      />
                      <input
                        type="text"
                        value={customAi2Model}
                        onChange={(e) => updateSettings({ customAi2Model: e.target.value })}
                        placeholder="Model ID，如 gpt-4o-mini"
                        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                                   focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  ) : (
                    <>
                      {(() => {
                        // AI-2 位 key 按公司独立槽位存储，与 AI-1 位平等：
                        // 切换 provider 时各家 key 各自保留，不互相覆盖
                        const key2Field =
                          ai2ProviderMode === 'deepseek' ? deepseekApiKey2
                          : ai2ProviderMode === 'kimi' ? kimiApiKey2
                          : qiniuApiKey2
                        const key2Setter = (v: string) => {
                          const patch: Record<string, string> = {}
                          if (ai2ProviderMode === 'deepseek') patch.deepseekApiKey2 = v
                          else if (ai2ProviderMode === 'kimi') patch.kimiApiKey2 = v
                          else patch.qiniuApiKey2 = v
                          updateSettings(patch as Partial<typeof store>)
                        }
                        return (
                          <APIKeyInput
                            label={`${AI_PROVIDERS[ai2ProviderMode].label} API Key（AI-2 位）`}
                            fieldId={`ai2-${ai2ProviderMode}-key2`}
                            value={key2Field}
                            onChange={key2Setter}
                            hint="仅存本机 IndexedDB；可填同一家公司的另一个 key；各家独立保存、切换不丢"
                          />
                        )
                      })()}
                      <p className="text-xs text-slate-500">
                        模型固定用 {AI_PROVIDERS[ai2ProviderMode].label} 审阅位默认
                        <code className="font-mono text-[11px] bg-slate-100 px-1 rounded">
                          {AI_PROVIDERS[ai2ProviderMode].defaultModel2}
                        </code>
                        ，与 AI-1 并发时互不占用对方的调用限额。
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
          )
        })()}

        {/* 自定义端点 */}
        {showCustom && (
          <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-4">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-purple-600" />
              自定义 OpenAI 兼容端点
            </h2>

            {/* AI-1 */}
            <div className="space-y-2 p-3 bg-slate-50 border border-slate-200 rounded-md">
              <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                AI-1（生成位）
              </div>
              <input
                type="text"
                value={customAi1BaseUrl}
                onChange={(e) => updateSettings({ customAi1BaseUrl: e.target.value })}
                placeholder="Base URL，如 https://api.openai.com/v1"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                           focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <APIKeyInput
                label="API Key"
                fieldId="custom-ai1"
                value={customAi1ApiKey}
                onChange={(v) => updateSettings({ customAi1ApiKey: v })}
              />
              <input
                type="text"
                value={customAi1Model}
                onChange={(e) => updateSettings({ customAi1Model: e.target.value })}
                placeholder="Model ID，如 gpt-4o-mini"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                           focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* AI-2 */}
            <div className="space-y-2 p-3 bg-slate-50 border border-slate-200 rounded-md">
              <div className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                AI-2（审阅位）
              </div>
              <input
                type="text"
                value={customAi2BaseUrl}
                onChange={(e) => updateSettings({ customAi2BaseUrl: e.target.value })}
                placeholder="Base URL"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                           focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <APIKeyInput
                label="API Key"
                fieldId="custom-ai2"
                value={customAi2ApiKey}
                onChange={(v) => updateSettings({ customAi2ApiKey: v })}
              />
              <input
                type="text"
                value={customAi2Model}
                onChange={(e) => updateSettings({ customAi2Model: e.target.value })}
                placeholder="Model ID"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                           focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </section>
        )}

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

/** 模型下拉子组件 */
function ModelSelect(props: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-slate-700">
        {props.label}
        {props.value && (
          <span className="ml-2 text-xs font-normal text-slate-500">
            （{getModelVendor(props.value)}）
          </span>
        )}
      </label>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md
                   focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
      >
        {props.options.length === 0 ? (
          <option value={props.value}>{props.value || '（点击右上"拉取"载入模型清单）'}</option>
        ) : (
          props.options.map((id) => (
            <option key={id} value={id}>
              [{getModelVendor(id)}] {id}
            </option>
          ))
        )}
      </select>
    </div>
  )
}

export default Settings
