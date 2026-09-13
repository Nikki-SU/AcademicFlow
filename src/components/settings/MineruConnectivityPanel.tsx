/**
 * MinerU 联通性检测面板 —— Settings 页
 * -------------------------------------------------
 * 挂在 MinerU API Token 输入框下方。点"检测"按钮做两件事：
 *   1. 本地解析 JWT → 校验 token 格式 / 是否过期 / 剩余天数
 *   2. 探活用户自部署的 worker 代理（mineruWorkerUrl）的 /__af_health
 *
 * 架构说明：GitHub Actions runner 直接打 MinerU，前端不直连。
 * token 有效 → MinerU 就能用（overallOk=true）；
 * worker 探活是补充信息，Mixed Content / 未配置时跳过不影响整体判断。
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
} from 'lucide-react'
import { useSettingsStore } from '../../stores/settings'
import {
  checkMineruConnectivity,
  type MineruConnectivityReport,
} from '../../services/mineruConnectivity'

/** 把 timestamp（秒）转成可读时间字符串，undefined 返回 '—' */
function fmtDate(d: Date | undefined): string {
  if (!d) return '—'
  return d.toLocaleString()
}

export default function MineruConnectivityPanel() {
  const store = useSettingsStore()
  const token = store.mineruToken
  const workerUrl = store.mineruWorkerUrl

  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState<MineruConnectivityReport | null>(null)

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
      <div className="flex items-center gap-2">
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
          检测 MinerU 联通
        </button>
        {workerUrl.trim() && (
          <span className="text-[11px] text-slate-500 truncate">
            worker：<code className="font-mono">{workerUrl}</code>
          </span>
        )}
      </div>

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
