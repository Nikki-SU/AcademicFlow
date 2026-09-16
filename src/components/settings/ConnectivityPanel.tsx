/**
 * 服务连通性测试 —— 统一面板
 * -------------------------------------------------
 * 把 GitHub API / AI Provider / MinerU 三个连通性测试集中到一个地方。
 *
 * 三种测试的本质区别：
 *   - GitHub：前端浏览器直连 api.github.com（测网络 + CORS）
 *   - AI：前端 → sync secrets → dispatch GitHub Actions → Runner 真调 chat/completions
 *   - MinerU：前端 JWT 快速校验 + 同上 Runner 端到端
 *
 * 顶部"全部测试"按钮会串行跑完三项（GitHub 是毫秒级，AI/MinerU 各需 1-2 分钟）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2,
  Loader2,
  Wifi,
  WifiOff,
  Zap,
  Cloud,
  Bot,
} from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { useWorkspaceStore } from '../../stores/workspace'
import { testFullGitHubConnectivity, type FullConnectivityReport } from '../../services/github'
import { checkMineruConnectivity, type MineruConnectivityReport } from '../../services/mineruConnectivity'
import { syncAllSecrets } from '../../services/repoSecrets'
import {
  dispatchAiConnectivityTest,
  dispatchMineruTest,
  getLatestRun,
  getRun,
  type RunStatus,
} from '../../services/workflowClient'
import { DEFAULT_WORKSPACE_REPO_NAME } from '../../constants/skeleton'

type WorkflowEventType = 'ai_connectivity_test' | 'mineru_connectivity_test'

// ═════════════════════════════════════════════════════════════════════════
// 共享工具：Runner workflow 触发 + 轮询（AI 和 MinerU 共用这套模式）
// ═════════════════════════════════════════════════════════════════════════

async function runWorkflowE2ETest(
  eventType: WorkflowEventType,
  dispatch: () => Promise<void>,
  owner: string,
  repo: string,
  ghToken: string,
): Promise<RunStatus | null> {
  const beforeRun = await getLatestRun(eventType, owner, repo, ghToken)
  const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

  await dispatch()
  await new Promise((resolve) => setTimeout(resolve, 2500))

  // Phase 1: 找到新 run
  let myRunId: number | null = null
  for (let i = 0; i < 20; i++) {
    const rs = await getLatestRun(eventType, owner, repo, ghToken, beforeCreatedAt)
    if (rs) { myRunId = rs.run_id; break }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  if (!myRunId) return null

  // Phase 2: 固定跟踪这个 run
  for (let i = 0; i < 60; i++) {
    const rs = await getRun(myRunId, owner, repo, ghToken)
    if (!rs) { await new Promise((resolve) => setTimeout(resolve, 1500)); continue }
    if (rs.status === 'completed' || rs.status === 'failure' || rs.status === 'cancelled') return rs
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return await getRun(myRunId, owner, repo, ghToken)
}

// ═════════════════════════════════════════════════════════════════════════
// 主组件
// ═════════════════════════════════════════════════════════════════════════

export default function ConnectivityPanel() {
  const store = useSettingsStore()
  const auth = useAuthStore()
  const ws = useWorkspaceStore()
  const owner = auth.user?.login ?? ''
  const repo = ws.repo?.name ?? DEFAULT_WORKSPACE_REPO_NAME
  const ghToken = auth.token ?? ''

  // ── GitHub 状态 ──
  const [ghTesting, setGhTesting] = useState(false)
  const [ghReport, setGhReport] = useState<FullConnectivityReport | null>(null)

  // ── AI 状态（Runner 端到端） ──
  const [aiTesting, setAiTesting] = useState(false)
  const [aiRun, setAiRun] = useState<RunStatus | null>(null)

  // ── MinerU 状态 ──
  const [mineruReport, setMineruReport] = useState<MineruConnectivityReport | null>(null)
  const [mineruE2ETesting, setMineruE2ETesting] = useState(false)
  const [mineruRun, setMineruRun] = useState<RunStatus | null>(null)

  // ── 全部测试 总开关 ──
  const [allTesting, setAllTesting] = useState(false)

  const mineruToken = store.mineruToken
  const isInitialized = store.isInitialized

  // ═══════ GitHub 测试 ═══════
  const runGitHubTest = useCallback(async () => {
    setGhTesting(true)
    try {
      const r = await testFullGitHubConnectivity()
      setGhReport(r)
    } catch (e: unknown) {
      toast.error(`GitHub 测试失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGhTesting(false)
    }
  }, [])

  // ═══════ Secret 写入（AI + MinerU 端到端测试前都需要） ═══════
  const ensureAllSecrets = useCallback(async (): Promise<boolean> => {
    if (!owner || !repo || !ghToken) return false
    try {
      await syncAllSecrets(owner, repo, ghToken, {
        aiProviderMode: store.aiProviderMode,
        deepseekApiKey: store.deepseekApiKey,
        kimiApiKey: store.kimiApiKey,
        qiniuApiKey: store.qiniuApiKey,
        ai1Model: store.ai1Model,
        ai2Model: store.ai2Model,
        customAi1BaseUrl: store.customAi1BaseUrl,
        customAi1ApiKey: store.customAi1ApiKey,
        customAi1Model: store.customAi1Model,
        customAi2BaseUrl: store.customAi2BaseUrl,
        customAi2ApiKey: store.customAi2ApiKey,
        customAi2Model: store.customAi2Model,
        mineruToken: store.mineruToken,
      })
      return true
    } catch (e: any) {
      toast.error(`写入 secrets 失败：${e?.message || String(e)}`)
      return false
    }
  }, [owner, repo, ghToken, store])

  // ═══════ AI Runner 端到端测试 ═══════
  const runAITest = useCallback(async () => {
    if (!owner || !repo || !ghToken) {
      toast.error('未登录或私库未配置')
      return
    }
    setAiTesting(true)
    setAiRun(null)
    try {
      const secretOk = await ensureAllSecrets()
      if (!secretOk) { setAiTesting(false); return }
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const run = await runWorkflowE2ETest(
        'ai_connectivity_test',
        () => dispatchAiConnectivityTest(owner, repo, ghToken, 'both'),
        owner, repo, ghToken,
      )
      setAiRun(run)
      if (run?.conclusion === 'success') {
        toast.success('AI 端到端测试通过 ✅')
      } else {
        toast.error(`AI 测试失败：${run?.conclusion ?? 'runner 未出现'}`)
      }
    } catch (e: any) {
      toast.error(`AI 测试异常：${e?.message || String(e)}`)
    } finally {
      setAiTesting(false)
    }
  }, [owner, repo, ghToken, ensureAllSecrets])

  // ═══════ MinerU 快速检测（本地 JWT 解析，零网络） ═══════
  const runMineruQuickCheck = useCallback(() => {
    if (!mineruToken.trim()) {
      toast.warning('请先填写 MinerU API Token')
      return
    }
    try {
      const r = checkMineruConnectivity(mineruToken)
      setMineruReport(r)
      if (r.overallOk) toast.success('MinerU Token 有效')
      else toast.warning(`MinerU: ${r.overallMessage}`)
    } catch (e: any) {
      toast.error(`MinerU 检测失败：${e?.message || String(e)}`)
    }
  }, [mineruToken])

  // ═══════ MinerU Runner 端到端测试 ═══════
  const runMineruE2ETest = useCallback(async () => {
    if (!owner || !repo || !ghToken) {
      toast.error('未登录或私库未配置')
      return
    }
    setMineruE2ETesting(true)
    setMineruRun(null)
    try {
      const secretOk = await ensureAllSecrets()
      if (!secretOk) { setMineruE2ETesting(false); return }
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const run = await runWorkflowE2ETest(
        'mineru_connectivity_test',
        () => dispatchMineruTest(owner, repo, ghToken),
        owner, repo, ghToken,
      )
      setMineruRun(run)
      if (run?.conclusion === 'success') {
        toast.success('MinerU 端到端测试通过 ✅')
      } else {
        toast.error(`MinerU 端到端失败：${run?.conclusion ?? 'runner 未出现'}`)
      }
    } catch (e: any) {
      toast.error(`MinerU 测试异常：${e?.message || String(e)}`)
    } finally {
      setMineruE2ETesting(false)
    }
  }, [owner, repo, ghToken, ensureAllSecrets])

  // ═══════ 全部测试 ═══════
  const runAll = useCallback(async () => {
    if (!isInitialized) { toast.warning('等待初始化...'); return }
    setAllTesting(true)
    try {
      toast.info('开始全部测试...')

      // 1. GitHub（前端直连，毫秒级）
      toast.info('① GitHub API...')
      await runGitHubTest()

      // 2. MinerU 快速检测（本地解析 JWT，零网络）
      toast.info('② MinerU Token...')
      runMineruQuickCheck()

      // 3. AI Runner 端到端（最慢，1-2 分钟）
      toast.info('③ AI Provider（Runner 端到端）...')
      await runAITest()

      // 4. MinerU Runner 端到端
      toast.info('④ MinerU（Runner 端到端）...')
      await runMineruE2ETest()

      toast.success('全部测试完成！')
    } finally {
      setAllTesting(false)
    }
  }, [isInitialized, runGitHubTest, runMineruQuickCheck, runAITest, runMineruE2ETest])

  // ── 页面挂载后自动跑一次 GitHub + MinerU 快速检测（毫秒级） ──
  const didAutoRunRef = useRef(false)
  useEffect(() => {
    if (didAutoRunRef.current) return
    didAutoRunRef.current = true
    runGitHubTest()
    if (mineruToken.trim()) runMineruQuickCheck()
  }, [runGitHubTest, runMineruQuickCheck, mineruToken])

  // ═══════ 渲染 ═══════

  // 计算"绿灯"数
  const greenCount = [
    ghReport?.allOk,
    aiRun?.conclusion === 'success',
    mineruReport?.overallOk,
    mineruRun?.conclusion === 'success',
  ].filter(Boolean).length
  const totalTests = 4

  return (
    <div className="space-y-4">
      {/* 顶部：全部测试按钮 + 总体进度 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <button
          type="button"
          onClick={runAll}
          disabled={allTesting || !isInitialized}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-indigo-400 bg-indigo-50 text-indigo-700 rounded-md
                     hover:bg-indigo-100 disabled:text-slate-300 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:border-slate-200"
        >
          {allTesting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Zap className="w-4 h-4" />
          )}
          {allTesting ? '全部测试中...' : '🔌 全部测试'}
        </button>

        <span className="text-xs text-slate-500">
          {greenCount} / {totalTests} 通过
        </span>
      </div>

      {/* ── GitHub API ── */}
      <TestBlock
        icon={<Cloud className="w-4 h-4" />}
        title="GitHub API"
        subtitle="前端直连 api.github.com（Header + Query 两种认证模式）"
        tone={ghReport ? (ghReport.allOk ? 'ok' : 'err') : ghTesting ? 'running' : 'idle'}
        buttonLabel={ghTesting ? '测试中...' : '单独测试'}
        onButton={runGitHubTest}
        buttonDisabled={ghTesting}
      >
        {ghReport && (
          <>
            {/* 两个端点的状态圆点 */}
            <div className="flex items-center gap-4 text-[12px] font-mono">
              <ModeDot label="Header 模式" ok={ghReport.headerModeOk} />
              <ModeDot label="Query 模式" ok={ghReport.queryModeOk} />
            </div>

            {/* 详细行 */}
            <div className="border border-slate-200 rounded-md bg-slate-50 overflow-hidden">
              <div className="divide-y divide-slate-200 text-[11px] font-mono">
                {ghReport.endpoints.map((ep) => (
                  <div key={ep.key} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="w-4 text-center shrink-0">
                      {ep.ok ? <span className="text-green-600">✓</span> : <span className="text-red-600">✗</span>}
                    </span>
                    <span className="text-slate-700 w-40 shrink-0 truncate">{ep.label}</span>
                    <span className="text-slate-400 truncate flex-1 max-w-[180px]">
                      {ep.url.replace('https://', '')}
                    </span>
                    <span className={ep.ok ? 'text-slate-500' : 'text-red-500'}>
                      {ep.ok ? `HTTP ${ep.status}` : ep.error || `HTTP ${ep.status || '—'}`}
                    </span>
                    <span className="text-slate-400 ml-auto tabular-nums">{ep.latencyMs}ms</span>
                  </div>
                ))}
              </div>
              <div className="px-3 py-1.5 bg-white border-t border-slate-200 text-[11px] text-slate-600">
                {ghReport.summary}
              </div>
            </div>
          </>
        )}
      </TestBlock>

      {/* ── AI Provider（Runner 端到端） ── */}
      <TestBlock
        icon={<Bot className="w-4 h-4" />}
        title={`AI Provider（${store.aiProviderMode === 'custom' ? '自定义端点' : '预置'}）`}
        subtitle="sync secrets → GitHub Actions Runner 真调 chat/completions"
        tone={
          aiRun
            ? aiRun.conclusion === 'success' ? 'ok' : 'err'
            : aiTesting ? 'running' : 'idle'
        }
        buttonLabel={aiTesting ? '测试中...' : '端到端测试'}
        onButton={runAITest}
        buttonDisabled={aiTesting || !owner || !repo}
      >
        {aiRun && <RunStatusLink run={aiRun} />}
      </TestBlock>

      {/* ── MinerU ── */}
      <TestBlock
        icon={<Wifi className="w-4 h-4" />}
        title="MinerU（PDF 转换）"
        subtitle="① 快速检测 JWT 是否有效 ② Runner 端到端真调 mineru.net"
        tone={
          mineruE2ETesting ? 'running'
            : mineruRun ? (mineruRun.conclusion === 'success' ? 'ok' : 'err')
            : mineruReport ? (mineruReport.overallOk ? 'ok' : 'err')
            : 'idle'
        }
        buttonLabel={mineruE2ETesting ? '测试中...' : '端到端测试'}
        onButton={runMineruE2ETest}
        buttonDisabled={mineruE2ETesting || !owner || !repo || !mineruToken.trim()}
        extraButton={{ label: '快速检测', onClick: runMineruQuickCheck, disabled: !mineruToken.trim() }}
      >
        {/* Token 快速检测结果 */}
        {mineruReport && (
          <div className={`flex items-start gap-1.5 p-2 rounded-md border text-xs ${
            mineruReport.overallOk
              ? mineruReport.tokenExpiringSoon
                ? 'bg-amber-50 border-amber-200 text-amber-800'
                : 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}>
            {mineruReport.overallOk
              ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 mt-0.5 shrink-0" />
              : <WifiOff className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0" />}
            <div className="flex-1 space-y-1">
              <div>{mineruReport.overallMessage}</div>
              {mineruReport.jwt && !mineruReport.jwt.parseError && (
                <div className="pl-1 text-[11px] text-slate-500">
                  有效期至：<code className="font-mono">
                    {mineruReport.jwt.expiresAt?.toLocaleString()}
                  </code>
                  {mineruReport.jwt.remainingDays !== undefined && (
                    <span className="ml-1">（剩 {mineruReport.jwt.remainingDays} 天）</span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Runner 端到端结果 */}
        {mineruRun && <RunStatusLink run={mineruRun} />}
      </TestBlock>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════
// 子组件
// ═════════════════════════════════════════════════════════════════════════

type BlockTone = 'idle' | 'running' | 'ok' | 'warn' | 'err'

/** 通用测试块 —— 统一的标题/状态条/按钮/内容区 */
function TestBlock(props: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  tone: BlockTone
  buttonLabel: string
  onButton: () => void
  buttonDisabled?: boolean
  extraButton?: { label: string; onClick: () => void; disabled?: boolean }
  children?: React.ReactNode
}) {
  const toneClasses: Record<BlockTone, string> = {
    idle:    'border-slate-200',
    running: 'border-indigo-300 bg-indigo-50/30',
    ok:      'border-green-200 bg-green-50/40',
    warn:    'border-amber-200 bg-amber-50/40',
    err:     'border-red-200 bg-red-50/40',
  }

  const toneBadge: Record<BlockTone, React.ReactNode> = {
    idle:    null,
    running: <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium">测试中</span>,
    ok:      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">✅ 通过</span>,
    warn:    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">⚠️ 警告</span>,
    err:     <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">❌ 失败</span>,
  }

  return (
    <div className={`rounded-md border p-3 space-y-2 ${toneClasses[props.tone]}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-slate-500">{props.icon}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-800">{props.title}</span>
              {toneBadge[props.tone]}
            </div>
            {props.subtitle && (
              <p className="text-[11px] text-slate-500 mt-0.5">{props.subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {props.extraButton && (
            <button
              type="button"
              onClick={props.extraButton.onClick}
              disabled={props.extraButton.disabled}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-slate-300 bg-white
                         hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed"
            >
              {props.extraButton.label}
            </button>
          )}
          <button
            type="button"
            onClick={props.onButton}
            disabled={props.buttonDisabled}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-indigo-300 bg-indigo-50 text-indigo-700
                       hover:bg-indigo-100 disabled:text-slate-300 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:border-slate-200"
          >
            {props.buttonLabel}
          </button>
        </div>
      </div>
      {props.children && <div className="pt-1">{props.children}</div>}
    </div>
  )
}

/** Header 模式 / Query 模式 状态圆点 */
function ModeDot({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={ok ? 'text-green-600' : 'text-red-600'}>{ok ? '●' : '○'}</span>
      <span className={ok ? 'text-slate-700' : 'text-slate-500'}>{label}</span>
    </span>
  )
}

/** GitHub Actions Runner 执行结果链接 */
function RunStatusLink({ run }: { run: RunStatus }) {
  const toneClass =
    run.conclusion === 'success'
      ? 'bg-green-50 border-green-200 text-green-700'
      : run.conclusion
        ? 'bg-red-50 border-red-200 text-red-600'
        : 'bg-blue-50 border-blue-200 text-blue-600'
  return (
    <a
      href={run.html_url}
      target="_blank"
      rel="noreferrer"
      className={`block p-2 rounded-md border text-[11px] ${toneClass}`}
    >
      {run.conclusion === 'success' ? (
        <div className="font-semibold">✓ Runner 端到端测试通过</div>
      ) : run.conclusion ? (
        <div className="font-semibold">✗ Runner 端到端失败：{run.conclusion}</div>
      ) : (
        <div>⏳ Runner 运行中…</div>
      )}
      <div className="opacity-70 mt-0.5">
        run #{run.run_id} · {run.status} · 查看日志 →
      </div>
    </a>
  )
}
