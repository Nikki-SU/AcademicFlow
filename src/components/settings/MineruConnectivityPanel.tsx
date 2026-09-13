/**
 * MinerU 联通性检测面板 —— Settings 页
 * -------------------------------------------------
 * 挂在 MinerU API Token 输入框下方。两个按钮：
 *   1. 快速检测：本地解析 JWT + worker 代理探活（前端零网络开销）
 *   2. 端到端测试：触发 GitHub Actions mineru-test workflow，
 *      runner 上直接 POST MinerU file-urls/batch，真实验证
 *      MINERU_API_TOKEN secret + runner→mineru.net 网络
 *
 * 架构说明：GitHub Actions runner 直接打 MinerU，前端不直连。
 */
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Wifi,
  WifiOff,
  Info,
  Zap,
} from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useWorkspaceStore } from '../../stores/workspace'
import { useSettingsStore } from '../../stores/settings'
import {
  checkMineruConnectivity,
  type MineruConnectivityReport,
} from '../../services/mineruConnectivity'
import {
  dispatchMineruTest,
  getLatestRun,
  type RunStatus,
} from '../../services/workflowClient'

/** 把 timestamp（秒）转成可读时间字符串，undefined 返回 '—' */
function fmtDate(d: Date | undefined): string {
  if (!d) return '—'
  return d.toLocaleString()
}

export default function MineruConnectivityPanel() {
  const store = useSettingsStore()
  const auth = useAuthStore()
  const ws = useWorkspaceStore()
  const token = store.mineruToken
  const workerUrl = store.mineruWorkerUrl
  const owner = auth.user?.login ?? ''
  const repo = ws.repo?.name ?? ''
  const ghToken = auth.token ?? ''

  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState<MineruConnectivityReport | null>(null)

  const [e2eRunning, setE2eRunning] = useState(false)
  const [e2eRun, setE2eRun] = useState<RunStatus | null>(null)

  const runCheck = useCallback(async () => {
    if (!token.trim()) {
      toast.warning('请先填写 MinerU API Token')
      return
    }
    setChecking(true)
    try {
      const r = await checkMineruConnectivity({ token, workerUrl })
      setReport(r)
      if (r.overallOk) {
        toast.success('MinerU 联通检测通过')
      } else {
        toast.warning(`MinerU 联通异常：${r.overallMessage}`)
      }
    } catch (e: any) {
      const msg = e?.message || String(e)
      toast.error(`检测失败：${msg}`)
    } finally {
      setChecking(false)
    }
  }, [token, workerUrl])

  const runE2E = useCallback(async () => {
    if (!owner || !repo || !ghToken) {
      toast.error('未登录或私库未配置，无法端到端测试')
      return
    }
    setE2eRunning(true)
    setE2eRun(null)
    try {
      await dispatchMineruTest(owner, repo, ghToken)
      toast.info('已触发 MinerU 端到端测试，runner 正在执行...')
      // 轮询 run 状态，最多 1min（12 × 5s）
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000))
        const rs = await getLatestRun('mineru_connectivity_test', owner, repo, ghToken)
        if (!rs) continue
        setE2eRun(rs)
        if (rs.status === 'completed' || rs.status === 'failure' || rs.status === 'cancelled') {
          if (rs.conclusion === 'success') {
            toast.success('端到端测试通过：MinerU 链路完整可达')
          } else {
            toast.error(`端到端测试失败：${rs.conclusion}（查看 runner 日志）`)
          }
          return
        }
      }
      toast.info('端到端测试仍在执行中，请稍后查看 runner 日志')
    } catch (e: any) {
      const msg = e?.message || String(e)
      toast.error(`端到端测试触发失败：${msg}`)
    } finally {
      setE2eRunning(false)
    }
  }, [owner, repo, ghToken])

  // 状态条配色：
  //   绿 = overallOk 且 tokenExpiringSoon=false
  //   橙 = overallOk 但 tokenExpiringSoon=true（即将过期）
  //   红 = !overallOk（token 过期 / 格式错）
  const ok = report?.overallOk ?? false
  const expiringSoon = report?.tokenExpiringSoon ?? false
  const tone =
    report == null
      ? 'idle'
      : ok && !expiringSoon
        ? 'ok'
        : ok && expiringSoon
          ? 'warn'
          : 'err'

  // worker 状态在详情里的文字
  const workerDetail = (() => {
    const w = report?.worker
    if (!w) return null
    if (w.reason === 'mixed_content')
      return { text: '跳过（HTTPS → HTTP Mixed Content）', tone: 'info' as const }
    if (w.reason === 'not_configured')
      return { text: '未配置', tone: 'info' as const }
    if (w.ok)
      return { text: `✓ 可达（${w.detail ?? 'OK'}）`, tone: 'ok' as const }
    if (w.attempted)
      return { text: `✗ 不可达（${w.detail ?? 'unknown'}）`, tone: 'err' as const }
    return { text: w.detail ?? '未探活', tone: 'info' as const }
  })()

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={runCheck}
          disabled={checking || !token.trim()}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs border border-cyan-300 bg-cyan-50 text-cyan-700 rounded-md
                     hover:bg-cyan-100 disabled:text-slate-300 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:border-slate-200"
        >
          {checking ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Wifi className="w-3.5 h-3.5" />
          )}
          快速检测
        </button>
        <button
          type="button"
          onClick={runE2E}
          disabled={e2eRunning || !owner || !repo}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs border border-violet-300 bg-violet-50 text-violet-700 rounded-md
                     hover:bg-violet-100 disabled:text-slate-300 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:border-slate-200"
          title="触发 GitHub Actions，在 runner 上真调 MinerU POST /file-urls/batch"
        >
          {e2eRunning ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Zap className="w-3.5 h-3.5" />
          )}
          端到端测试
        </button>
        {workerUrl.trim() && (
          <span className="text-[11px] text-slate-500 truncate">
            worker：<code className="font-mono">{workerUrl}</code>
          </span>
        )}
      </div>

      {e2eRun && (
        <a
          href={e2eRun.html_url}
          target="_blank"
          rel="noreferrer"
          className={`block p-2 rounded-md border text-[11px] truncate ${
            e2eRun.conclusion === 'success'
              ? 'bg-green-50 border-green-200 text-green-700'
              : e2eRun.status === 'completed' || e2eRun.conclusion
                ? 'bg-red-50 border-red-200 text-red-600'
                : 'bg-blue-50 border-blue-200 text-blue-600'
          }`}
        >
          runner 状态：{e2eRun.conclusion ?? e2eRun.status} · 查看日志 →
        </a>
      )}

      {report && (
        <div
          className={`flex items-start gap-1.5 p-2.5 rounded-md border text-xs ${
            tone === 'ok'
              ? 'bg-green-50 border-green-200 text-green-800'
              : tone === 'warn'
                ? 'bg-amber-50 border-amber-200 text-amber-800'
                : tone === 'err'
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-slate-50 border-slate-200 text-slate-600'
          }`}
        >
          {tone === 'ok' ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-green-600 mt-0.5 shrink-0" />
          ) : tone === 'warn' ? (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
          ) : tone === 'err' ? (
            <WifiOff className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0" />
          ) : (
            <Info className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
          )}
          <div className="flex-1 space-y-1">
            <div>{report.overallMessage}</div>
            {report.jwt && !report.jwt.parseError && (
              <div className="pl-1 text-[11px] text-slate-500 space-y-0.5">
                <div>
                  有效期至：
                  <code className="font-mono">
                    {fmtDate(report.jwt.expiresAt)}
                  </code>
                  {report.jwt.remainingDays !== undefined && (
                    <span className="ml-1">
                      （剩 {report.jwt.remainingDays} 天）
                    </span>
                  )}
                </div>
                {report.jwt.uuid && (
                  <div>
                    UUID：
                    <code className="font-mono">{report.jwt.uuid}</code>
                  </div>
                )}
                {report.jwt.jti && (
                  <div>
                    jti：
                    <code className="font-mono truncate inline-block max-w-[200px] align-bottom">
                      {report.jwt.jti}
                    </code>
                  </div>
                )}
                {workerDetail && (
                  <div className="flex items-center gap-1">
                    Worker：
                    <code
                      className={`font-mono ${
                        workerDetail.tone === 'ok'
                          ? 'text-green-700'
                          : workerDetail.tone === 'err'
                            ? 'text-red-600'
                            : 'text-slate-500'
                      }`}
                    >
                      {workerDetail.text}
                    </code>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
