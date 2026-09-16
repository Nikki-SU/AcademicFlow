/**
 * GitHub 全端点连通性检测面板 —— Settings 页
 * -------------------------------------------------
 * 测试 6 个 GitHub 相关端点的网络连通性：
 *   1. api.github.com（Header 模式 —— 带自定义头，触发 CORS 预检）
 *   2. api.github.com（Query 模式 —— 零自定义头，不触发预检）
 *   3. github.com（主站）
 *   4. codeload.github.com（仓库下载）
 *   5. objects.githubusercontent.com（Git LFS 对象存储）
 *   6. GitHub Pages（用户 Pages 站点）
 *
 * 与登录前的单端点 testGitHubConnectivity 互补：
 *   - 登录前：只测 api.github.com 一个端点，判断能不能登录
 *   - Settings 页：全端点体检，诊断登录后实际使用中哪些端点会挂
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2,
  Loader2,
  Wifi,
  WifiOff,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Globe,
} from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import {
  testFullGitHubConnectivity,
  type FullConnectivityReport,
  type EndpointProbeResult,
} from '../../services/github'

export default function GitHubConnectivityPanel() {
  const auth = useAuthStore()
  const [testing, setTesting] = useState(false)
  const [report, setReport] = useState<FullConnectivityReport | null>(null)
  const [expanded, setExpanded] = useState(false)

  // 用户 GitHub Pages 域名（<user>.github.io）
  const pagesHost = auth.user?.login
    ? `${auth.user.login}.github.io`
    : undefined

  // 页面挂载后自动跑一次测试
  const didAutoRunRef = useRef(false)
  useEffect(() => {
    if (didAutoRunRef.current) return
    didAutoRunRef.current = true
    runTest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runTest = useCallback(async () => {
    setTesting(true)
    setReport(null)
    setExpanded(false)
    try {
      const r = await testFullGitHubConnectivity(pagesHost)
      setReport(r)
      if (r.allOk) {
        toast.success('GitHub 全端点连通性正常 🎉')
      } else {
        const failedCount = r.endpoints.filter((e) => !e.ok).length
        toast.warning(`${failedCount} 个端点不可达，点击查看详情`)
        setExpanded(true)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`测试失败：${msg}`)
    } finally {
      setTesting(false)
    }
  }, [pagesHost])

  // 配色
  const tone =
    report == null
      ? 'idle'
      : report.allOk
        ? 'ok'
        : report.headerModeOk && report.queryModeOk
          ? 'partial'
          : 'err'

  const toneClasses: Record<string, string> = {
    idle: 'bg-slate-50 border-slate-200 text-slate-600',
    ok: 'bg-green-50 border-green-200 text-green-800',
    partial: 'bg-amber-50 border-amber-200 text-amber-800',
    err: 'bg-red-50 border-red-200 text-red-700',
  }

  const toneIcon = (() => {
    if (testing) return <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
    if (report == null) return <Globe className="w-4 h-4 text-slate-400" />
    if (report.allOk) return <CheckCircle2 className="w-4 h-4 text-green-600" />
    if (report.headerModeOk && report.queryModeOk)
      return <AlertTriangle className="w-4 h-4 text-amber-600" />
    return <WifiOff className="w-4 h-4 text-red-600" />
  })()

  const headerModeClass =
    report?.headerModeOk
      ? 'text-green-600'
      : report?.queryModeOk
        ? 'text-amber-600'
        : 'text-red-600'

  return (
    <div className="space-y-2">
      {/* 顶部状态条 + 按钮 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs border border-indigo-300 bg-indigo-50 text-indigo-700 rounded-md
                       hover:bg-indigo-100 disabled:text-slate-300 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:border-slate-200"
          >
            {testing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Wifi className="w-3.5 h-3.5" />
            )}
            {testing ? '测试中...' : '测试 GitHub 连通性'}
          </button>

          {/* 快速状态标签 */}
          {report && (
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                report.allOk
                  ? 'bg-green-100 text-green-700'
                  : report.headerModeOk && report.queryModeOk
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-red-100 text-red-700'
              }`}
            >
              {report.allOk
                ? '全部可达'
                : `${report.endpoints.filter((e) => !e.ok).length} / ${report.endpoints.length} 不可达`}
            </span>
          )}
        </div>

        {/* Header/Query 模式快速指示 */}
        {report && (
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1">
              <span className={`font-mono ${report.headerModeOk ? 'text-green-600' : 'text-red-600'}`}>
                {report.headerModeOk ? '●' : '○'}
              </span>
              Header 模式
            </span>
            <span className="flex items-center gap-1">
              <span className={`font-mono ${report.queryModeOk ? 'text-green-600' : 'text-red-600'}`}>
                {report.queryModeOk ? '●' : '○'}
              </span>
              Query 模式
            </span>
          </div>
        )}
      </div>

      {/* 总体状态提示 */}
      {report && (
        <div
          className={`flex items-start gap-2 p-2.5 rounded-md border text-xs ${toneClasses[tone]}`}
        >
          {toneIcon}
          <div className="flex-1">
            {tone === 'ok' && <span className="font-semibold">所有端点可达，网络环境良好。</span>}
            {tone === 'partial' && (
              <span>
                api.github.com 可达，但部分 GitHub 其他端点不可达。
                <span className={headerModeClass}>
                  Header 模式{report.headerModeOk ? '✅' : '❌'} / Query 模式{report.queryModeOk ? '✅' : '❌'}
                </span>
              </span>
            )}
            {tone === 'err' && (
              <span className="font-semibold">
                ⚠️ api.github.com {report.headerModeOk ? '可达' : '❌ 不可达'} ——
                {report.headerModeOk
                  ? 'Header 模式可能被 CORS 预检拦截。'
                  : 'VPN/代理可能没有正确生效。'}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 p-0.5 hover:bg-black/5 rounded"
            aria-label="展开/折叠详情"
          >
            {expanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        </div>
      )}

      {/* 端点明细（折叠展开） */}
      {report && expanded && (
        <div className="border border-slate-200 rounded-md bg-slate-50 overflow-hidden">
          <div className="divide-y divide-slate-200 text-[11px] font-mono">
            {report.endpoints.map((ep) => (
              <EndpointRow key={ep.key} ep={ep} />
            ))}
          </div>

          {/* 诊断总结 */}
          <div className="px-3 py-2 bg-white border-t border-slate-200 text-[11px] text-slate-600 whitespace-pre-wrap leading-relaxed">
            {report.summary}
          </div>
        </div>
      )}
    </div>
  )
}

/** 单个端点行 */
function EndpointRow({ ep }: { ep: EndpointProbeResult }) {
  const icon = ep.ok ? (
    <span className="text-green-600">✓</span>
  ) : (
    <span className="text-red-600">✗</span>
  )
  const statusText = ep.ok
    ? ep.status
      ? `HTTP ${ep.status}`
      : 'OK'
    : ep.error || `HTTP ${ep.status || '—'}`

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className={`w-4 text-center shrink-0 ${ep.ok ? '' : ''}`}>{icon}</span>
      <span className="text-slate-700 w-48 shrink-0 truncate" title={ep.label}>
        {ep.label}
      </span>
      <span
        className="text-slate-400 truncate flex-1 max-w-[200px]"
        title={ep.url}
      >
        {ep.url.replace('https://', '').replace('http://', '')}
      </span>
      <span className={`text-slate-400 ${ep.ok ? '' : 'text-red-500'}`}>
        {statusText}
      </span>
      <span className="text-slate-400 ml-auto tabular-nums">
        {ep.latencyMs}ms
      </span>
    </div>
  )
}
