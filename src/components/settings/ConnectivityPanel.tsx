/**
 * 服务连通性测试 —— 统一面板
 * -------------------------------------------------
 * 三种测试:
 *   - GitHub: 前端直连 api.github.com (Header + Query 两种模式)
 *   - AI: sync secrets → dispatch → Runner 端到端真调 chat/completions
 *   - MinerU: sync secrets → dispatch → Runner 端到端真调 mineru.net
 *
 * 全部测试按钮串行跑完三项。
 * 自动触发:只跑 GitHub(毫秒级)+ MinerU Token 快速 JWT 校验
 * 手动触发:全部测试 或 各自独立端到端按钮
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Loader2,
  Wifi,
  Zap,
  Cloud,
  Bot,
} from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { testFullGitHubConnectivity, type FullConnectivityReport } from '../../services/github'
import { syncAllSecrets } from '../../services/repoSecrets'
import {
  dispatchAiConnectivityTest,
  dispatchMineruTest,
  getLatestRun,
  getRun,
  type RunStatus,
} from '../../services/workflowClient'

type WorkflowEventType = 'ai_connectivity_test' | 'mineru_connectivity_test'

// 私库硬保险 —— workflow 文件在私库 academicflow-workspace 里,不能用 ws.repo.name
const PRIVATE_SECRETS_REPO = 'academicflow-workspace'

// ═════════════════════════════════════════════════════════════════════════
// 共享工具:Runner workflow 触发 + 轮询
// ═════════════════════════════════════════════════════════════════════════

async function runWorkflowE2ETest(
  eventType: WorkflowEventType,
  dispatch: () => Promise<void>,
  owner: string,
  repo: string,
  ghToken: string,
  label: string,
): Promise<RunStatus | null> {
  console.log(`[ConnectivityPanel] ${label}: 开始`)
  console.log(`[ConnectivityPanel] ${label}: dispatch 目标 → ${owner}/${repo}`)

  // 1. 记住 dispatch 前的最新 run
  const beforeRun = await getLatestRun(eventType, owner, repo, ghToken)
  const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()
  console.log(`[ConnectivityPanel] ${label}: dispatch 前最新 run #${beforeRun?.run_id ?? 'none'}, created_at=${beforeCreatedAt}`)

  // 2. dispatch
  console.log(`[ConnectivityPanel] ${label}: POST /dispatches event_type=${eventType}`)
  try {
    await dispatch()
    console.log(`[ConnectivityPanel] ${label}: dispatch 成功`)
  } catch (e: any) {
    console.error(`[ConnectivityPanel] ${label}: dispatch 失败:`, e)
    throw e
  }

  await new Promise((resolve) => setTimeout(resolve, 2500))

  // 3. Phase 1: 找新 run (最多 20 次 × 1.5s = 30s)
  let myRunId: number | null = null
  for (let i = 0; i < 20; i++) {
    const rs = await getLatestRun(eventType, owner, repo, ghToken, beforeCreatedAt)
    if (rs) {
      myRunId = rs.run_id
      console.log(`[ConnectivityPanel] ${label}: ✅ 找到新 run #${rs.run_id} ${rs.status} (created_at=${rs.created_at})`)
      break
    }
    console.log(`[ConnectivityPanel] ${label}: attempt ${i + 1}/20 — 没找到新 run,再等 1.5s...`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  if (!myRunId) {
    console.error(`[ConnectivityPanel] ${label}: ❌ 30s 内没找到新 run`)
    console.error(`[ConnectivityPanel] ${label}: 可能原因:`)
    console.error(`  - dispatch 打到错误的 repo (当前: ${owner}/${repo})`)
    console.error(`  - workflow yml 不在该 repo 的 .github/workflows/ 里`)
    console.error(`  - GitHub 索引延迟超过 30s`)
    return null
  }

  // 4. Phase 2: 固定跟踪这个 run (最多 60 次 × 2s = 120s)
  console.log(`[ConnectivityPanel] ${label}: Phase 2 跟踪 run #${myRunId}...`)
  let finalRun: RunStatus | null = null
  for (let i = 0; i < 60; i++) {
    const rs = await getRun(myRunId, owner, repo, ghToken)
    if (!rs) { await new Promise((resolve) => setTimeout(resolve, 1500)); continue }
    finalRun = rs
    if (rs.status === 'completed' || rs.status === 'failure' || rs.status === 'cancelled') {
      console.log(`[ConnectivityPanel] ${label}: run #${myRunId} 结束 status=${rs.status} conclusion=${rs.conclusion}`)
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return finalRun
}

// ═════════════════════════════════════════════════════════════════════════
// 主组件
// ═════════════════════════════════════════════════════════════════════════

export default function ConnectivityPanel() {
  const store = useSettingsStore()
  const auth = useAuthStore()

  // owner 来自 GitHub 登录用户,永远正确
  const owner = auth.user?.login ?? ''
  // repo 用硬编码私库常量 — workflow 文件和 secrets 都在私库 academicflow-workspace
  const repo = PRIVATE_SECRETS_REPO
  const ghToken = auth.token ?? ''

  // ── GitHub 状态 ──
  const [ghTesting, setGhTesting] = useState(false)
  const [ghReport, setGhReport] = useState<FullConnectivityReport | null>(null)

  // ── AI 状态 ──
  const [aiTesting, setAiTesting] = useState(false)
  const [aiRun, setAiRun] = useState<RunStatus | null>(null)

  // ── MinerU 状态 (端到端 only) ──
  const [mineruE2ETesting, setMineruE2ETesting] = useState(false)
  const [mineruRun, setMineruRun] = useState<RunStatus | null>(null)

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
      console.warn('[ConnectivityPanel] ensureAllSecrets: owner/repo/token 缺失', { owner, repo, hasToken: !!ghToken })
      toast.error('未登录或私库未配置,无法写入 secrets')
      return false
    }
    try {
      console.log(`[ConnectivityPanel] ensureAllSecrets → ${owner}/${repo}`)
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
      console.error('[ConnectivityPanel] syncAllSecrets 失败:', e)
      toast.error(`写入 secrets 失败:${e?.message || String(e)}`)
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
        'AI',
      )
      setAiRun(run)
      if (run?.conclusion === 'success') {
        toast.success('AI 端到端测试通过 ✅')
      } else {
        toast.error(`AI 测试失败:${run?.conclusion ?? 'runner 未出现'}`)
      }
    } catch (e: any) {
      toast.error(`AI 测试异常:${e?.message || String(e)}`)
    } finally {
      setAiTesting(false)
    }
  }, [owner, repo, ghToken, ensureAllSecrets])

  // ═══════ MinerU Runner 端到端测试 ═══════
  const runMineruE2ETest = useCallback(async () => {
    if (!owner || !repo || !ghToken) {
      toast.error('未登录或私库未配置')
      return
    }
    if (!mineruToken.trim()) {
      toast.warning('请先填写 MinerU API Token')
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
        'MinerU',
      )
      setMineruRun(run)
      if (run?.conclusion === 'success') {
        toast.success('MinerU 端到端测试通过 ✅')
      } else {
        toast.error(`MinerU 端到端失败:${run?.conclusion ?? 'runner 未出现'}`)
      }
    } catch (e: any) {
      toast.error(`MinerU 测试异常:${e?.message || String(e)}`)
    } finally {
      setMineruE2ETesting(false)
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

  // ── 自动:只跑 GitHub (毫秒级),不自动触发 Runner (太慢) ──
  const didAutoRunRef = useRef(false)
  useEffect(() => {
    if (didAutoRunRef.current) return
    didAutoRunRef.current = true
    console.log('[ConnectivityPanel] 首次挂载,自动跑 GitHub 测试')
    runGitHubTest()
  }, [runGitHubTest])

  // ═══════ 渲染 ═══════
  const greenCount = [
    ghReport?.allOk,
    aiRun?.conclusion === 'success',
    mineruRun?.conclusion === 'success',
  ].filter(Boolean).length
  const totalTests = 3

  return (
    <div className="space-y-4">
      {/* 顶部:全部测试按钮 */}
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
          {greenCount} / {totalTests} 通过 · dispatch 目标:{owner}/{repo}
        </span>
      </div>

      {/* ── GitHub API ── */}
      <TestBlock
        icon={<Cloud className="w-4 h-4" />}
        title="GitHub API"
        subtitle="前端直连 api.github.com (Header + Query 两种认证模式)"
        tone={ghReport ? (ghReport.allOk ? 'ok' : 'err') : ghTesting ? 'running' : 'idle'}
        buttonLabel={ghTesting ? '测试中...' : '单独测试'}
        onButton={runGitHubTest}
        buttonDisabled={ghTesting}
      >
        {ghReport && (
          <>
            <div className="flex items-center gap-4 text-[12px] font-mono">
              <ModeDot label="Header 模式" ok={ghReport.headerModeOk} />
              <ModeDot label="Query 模式" ok={ghReport.queryModeOk} />
            </div>
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

      {/* ── AI Provider ── */}
      <TestBlock
        icon={<Bot className="w-4 h-4" />}
        title={`AI Provider (${store.aiProviderMode === 'custom' ? '自定义端点' : '预置'})`}
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

      {/* ── MinerU (端到端 only) ── */}
      <TestBlock
        icon={<Wifi className="w-4 h-4" />}
        title="MinerU (PDF 转换)"
        subtitle="sync secrets → GitHub Actions Runner 真调 mineru.net"
        tone={
          mineruRun
            ? mineruRun.conclusion === 'success' ? 'ok' : 'err'
            : mineruE2ETesting ? 'running' : 'idle'
        }
        buttonLabel={mineruE2ETesting ? '测试中...' : '端到端测试'}
        onButton={runMineruE2ETest}
        buttonDisabled={mineruE2ETesting || !owner || !repo || !mineruToken.trim()}
      >
        {mineruRun && <RunStatusLink run={mineruRun} />}
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

function ModeDot({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={ok ? 'text-green-600' : 'text-red-600'}>{ok ? '●' : '○'}</span>
      <span className={ok ? 'text-slate-700' : 'text-slate-500'}>{label}</span>
    </span>
  )
}

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
        <div className="font-semibold">✗ Runner 端到端失败:{run.conclusion}</div>
      ) : (
        <div>⏳ Runner 运行中…</div>
      )}
      <div className="opacity-70 mt-0.5">
        run #{run.run_id} · {run.status} · 查看日志 →
      </div>
    </a>
  )
}
