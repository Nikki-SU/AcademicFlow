/**
 * 服务连通性测试 —— 统一面板
 * -------------------------------------------------
 * 三种测试:
 *   - GitHub: 前端直连 api.github.com (Header + Query 两种模式)
 *   - AI: sync secrets → dispatch → Runner 端到端真调 chat/completions
 *   - MinerU: sync secrets → dispatch → Runner 端到端真调 mineru.net
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
// Runner 测试结果类型 (5 种状态, 无信息丢失)
// ═════════════════════════════════════════════════════════════════════════

type RunnerTestResult =
  | { ok: true; run: RunStatus }                              // 成功
  | { ok: false; run: RunStatus; reason?: string }            // run 结束但失败
  | { ok: false; run: null; reason: string }                  // 没找到 run / dispatch 异常

// ═════════════════════════════════════════════════════════════════════════
// 共享工具:dispatch + 轮询
// ═════════════════════════════════════════════════════════════════════════

async function runWorkflowE2ETest(
  eventType: WorkflowEvent,
  dispatch: () => Promise<void>,
  owner: string,
  repo: string,
  ghToken: string,
): Promise<RunnerTestResult> {
  const tag = `[ConnectivityPanel ${eventType}]`
  console.log(`${tag} 开始,目标 repo=${owner}/${repo},token 长度=${ghToken.length}`)

  // 1. 记住 dispatch 前的最新 run
  const beforeRun = await getLatestRun(eventType, owner, repo, ghToken)
  const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()
  console.log(`${tag} dispatch 前最新 run: ${beforeRun ? `id=${beforeRun.run_id} created=${beforeRun.created_at}` : '无'}, beforeCreatedAt=${beforeCreatedAt}`)

  // 2. dispatch
  try {
    await dispatch()
    console.log(`${tag} dispatch 成功`)
  } catch (e: any) {
    const msg = e?.message || String(e)
    console.error(`${tag} dispatch 失败:`, e)
    return { ok: false, run: null, reason: `dispatch 失败: ${msg}` }
  }

  console.log(`${tag} 等 2.5s 让 GitHub 创建 run...`)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  // 3. Phase 1: 找新 run (最多 20 次 × 1.5s = 30s)
  let myRunId: number | null = null
  for (let i = 0; i < 20; i++) {
    const rs = await getLatestRun(eventType, owner, repo, ghToken, beforeCreatedAt)
    if (rs) {
      myRunId = rs.run_id
      console.log(`${tag} ✅ Phase 1[${i+1}/20] 找到新 run id=${rs.run_id} created=${rs.created_at} status=${rs.status}`)
      break
    }
    console.log(`${tag} Phase 1[${i+1}/20] 没找到,再等 1.5s...`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  if (!myRunId) {
    // debug: 列一下当前能看到的所有 repository_dispatch run name
    console.error(`${tag} ❌ 30s 内没找到新 run`)
    return {
      ok: false, run: null,
      reason: `GitHub Actions 30s 内没创建新 run。可能原因: dispatch 打到了错误的 repo (当前目标 ${owner}/${repo}), 或 workflow yml 不在 .github/workflows/ 里, 或 Actions 排队超过 30s。`,
    }
  }

  // 4. Phase 2: 固定跟踪这个 run (最多 60 次 × 2s = 120s)
  let finalRun: RunStatus | null = null
  for (let i = 0; i < 60; i++) {
    const rs = await getRun(myRunId, owner, repo, ghToken)
    if (!rs) {
      console.log(`${tag} Phase 2[${i+1}/60] getRun 返回 null (404? run_id=${myRunId})`)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      continue
    }
    finalRun = rs
    console.log(`${tag} Phase 2[${i+1}/60] run id=${rs.run_id} status=${rs.status} conclusion=${rs.conclusion ?? '-'}`)
    if (rs.status === 'completed' || rs.status === 'failure' || rs.status === 'cancelled') break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  if (!finalRun) {
    return { ok: false, run: null, reason: `run id=${myRunId} 120s 内没结束` }
  }

  if (finalRun.conclusion === 'success') {
    console.log(`${tag} ✅ 成功! run id=${finalRun.run_id}`)
    return { ok: true, run: finalRun }
  }
  console.log(`${tag} ❌ conclusion=${finalRun.conclusion}`)
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

  // ── GitHub ──
  const [ghTesting, setGhTesting] = useState(false)
  const [ghReport, setGhReport] = useState<FullConnectivityReport | null>(null)

  // ── Runner 测试结果 (5 态) ──
  const [aiTesting, setAiTesting] = useState(false)
  const [aiResult, setAiResult] = useState<RunnerTestResult | null>(null)

  const [mineruTesting, setMineruTesting] = useState(false)
  const [mineruResult, setMineruResult] = useState<RunnerTestResult | null>(null)

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
      toast.error(`GitHub 测试失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGhTesting(false)
    }
  }, [])

  // ═══════ Secret 写入 ═══════
  const ensureAllSecrets = useCallback(async (): Promise<boolean> => {
    if (!owner || !repo || !ghToken) {
      toast.error('未登录或私库未配置,无法写入 secrets')
      return false
    }
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
      toast.error(`写入 secrets 失败:${e?.message || String(e)}`)
      return false
    }
  }, [owner, repo, ghToken, store])

  // ═══════ AI Runner 端到端测试 ═══════
  const runAITest = useCallback(async () => {
    if (!owner || !repo || !ghToken) { toast.error('未登录或私库未配置'); return }
    setAiTesting(true)
    setAiResult(null)
    try {
      const secretOk = await ensureAllSecrets()
      if (!secretOk) { setAiTesting(false); setAiResult({ ok: false, run: null, reason: '写入 GitHub Secrets 失败,Runner 拿不到凭据' }); return }
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const result = await runWorkflowE2ETest(
        'ai_connectivity_test',
        () => dispatchAiConnectivityTest(owner, repo, ghToken, 'both'),
        owner, repo, ghToken,
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
    try {
      const secretOk = await ensureAllSecrets()
      if (!secretOk) { setMineruTesting(false); setMineruResult({ ok: false, run: null, reason: '写入 GitHub Secrets 失败,Runner 拿不到凭据' }); return }
      await new Promise((resolve) => setTimeout(resolve, 2000))

      const result = await runWorkflowE2ETest(
        'mineru_connectivity_test',
        () => dispatchMineruConnectivityTest(owner, repo, ghToken),
        owner, repo, ghToken,
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

  // ═══════ 渲染辅助 ═══════
  // 根据 testing + result 计算 tone
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

/**
 * Runner 测试结果展示 —— 覆盖全部 3 种终态:
 *   1. ok=true:   ✅ run 成功
 *   2. ok=false + run!=null: ❌ run 结束但 conclusion!=success (failure/cancelled)
 *   3. ok=false + run=null:  ❌ 没找到 run 或 dispatch 异常 (reason 解释)
 */
function RunnerResultView({ result }: { result: RunnerTestResult | null }) {
  if (!result) {
    // idle 状态 — 还没跑过, 给个占位提示
    return (
      <div className="text-[11px] text-slate-400 italic">
        点 "端到端测试" 开始
      </div>
    )
  }

  if (result.ok && result.run) {
    // ── 成功 ──
    return (
      <ResultCard
        icon={<CheckCircle2 className="w-4 h-4" />}
        tone="ok"
        title="Runner 端到端通过 ✅"
        subtitle="Runner 真调成功,凭据和网络都 OK"
        run={result.run}
      />
    )
  }

  // ── 失败 (run 存在或不存在) ──
  return (
    <ResultCard
      icon={<AlertTriangle className="w-4 h-4" />}
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
  icon: React.ReactNode
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
        <span className="mt-0.5">{props.icon}</span>
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
              <span>run #{props.run.run_id}</span>
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
