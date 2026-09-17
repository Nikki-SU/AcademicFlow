/**
 * 服务连通性测试 —— 统一面板
 * -------------------------------------------------
 * 三种测试:
 *   - GitHub: 前端直连 api.github.com (Header + Query 两种模式)
 *   - AI: sync secrets → dispatch → Runner 端到端真调 chat/completions
 *   - MinerU: sync secrets → dispatch → Runner 端到端真调 mineru.net
 *
 * 每个测试块底部有步骤时间线 (StepTimeline),
 * 实时显示每个阶段是 pending / running / done / error,
 * 一眼看出卡在哪一步。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Loader2,
  Wifi,
  Zap,
  Cloud,
  Bot,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
} from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { testFullGitHubConnectivity, type FullConnectivityReport } from '../../services/github'
import { syncAllSecrets } from '../../services/repoSecrets'
import {
  dispatchAiConnectivityTest,
  dispatchMineruConnectivityTest,
  getLatestRun,
  getRun,
  type RunStatus,
  type WorkflowEvent,
} from '../../services/workflowClient'
import { DEFAULT_WORKSPACE_REPO_NAME } from '../../constants/skeleton'

// ═════════════════════════════════════════════════════════════════════════
// 步骤状态 + 结果类型
// ═════════════════════════════════════════════════════════════════════════

export type StepStatus = 'pending' | 'running' | 'done' | 'error'

export interface Step {
  key: string
  label: string
  status: StepStatus
  detail?: string  // 可选:run id / 耗时 / 错误信息
}

type RunnerTestResult =
  | { ok: true; run: RunStatus }
  | { ok: false; run: RunStatus; reason?: string }
  | { ok: false; run: null; reason: string }

// Runner 测试的 4 个固定步骤
const RUNNER_STEP_DEFS: { key: string; label: string }[] = [
  { key: 'secrets',   label: 'Sync secrets → 私库' },
  { key: 'dispatch',  label: 'Dispatch workflow' },
  { key: 'find_run',  label: '等待 Runner 出现' },
  { key: 'run',       label: 'Runner 执行' },
]

// GitHub 测试的 2 个步骤
const GITHUB_STEP_DEFS: { key: string; label: string }[] = [
  { key: 'header', label: 'Header 模式 (Authorization: token xxx)' },
  { key: 'query',  label: 'Query 模式 (?access_token=xxx)' },
]

// ═════════════════════════════════════════════════════════════════════════
// 共享工具:dispatch + 轮询 (接受 setSteps 回调来实时更新步骤状态)
// ═════════════════════════════════════════════════════════════════════════

type SetRunnerSteps = (updater: (prev: Step[]) => Step[]) => void

async function runWorkflowE2ETest(
  eventType: WorkflowEvent,
  dispatch: () => Promise<void>,
  owner: string,
  repo: string,
  ghToken: string,
  setSteps: SetRunnerSteps,
): Promise<RunnerTestResult> {
  const tag = `[ConnectivityPanel ${eventType}]`
  const mkSteps = (statuses: Record<string, StepStatus>, detail?: Partial<Record<string, string>>): Step[] =>
    RUNNER_STEP_DEFS.map((s) => ({
      key: s.key,
      label: s.label,
      status: statuses[s.key] ?? 'pending',
      detail: detail?.[s.key],
    }))

  // 初始:secrets = running,其他 pending
  setSteps(() => mkSteps({ secrets: 'running' }))

  // 0. sync secrets 由调用方做,这里只负责后面 3 步
  //    (调用方在调 runWorkflowE2ETest 之前已经做完 secrets 了,
  //     所以 secrets 步骤的 done/error 也由调用方 set)

  // 1. dispatch
  setSteps(() => mkSteps({ dispatch: 'running' }))
  try {
    await dispatch()
    console.log(`${tag} dispatch 成功`)
    setSteps(() => mkSteps({ dispatch: 'done' }))
  } catch (e: any) {
    const msg = e?.message || String(e)
    console.error(`${tag} dispatch 失败:`, e)
    setSteps(() => mkSteps({ dispatch: 'error' }, { dispatch: msg }))
    return { ok: false, run: null, reason: `dispatch 失败: ${msg}` }
  }

  console.log(`${tag} 等 2.5s 让 GitHub 创建 run...`)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  // 2. Phase 1: 找新 run
  setSteps(() => mkSteps({ find_run: 'running' }))

  const beforeRun = await getLatestRun(eventType, owner, repo, ghToken)
  const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

  let myRunId: number | null = null
  for (let i = 0; i < 20; i++) {
    const rs = await getLatestRun(eventType, owner, repo, ghToken, beforeCreatedAt)
    if (rs) {
      myRunId = rs.id
      console.log(`${tag} ✅ Phase 1[${i+1}/20] 找到新 run id=${rs.id} created=${rs.created_at}`)
      setSteps(() => mkSteps(
        { find_run: 'done', run: 'running' },
        { find_run: `run #${rs.id}` },
      ))
      break
    }
    console.log(`${tag} Phase 1[${i+1}/20] 没找到,再等 1.5s...`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  if (!myRunId) {
    console.error(`${tag} ❌ 30s 内没找到新 run`)
    setSteps(() => mkSteps({ find_run: 'error' }, {
      find_run: '30s 内没创建 run · 可能 repo 不对或 Actions 排队',
    }))
    return {
      ok: false, run: null,
      reason: `GitHub Actions 30s 内没创建新 run。可能原因: dispatch 打到了错误的 repo (当前目标 ${owner}/${repo}), 或 workflow yml 不在 .github/workflows/ 里, 或 Actions 排队超过 30s。`,
    }
  }

  // 3. Phase 2: 固定跟踪这个 run
  let finalRun: RunStatus | null = null
  for (let i = 0; i < 60; i++) {
    const rs = await getRun(myRunId, owner, repo, ghToken)
    if (!rs) {
      console.log(`${tag} Phase 2[${i+1}/60] getRun 返回 null (404? id=${myRunId})`)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      continue
    }
    finalRun = rs
    console.log(`${tag} Phase 2[${i+1}/60] run id=${rs.id} status=${rs.status} conclusion=${rs.conclusion ?? '-'}`)
    if (rs.status === 'completed' || rs.status === 'failure' || rs.status === 'cancelled') break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  if (!finalRun) {
    setSteps(() => mkSteps({ run: 'error' }, { run: '120s 内没结束' }))
    return { ok: false, run: null, reason: `run id=${myRunId} 120s 内没结束` }
  }

  if (finalRun.conclusion === 'success') {
    console.log(`${tag} ✅ 成功! run id=${finalRun.id}`)
    setSteps(() => mkSteps(
      { run: 'done' },
      { run: `run #${finalRun.id} success` },
    ))
    return { ok: true, run: finalRun }
  }

  console.log(`${tag} ❌ conclusion=${finalRun.conclusion}`)
  setSteps(() => mkSteps(
    { run: 'error' },
    { run: `conclusion: ${finalRun.conclusion}` },
  ))
  return { ok: false, run: finalRun, reason: finalRun.conclusion ?? 'unknown' }
}

// ═════════════════════════════════════════════════════════════════════════
// 主组件
// ═════════════════════════════════════════════════════════════════════════

export default function ConnectivityPanel() {
  const store = useSettingsStore()
  const auth = useAuthStore()
  const owner = auth.user?.login ?? ''
  const repo = DEFAULT_WORKSPACE_REPO_NAME
  const ghToken = auth.token ?? ''

  // ── GitHub 步骤 + 结果 ──
  const [ghTesting, setGhTesting] = useState(false)
  const [ghSteps, setGhSteps] = useState<Step[]>(
    GITHUB_STEP_DEFS.map((s) => ({ ...s, status: 'pending' as StepStatus })),
  )
  const [ghReport, setGhReport] = useState<FullConnectivityReport | null>(null)

  // ── AI Runner 步骤 + 结果 ──
  const [aiTesting, setAiTesting] = useState(false)
  const [aiSteps, setAiSteps] = useState<Step[]>(
    RUNNER_STEP_DEFS.map((s) => ({ ...s, status: 'pending' as StepStatus })),
  )
  const [aiResult, setAiResult] = useState<RunnerTestResult | null>(null)

  // ── MinerU Runner 步骤 + 结果 ──
  const [mineruTesting, setMineruTesting] = useState(false)
  const [mineruSteps, setMineruSteps] = useState<Step[]>(
    RUNNER_STEP_DEFS.map((s) => ({ ...s, status: 'pending' as StepStatus })),
  )
  const [mineruResult, setMineruResult] = useState<RunnerTestResult | null>(null)

  const [allTesting, setAllTesting] = useState(false)

  const mineruToken = store.mineruToken
  const isInitialized = store.isInitialized

  // ═══════ GitHub 测试 ═══════
  const runGitHubTest = useCallback(async () => {
    setGhTesting(true)
    // reset + 开始
    setGhSteps(GITHUB_STEP_DEFS.map((s) => ({ ...s, status: 'pending' as StepStatus })))
    try {
      // 我们没 access 到 testFullGitHubConnectivity 的内部,
      // 但可以在外面根据 report 来设状态
      const r = await testFullGitHubConnectivity()
      setGhSteps((prev) => prev.map((s) => {
        const ep = r.endpoints.find((e) =>
          (s.key === 'header' && e.key.includes('header')) ||
          (s.key === 'query' && e.key.includes('query')),
        )
        const ok = ep?.ok ?? false
        return {
          ...s,
          status: ok ? 'done' : 'error',
          detail: ep ? `HTTP ${ep.status} · ${ep.latencyMs}ms` : undefined,
        }
      }))
      setGhReport(r)
    } catch (e: unknown) {
      // 全部标 error
      setGhSteps((prev) => prev.map((s) => ({ ...s, status: 'error' })))
      toast.error(`GitHub 测试失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGhTesting(false)
    }
  }, [])

  // ═══════ Secret 写入 (runner 测试第一步) ═══════
  const ensureAllSecrets = useCallback(async (
    setSteps: SetRunnerSteps,
  ): Promise<boolean> => {
    if (!owner || !repo || !ghToken) {
      toast.error('未登录或私库未配置,无法写入 secrets')
      setSteps(() => RUNNER_STEP_DEFS.map((s) => ({
        ...s,
        status: s.key === 'secrets' ? 'error' : 'pending',
        detail: s.key === 'secrets' ? '未登录' : undefined,
      })))
      return false
    }
    setSteps(() => RUNNER_STEP_DEFS.map((s) => ({
      ...s,
      status: s.key === 'secrets' ? 'running' : 'pending',
    })))
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
      setSteps(() => RUNNER_STEP_DEFS.map((s) => ({
        ...s,
        status: s.key === 'secrets' ? 'done' : 'pending',
      })))
      return true
    } catch (e: any) {
      setSteps(() => RUNNER_STEP_DEFS.map((s) => ({
        ...s,
        status: s.key === 'secrets' ? 'error' : 'pending',
        detail: s.key === 'secrets' ? (e?.message || String(e)) : undefined,
      })))
      toast.error(`写入 secrets 失败:${e?.message || String(e)}`)
      return false
    }
  }, [owner, repo, ghToken, store])

  // ═══════ AI Runner 端到端测试 ═══════
  const runAITest = useCallback(async () => {
    if (!owner || !repo || !ghToken) { toast.error('未登录或私库未配置'); return }
    setAiTesting(true)
    setAiResult(null)
    // reset steps
    setAiSteps(RUNNER_STEP_DEFS.map((s) => ({ ...s, status: 'pending' as StepStatus })))
    try {
      const secretOk = await ensureAllSecrets(setAiSteps)
      if (!secretOk) {
        setAiTesting(false)
        setAiResult({ ok: false, run: null, reason: '写入 GitHub Secrets 失败,Runner 拿不到凭据' })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const result = await runWorkflowE2ETest(
        'ai_connectivity_test',
        () => dispatchAiConnectivityTest(owner, repo, ghToken, 'both'),
        owner, repo, ghToken,
        setAiSteps,
      )
      setAiResult(result)
      toast[result.ok ? 'success' : 'error'](
        result.ok ? 'AI 端到端通过 ✅' : `AI 端到端失败:${result.reason}`
      )
    } catch (e: any) {
      const reason = e?.message || String(e)
      setAiResult({ ok: false, run: null, reason })
      toast.error(`AI 测试异常:${reason}`)
    } finally {
      setAiTesting(false)
    }
  }, [owner, repo, ghToken, ensureAllSecrets])

  // ═══════ MinerU Runner 端到端测试 ═══════
  const runMineruE2ETest = useCallback(async () => {
    if (!owner || !repo || !ghToken) { toast.error('未登录或私库未配置'); return }
    if (!mineruToken.trim()) { toast.warning('请先填写 MinerU API Token'); return }
    setMineruTesting(true)
    setMineruResult(null)
    setMineruSteps(RUNNER_STEP_DEFS.map((s) => ({ ...s, status: 'pending' as StepStatus })))
    try {
      const secretOk = await ensureAllSecrets(setMineruSteps)
      if (!secretOk) {
        setMineruTesting(false)
        setMineruResult({ ok: false, run: null, reason: '写入 GitHub Secrets 失败,Runner 拿不到凭据' })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const result = await runWorkflowE2ETest(
        'mineru_connectivity_test',
        () => dispatchMineruConnectivityTest(owner, repo, ghToken),
        owner, repo, ghToken,
        setMineruSteps,
      )
      setMineruResult(result)
      toast[result.ok ? 'success' : 'error'](
        result.ok ? 'MinerU 端到端通过 ✅' : `MinerU 端到端失败:${result.reason}`
      )
    } catch (e: any) {
      const reason = e?.message || String(e)
      setMineruResult({ ok: false, run: null, reason })
      toast.error(`MinerU 测试异常:${reason}`)
    } finally {
      setMineruTesting(false)
    }
  }, [owner, repo, ghToken, mineruToken, ensureAllSecrets])

  // ═══════ 全部测试 ═══════
  const runAll = useCallback(async () => {
    if (!isInitialized) { toast.warning('等待初始化...'); return }
    setAllTesting(true)
    try {
      toast.info('开始全部测试...')
      await runGitHubTest()
      await runAITest()
      await runMineruE2ETest()
      toast.success('全部测试完成!')
    } finally {
      setAllTesting(false)
    }
  }, [isInitialized, runGitHubTest, runAITest, runMineruE2ETest])

  // ── 首次挂载自动跑 GitHub ──
  const didAutoRunRef = useRef(false)
  useEffect(() => {
    if (didAutoRunRef.current) return
    didAutoRunRef.current = true
    runGitHubTest()
  }, [runGitHubTest])

  // ═══════ tone 辅助 ═══════
  const runnerTone = (testing: boolean, result: RunnerTestResult | null): BlockTone => {
    if (testing) return 'running'
    if (!result) return 'idle'
    return result.ok ? 'ok' : 'err'
  }

  const greenCount = [
    ghReport?.allOk,
    aiResult?.ok,
    mineruResult?.ok,
  ].filter(Boolean).length

  return (
    <div className="space-y-4">
      {/* 顶部 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <button
          type="button"
          onClick={runAll}
          disabled={allTesting || !isInitialized}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-indigo-400 bg-indigo-50 text-indigo-700 rounded-md
                     hover:bg-indigo-100 disabled:text-slate-300 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:border-slate-200"
        >
          {allTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {allTesting ? '全部测试中...' : '🔌 全部测试'}
        </button>
        <span className="text-xs text-slate-500">
          {greenCount} / 3 通过 · dispatch 目标:{owner}/{repo}
        </span>
      </div>

      {/* GitHub API */}
      <TestBlock
        icon={<Cloud className="w-4 h-4" />}
        title="GitHub API"
        subtitle="前端直连 api.github.com (Header + Query 两种认证模式)"
        tone={ghReport ? (ghReport.allOk ? 'ok' : 'err') : ghTesting ? 'running' : 'idle'}
        buttonLabel={ghTesting ? '测试中...' : '单独测试'}
        onButton={runGitHubTest}
        buttonDisabled={ghTesting}
      >
        <StepTimeline steps={ghSteps} />
        {ghReport && <GitHubReportDetail report={ghReport} />}
      </TestBlock>

      {/* AI Provider */}
      <TestBlock
        icon={<Bot className="w-4 h-4" />}
        title={`AI Provider (${store.aiProviderMode === 'custom' ? '自定义端点' : '预置'})`}
        subtitle="sync secrets → GitHub Actions Runner 真调 chat/completions"
        tone={runnerTone(aiTesting, aiResult)}
        buttonLabel={aiTesting ? '测试中...' : '端到端测试'}
        onButton={runAITest}
        buttonDisabled={aiTesting || !owner || !repo}
      >
        <StepTimeline steps={aiSteps} />
        <RunnerResultView result={aiResult} />
      </TestBlock>

      {/* MinerU */}
      <TestBlock
        icon={<Wifi className="w-4 h-4" />}
        title="MinerU (PDF 转换)"
        subtitle="sync secrets → GitHub Actions Runner 真调 mineru.net"
        tone={runnerTone(mineruTesting, mineruResult)}
        buttonLabel={mineruTesting ? '测试中...' : '端到端测试'}
        onButton={runMineruE2ETest}
        buttonDisabled={mineruTesting || !owner || !repo || !mineruToken.trim()}
      >
        <StepTimeline steps={mineruSteps} />
        <RunnerResultView result={mineruResult} />
      </TestBlock>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════
// 子组件
// ═════════════════════════════════════════════════════════════════════════

type BlockTone = 'idle' | 'running' | 'ok' | 'warn' | 'err'

function TestBlock(props: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  tone: BlockTone
  buttonLabel: string
  onButton: () => void
  buttonDisabled?: boolean
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
      {props.children && <div className="pt-1">{props.children}</div>}
    </div>
  )
}

// ═══════ 步骤时间线 ═══════

function StepTimeline({ steps }: { steps: Step[] }) {
  if (steps.every((s) => s.status === 'pending')) return null

  const statusIcon = (status: StepStatus) => {
    switch (status) {
      case 'pending':
        return <CircleDashed className="w-3 h-3 text-slate-300" />
      case 'running':
        return <Loader2 className="w-3 h-3 text-indigo-500 animate-spin" />
      case 'done':
        return <CheckCircle2 className="w-3 h-3 text-green-600" />
      case 'error':
        return <XCircleImpl />
    }
  }

  const XCircleImpl = () => (
    <svg className="w-3 h-3 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  )

  const statusColor = (status: StepStatus) => {
    switch (status) {
      case 'pending':  return 'text-slate-400'
      case 'running':  return 'text-indigo-600 font-medium'
      case 'done':     return 'text-green-700'
      case 'error':    return 'text-red-600 font-medium'
    }
  }

  // 找 active step (第一个 running 的, 或最后一个 error)

  return (
    <div className="space-y-0">
      {steps.map((s, i) => {
        const connector = i < steps.length - 1
          ? (s.status === 'done'
              ? 'bg-green-300'
              : s.status === 'error'
                ? 'bg-red-300'
                : 'bg-slate-200')
          : ''
        return (
          <div key={s.key} className="flex items-start gap-2">
            <div className="flex flex-col items-center">
              <span className="mt-0.5">{statusIcon(s.status)}</span>
              {connector && <div className={`w-px h-4 ${connector}`} />}
            </div>
            <div className="flex-1 min-w-0 pb-1">
              <div className={`text-[11px] leading-tight ${statusColor(s.status)}`}>
                {s.label}
                {s.detail && (
                  <span className="ml-1 text-slate-400 font-normal">{s.detail}</span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ═══════ GitHub 详情 ═══════

function GitHubReportDetail({ report }: { report: FullConnectivityReport }) {
  return (
    <>
      <div className="flex items-center gap-4 text-[12px] font-mono">
        <ModeDot label="Header 模式" ok={report.headerModeOk} />
        <ModeDot label="Query 模式" ok={report.queryModeOk} />
      </div>
      <div className="border border-slate-200 rounded-md bg-slate-50 overflow-hidden">
        <div className="divide-y divide-slate-200 text-[11px] font-mono">
          {report.endpoints.map((ep) => (
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
          {report.summary}
        </div>
      </div>
    </>
  )
}

function ModeDot({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={ok ? 'text-green-600' : 'text-red-600'}>{ok ? '●' : '○'}</span>
      <span className={ok ? 'text-slate-700' : 'text-slate-500'}>{label}</span>
    </span>
  )
}

// ═══════ Runner 结果卡片 ═══════

function RunnerResultView({ result }: { result: RunnerTestResult | null }) {
  if (!result) return null  // 没结果时不渲染卡片 (步骤时间线已经显示了阶段状态)

  if (result.ok && result.run) {
    return (
      <ResultCard
        tone="ok"
        title="Runner 端到端通过 ✅"
        subtitle="Runner 真调成功,凭据和网络都 OK"
        run={result.run}
      />
    )
  }

  return (
    <ResultCard
      tone="err"
      title={
        result.run
          ? `Runner 失败:${result.run.conclusion ?? 'unknown'}`
          : 'Runner 没出现'
      }
      subtitle={result.reason ?? ''}
      run={result.run}
    />
  )
}

function ResultCard(props: {
  tone: 'ok' | 'err'
  title: string
  subtitle?: string
  run: RunStatus | null
}) {
  const outer = props.tone === 'ok'
    ? 'bg-green-50 border-green-200 text-green-800'
    : 'bg-red-50 border-red-200 text-red-800'
  const body = props.tone === 'ok' ? 'text-green-600' : 'text-red-600'

  return (
    <div className={`rounded-md border p-2.5 text-[11px] ${outer}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5">
          {props.tone === 'ok'
            ? <CheckCircle2 className="w-4 h-4" />
            : <AlertTriangle className="w-4 h-4" />}
        </span>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="font-semibold leading-tight">{props.title}</div>
          {props.subtitle && (
            <div className={`opacity-80 leading-relaxed ${body}`}>{props.subtitle}</div>
          )}
          {props.run && (
            <a
              href={props.run.html_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 opacity-70 hover:opacity-100 underline underline-offset-2"
            >
              <span>run #{props.run.id}</span>
              <span>·</span>
              <span>{props.run.status}</span>
              <span>·</span>
              <span>查看 GitHub Actions 日志 →</span>
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
