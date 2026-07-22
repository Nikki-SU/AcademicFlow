/**
 * 登录页首屏（双路径：Device Flow + Fine-grained PAT）
 * -------------------------------------------------
 * spec §5.0.1: 两个平权 tab，默认停在 Device Flow
 */
import { useState, useEffect, useCallback } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import {
  BookOpen,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldCheck,
  ArrowRight,
  Circle,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import {
  buildPATCreateURL,
  getDeviceCode,
  pollDeviceToken,
  type DeviceCodeResponse,
} from '../services/github'

type AuthMode = 'device' | 'pat'

function Login() {
  const { token, login, isLoading, error, clearError } = useAuthStore()
  const location = useLocation()
  const [authMode, setAuthMode] = useState<AuthMode>('device')
  const [patInput, setPatInput] = useState('')
  const [showPAT, setShowPAT] = useState(false)
  const [deviceCode, setDeviceCode] = useState<DeviceCodeResponse | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [countdown, setCountdown] = useState(0)

  if (token) {
    const from =
      (location.state as { from?: { pathname: string } } | null)?.from?.pathname || '/tracking'
    return <Navigate to={from} replace />
  }

  useEffect(() => {
    if (!deviceCode) return
    setCountdown(deviceCode.expires_in)
    const timer = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [deviceCode])

  const handleDeviceFlow = useCallback(async () => {
    try {
      const code = await getDeviceCode()
      setDeviceCode(code)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '获取授权码失败')
    }
  }, [])

  const handlePollToken = useCallback(async () => {
    if (!deviceCode) return
    setIsPolling(true)
    const startTime = Date.now()
    const expiresAt = startTime + deviceCode.expires_in * 1000
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        if (Date.now() > expiresAt) {
          throw new Error('授权码已过期')
        }
        const result = await pollDeviceToken(deviceCode.device_code)
        if (result) {
          await login(result.access_token, 'device_flow')
          toast.success('登录成功！')
          return
        }
        const remaining = expiresAt - Date.now()
        if (remaining <= 0) {
          throw new Error('授权码已过期')
        }
        timeoutId = setTimeout(poll, Math.min(deviceCode.interval * 1000, remaining))
      } catch (e) {
        if (timeoutId) clearTimeout(timeoutId)
        setIsPolling(false)
        toast.error(e instanceof Error ? e.message : '授权失败')
        setDeviceCode(null)
      }
    }
    poll()
  }, [deviceCode, login])

  useEffect(() => {
    if (deviceCode && !isPolling) {
      handlePollToken()
    }
  }, [deviceCode, isPolling, handlePollToken])

  const handleSubmitPAT = async () => {
    clearError()
    try {
      await login(patInput, 'pat')
      toast.success('登录成功！')
    } catch {
      // error already set in store
    }
  }

  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

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

        {/* 双路径 Tab */}
        <div className="flex mb-6 rounded-lg border border-slate-200 p-1">
          <button
            onClick={() => setAuthMode('device')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition ${
              authMode === 'device'
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Circle className={`w-4 h-4 ${authMode === 'device' ? 'fill-indigo-600 text-indigo-600' : 'text-slate-300'}`} />
            Device Flow（推荐）
          </button>
          <button
            onClick={() => setAuthMode('pat')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition ${
              authMode === 'pat'
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Circle className={`w-4 h-4 ${authMode === 'pat' ? 'fill-indigo-600 text-indigo-600' : 'text-slate-300'}`} />
            Fine-grained PAT
          </button>
        </div>

        {/* Device Flow */}
        {authMode === 'device' && (
          <div className="space-y-4">
            {!deviceCode ? (
              <div className="text-center">
                <p className="text-sm text-slate-600 mb-4">
                  获取一个临时授权码，在 GitHub 上完成授权后自动登录
                </p>
                <button
                  onClick={handleDeviceFlow}
                  disabled={isLoading}
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-400 text-white font-medium rounded-lg transition"
                >
                  <ArrowRight className="w-4 h-4" />
                  获取授权码
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-center">
                    <p className="text-xs text-slate-500 mb-2">授权码</p>
                    <div className="text-2xl font-mono font-bold text-indigo-600 tracking-wider">
                      {deviceCode.user_code}
                    </div>
                    <p className="text-xs text-slate-400 mt-2">
                      有效时间：{formatCountdown(countdown)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => window.open(deviceCode.verification_uri, '_blank')}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-900 text-white font-medium rounded-lg transition"
                  >
                    <ExternalLink className="w-4 h-4" />
                    跳转 GitHub 授权
                  </button>
                  <button
                    onClick={() => setDeviceCode(null)}
                    className="px-4 py-2.5 border border-slate-300 text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition"
                  >
                    重试
                  </button>
                </div>
                {isPolling && (
                  <div className="text-center text-sm text-slate-500 flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    等待授权...
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* PAT 手贴 */}
        {authMode === 'pat' && (
          <div className="space-y-4">
            <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
              <p className="text-sm font-semibold text-slate-700 mb-2">
                如果你希望权限精确到单个仓库，可用 PAT 手贴登录
              </p>
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

        {/* 底部信息（spec §5.0.1） */}
        <div className="mt-6 pt-6 border-t border-slate-200 space-y-3">
          <p className="text-xs text-slate-500 leading-relaxed">
            🔒 <strong>你的 token 只保存在你自己浏览器的 IndexedDB 里</strong>，不会上传到任何服务器。
            AcademicFlow 是纯前端应用（
            <a
              href="https://github.com/Nikki-SU/AcademicFlow"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 hover:underline"
            >
              查看源码
            </a>
            ），所有数据读写都在你 → GitHub 之间直接完成。
          </p>
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>AGPL-3.0</span>
            <span>v0.2.5</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Login
