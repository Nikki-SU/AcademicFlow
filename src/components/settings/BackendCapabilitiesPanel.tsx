/**
 * 后端工作流面板 —— Settings 页
 *
 * 后端 workflow（paper_convert / book_convert / ai_call / session_images 等）
 * 由应用**自动同步**：版本更新后进入应用即静默检测私库，落后 / 缺失 / 残留旧版
 * 时自动写入，用户无需手动操作（见 services/pipelineAutoSync.ts）。
 * 本面板只承担：
 *   1. 展示自动同步状态（就绪 / 同步中 / 失败可重试）
 *   2. 手动「检测」刷新状态与明细
 *   3. 引导配置 GitHub Actions Secrets（8 个，只能用户在 GitHub 上手动填）
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Server, RefreshCw, Wrench, ExternalLink, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useWorkspaceStore } from '../../stores/workspace'
import { checkPipelineInstalled, REQUIRED_SECRETS } from '../../services/repoBootstrap'
import { ensurePipelineSynced } from '../../services/pipelineAutoSync'
import { getLatestRun } from '../../services/workflowClient'

export default function BackendCapabilitiesPanel() {
  const auth = useAuthStore()
  const ws = useWorkspaceStore()
  const owner = auth.user?.login ?? ''
  const repo = ws.repo?.name ?? ''
  const token = auth.token ?? ''

  const [checking, setChecking] = useState(false)
  const [autoState, setAutoState] = useState<'idle' | 'running' | 'ready' | 'failed'>('idle')
  const [autoDetail, setAutoDetail] = useState<'synced' | 'up-to-date'>()
  const [autoError, setAutoError] = useState('')
  const [checkResult, setCheckResult] = useState<{
    installed: boolean
    missing: string[]
    legacy: string[]
    outdated: string[]
    sizes: Record<string, number>
  } | null>(null)
  const [runStatus, setRunStatus] = useState<{ pipeline?: string; ai?: string }>({})

  /** 自动同步（含失败重试共用入口）：检测私库 → 落后则自动写入 → 刷新状态 */
  const syncOnce = useCallback(async () => {
    if (!owner || !repo || !token) { toast.error('未登录或私库未配置'); return }
    setAutoState('running')
    try {
      const r = await ensurePipelineSynced(owner, repo, token)
      if (r.status === 'failed') {
        setAutoState('failed')
        setAutoError(r.error)
        return
      }
      setAutoState('ready')
      setAutoDetail(r.status)

      // 同步后刷新只读状态：详情 + 最近 run
      try {
        const check = await checkPipelineInstalled(owner, repo, token)
        setCheckResult(check)
        const pRun = await getLatestRun('paper_convert', owner, repo, token)
        const aRun = await getLatestRun('ai_call', owner, repo, token)
        setRunStatus({
          pipeline: pRun ? `${pRun.conclusion || pRun.status}` : '从未运行',
          ai: aRun ? `${aRun.conclusion || aRun.status}` : '从未运行',
        })
      } catch { /* 详情刷新失败不影响主状态 */ }
    } catch (e) {
      setAutoState('failed')
      setAutoError(e instanceof Error ? e.message : String(e))
    }
  }, [owner, repo, token])

  // 进入面板即自动执行一次（build id 闸门保证同一版本只真正检测一次）
  useEffect(() => { void syncOnce() }, [syncOnce])

  /** 手动刷新状态与明细（只读，不写入） */
  const runCheck = useCallback(async () => {
    if (!owner || !repo || !token) { toast.error('未登录或私库未配置'); return }
    setChecking(true)
    try {
      const r = await checkPipelineInstalled(owner, repo, token)
      setCheckResult(r)
      if (!r.installed) {
        const parts: string[] = []
        if (r.missing.length > 0) parts.push(`缺 ${r.missing.length} 个新文件`)
        if (r.outdated.length > 0) parts.push(`${r.outdated.length} 个文件版本落后`)
        if (r.legacy.length > 0) parts.push(`残留 ${r.legacy.length} 个旧版文件`)
        toast.warning(parts.join('；') + '，应用会自动同步修复')
      }
    } catch (e: any) {
      toast.error(`检测失败：${e?.message || e}`)
    } finally { setChecking(false) }
  }, [owner, repo, token])

  const secretsUrl = owner && repo
    ? `https://github.com/${owner}/${repo}/settings/secrets/actions`
    : '#'

  return (
    <div className="space-y-4">
      <p className="text-ui-xs text-ink-500">
        后端架构改造后，MinerU 转换和 AI 任务全部跑在 GitHub Actions 上（
        <b> paper_convert / book_convert / ai_call / session_images</b> 等 workflow）。
        <b>后端工作流由应用自动同步</b>：每次版本更新后会自动检测并写入私库，无需手动操作；
        这里只展示同步状态，并引导配置 GitHub Actions 所需的 8 个 Secrets。
      </p>

      {/* 状态条 */}
      <div className={`flex items-center gap-2 p-3 rounded-control-sm border text-ui-sm ${
        autoState === 'ready' ? 'bg-green-50 border-green-200 text-green-800'
        : autoState === 'failed' ? 'bg-red-50 border-red-200 text-red-800'
        : autoState === 'running' ? 'bg-blue-50 border-blue-200 text-blue-800'
        : 'bg-paper-100 border-ink-200 text-ink-600'
      }`}>
        {autoState === 'running' ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> 正在自动同步后端工作流…</>
        ) : autoState === 'ready' ? (
          autoDetail === 'synced'
            ? <><CheckCircle2 className="w-4 h-4 text-green-600" /> 后端已自动升级到新版（无需手动操作），最近 pipeline run: <span className="font-mono">{runStatus.pipeline}</span></>
            : <><CheckCircle2 className="w-4 h-4 text-green-600" /> 后端已就绪（新版），最近 pipeline run: <span className="font-mono">{runStatus.pipeline}</span></>
        ) : autoState === 'failed' ? (
          <><AlertTriangle className="w-4 h-4 text-red-600" /> 后端自动同步失败：<span className="font-mono text-ui-xs">{autoError}</span></>
        ) : (
          <><Server className="w-4 h-4 text-ink-400" /> 状态未知</>
        )}
      </div>

      {/* 操作区：检测（只读）+ 配置 Secrets；「重写后端」已移除，由自动同步承担 */}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={runCheck}
          disabled={checking || !owner || !repo}
          className="flex items-center justify-center gap-1.5 px-ui-gap py-2 text-ui-sm border border-ink-300 rounded-control-sm
                     hover:bg-paper-100 disabled:text-ink-300 disabled:cursor-not-allowed"
        >
          {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          检测
        </button>
        {autoState === 'failed' && (
          <button
            type="button"
            onClick={syncOnce}
            disabled={!owner || !repo}
            className="flex items-center justify-center gap-1.5 px-ui-gap py-2 text-ui-sm border border-seal-300 bg-seal-50 text-seal-700 rounded-control-sm
                       hover:bg-seal-100 disabled:text-ink-300 disabled:cursor-not-allowed"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重试同步
          </button>
        )}
        <a
          href={secretsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 px-ui-gap py-2 text-ui-sm border border-ink-300 rounded-control-sm
                     hover:bg-paper-100 text-ink-700"
        >
          <Wrench className="w-3.5 h-3.5" />
          配置 Secrets
          <ExternalLink className="w-3 h-3 text-ink-400" />
        </a>
      </div>

      {/* 检测结果明细（仅展示；修复由自动同步完成） */}
      {checkResult && !checkResult.installed && checkResult.missing.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-control-sm space-y-1">
          <div className="text-ui-xs font-semibold text-amber-800">缺失文件（自动同步会补上）：</div>
          {checkResult.missing.map(p => (
            <div key={p} className="flex items-center gap-1 text-ui-xs font-mono text-amber-700">
              <XCircle className="w-3 h-3" /> {p}
            </div>
          ))}
        </div>
      )}

      {checkResult && checkResult.legacy.length > 0 && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-control-sm space-y-1">
          <div className="text-ui-xs font-semibold text-red-800">
            残留的旧版文件（会与新版重复触发 / 造成 "no jobs were run"，自动同步会清理）：
          </div>
          {checkResult.legacy.map(p => (
            <div key={p} className="flex items-center gap-1 text-ui-xs font-mono text-red-700">
              <XCircle className="w-3 h-3" /> {p}
            </div>
          ))}
        </div>
      )}

      {checkResult && checkResult.outdated.length > 0 && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-control-sm space-y-1">
          <div className="text-ui-xs font-semibold text-blue-800">
            以下文件版本落后于新版（如旧版 session_images 不带课程材料转换），自动同步会升级：
          </div>
          {checkResult.outdated.map(p => (
            <div key={p} className="flex items-center gap-1 text-ui-xs font-mono text-blue-700">
              <AlertTriangle className="w-3 h-3" /> {p}
            </div>
          ))}
        </div>
      )}

      {/* Secrets 引导模板 */}
      <details className="border border-ink-200 rounded-control-sm overflow-hidden">
        <summary className="cursor-pointer px-ui-gap py-2 bg-paper-100 hover:bg-ink-100 text-ui-sm font-medium text-ink-800 flex items-center gap-2">
          <Wrench className="w-4 h-4 text-seal-600" />
          8 个必需 Secrets（点击展开查看模板）
        </summary>
        <div className="p-3 space-y-2">
          <p className="text-ui-xs text-ink-600 leading-relaxed">
            后端 workflow 由应用自动同步安装。要让 pipeline 真跑起来，必须在 GitHub
            Settings → Secrets and variables → Actions 里创建下面 8 个 Repository Secret。
          </p>
          <div className="grid gap-1.5">
            {REQUIRED_SECRETS.map(s => (
              <div key={s.name} className="flex items-start gap-2 p-2 bg-paper-100 border border-ink-200 rounded-control-sm text-ui-xs">
                <code className="shrink-0 px-1.5 py-0.5 bg-seal-100 text-seal-800 rounded-control-sm font-mono">{s.name}</code>
                <div className="flex-1">
                  <div className="text-ink-700">{s.hint}</div>
                  <div className="text-ink-500 text-ui-xs">来源：{s.from}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-ui-xs text-ink-500 pt-1">
            推荐模型：AI-1（生成）Qwen2.5-32B-Instruct · AI-2（审阅）Qwen2.5-72B-Instruct。
            硅基流动的 base URL 是 https://api.siliconflow.cn/v1。
          </p>
        </div>
      </details>
    </div>
  )
}
