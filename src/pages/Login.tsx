/**
 * 登录页首屏（双路径：Device Flow + Fine-grained PAT）
 * -------------------------------------------------
 * spec §5.0.1: 两个平权 tab，默认停在 Device Flow
 */
import { useState, useCallback } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import {
  BookOpen,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldCheck,
  Wifi,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import {
  buildPATCreateURL,
  testGitHubConnectivity,
} from '../services/github'

type AuthMode = 'device' | 'pat'

function Login() {
  const { token, login, isLoading, error, clearError } = useAuthStore()
  const location = useLocation()
  const [authMode] = useState<AuthMode>('pat')
  const [patInput, setPatInput] = useState('')
  const [showPAT, setShowPAT] = useState(false)
  const [patExpiresAt, setPatExpiresAt] = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() + 90)
    return d.toISOString().split('T')[0]
  })
  // Device Flow — 鸽掉以后做（GitHub OAuth App client_id 不存在）
  // const [deviceCode, setDeviceCode] = useState<DeviceCodeResponse | null>(null)
  // const [isPolling, setIsPolling] = useState(false)
  // const [countdown, setCountdown] = useState(0)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosticResult, setDiagnosticResult] = useState<string | null>(null)

  if (token) {
    const from =
      (location.state as { from?: { pathname: string } } | null)?.from?.pathname || '/tracking'
    return <Navigate to={from} replace />
  }

  // Device Flow countdown effect — 鸽掉
  // useEffect(() => {
  //   if (!deviceCode) return
  //   setCountdown(deviceCode.expires_in)
  //   const timer = setInterval(() => {
  //     setCountdown((c) => (c > 0 ? c - 1 : 0))
  //   }, 1000)
  //   return () => clearInterval(timer)
  // }, [deviceCode])

  // Device Flow handlers — 鸽掉
  // const handleDeviceFlow = useCallback(async () => { ... }, [])
  // const handlePollToken = useCallback(async () => { ... }, [])
  // useEffect(() => { ... handlePollToken ... }, [deviceCode, isPolling, handlePollToken])

  const handleSubmitPAT = async () => {
    clearError()
    try {
      const expiresAtMs = patExpiresAt ? new Date(patExpiresAt).getTime() : undefined
      await login(patInput, 'pat', expiresAtMs)
      toast.success('登录成功！')
    } catch {
      // error already set in store
    }
  }

  const handleRunDiagnostics = useCallback(async () => {
    setDiagnosing(true)
    setDiagnosticResult(null)
    try {
      const result = await testGitHubConnectivity()
      const summary =
        `Header 模式 → ${result.apiHeader === 'ok' ? '✅ 可达' : '❌ 不可达'}\n` +
        `Query 模式 → ${result.apiSimple === 'ok' ? '✅ 可达' : '❌ 不可达'}\n` +
        `\n` +
        result.detail
      setDiagnosticResult(summary)
    } catch (e) {
      setDiagnosticResult(`诊断出错：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDiagnosing(false)
    }
  }, [])

  // Device Flow formatCountdown — 鸽掉
  // const formatCountdown = (seconds: number) => {
  //   const m = Math.floor(seconds / 60)
  //   const s = seconds % 60
  //   return `${m}:${s.toString().padStart(2, '0')}`
  // }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50 flex items-center justify-center p-6">
      <div className="max-w-lg w-full bg-white rounded-2xl shadow-xl border border-slate-200 p-8 md:p-10">
        {/* Logo + 标题 */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-indigo-100 rounded-lg">
            <BookOpen className="w-7 h-7 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">AcademicFlow</h1>
            <p className="text-xs text-slate-500">
              学术工作流工具 · 用你自己的 GitHub 私库当后端
            </p>
          </div>
        </div>

        {/* PAT 手贴 */}
        {authMode === 'pat' && (
          <div className="space-y-4">
            <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
              <p className="text-sm font-semibold text-slate-700">
                如果你希望权限精确到单个仓库，可用 PAT 手贴登录
              </p>
              <div className="text-xs text-slate-600 space-y-1">
                <p>权限模板（创建页会预填）：</p>
                <ul className="list-disc pl-4 space-y-0.5">
                  <li>Repository access：Only select repositories → 选择你的私库</li>
                  <li>Contents：Read and write</li>
                  <li>Metadata：Read-only</li>
                  <li>Workflows：Read and write</li>
                </ul>
              </div>
              <a
                href={buildPATCreateURL()}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition"
              >
                <ExternalLink className="w-4 h-4" />
                跳到 GitHub 创建 PAT
              </a>
            </div>

            <div>
              <label
                htmlFor="pat"
                className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5"
              >
                <KeyRound className="w-4 h-4" />
                GitHub Personal Access Token
              </label>
              <div className="relative">
                <input
                  id="pat"
                  name="github-pat"
                  type={showPAT ? 'text' : 'password'}
                  value={patInput}
                  onChange={(e) => setPatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmitPAT()}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  autoComplete="current-password"
                  spellCheck={false}
                  disabled={isLoading}
                  className="w-full px-3 py-2 pr-10 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm font-mono disabled:bg-slate-100"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPAT((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                >
                  {showPAT ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="pat-expires"
                className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5"
              >
                PAT 过期时间（用于提前 7 天提醒）
              </label>
              <input
                id="pat-expires"
                type="date"
                value={patExpiresAt}
                onChange={(e) => setPatExpiresAt(e.target.value)}
                disabled={isLoading}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm disabled:bg-slate-100"
              />
              <p className="text-xs text-slate-500 mt-1">
                如果 GitHub 响应头提供了过期时间，会自动覆盖此处。
              </p>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 whitespace-pre-wrap break-words">
                {error}
              </div>
            )}

            <button
              onClick={handleSubmitPAT}
              disabled={isLoading || !patInput.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-400 disabled:cursor-not-allowed text-white font-medium rounded-lg transition"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  正在验证…
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  登录
                </>
              )}
            </button>
          </div>
        )}

        {/* 网络诊断 */}
        <div className="mb-4 pt-4 border-t border-slate-200">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5" />
              网络诊断
            </p>
            <button
              onClick={handleRunDiagnostics}
              disabled={diagnosing}
              className="text-xs text-indigo-600 hover:text-indigo-700 font-medium disabled:text-slate-400 flex items-center gap-1"
            >
              {diagnosing ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  检测中…
                </>
              ) : (
                '检测 GitHub 连通性'
              )}
            </button>
          </div>
          {diagnosticResult && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {diagnosticResult}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Login
