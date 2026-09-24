/**
 * 登录页 — Fine-grained PAT 单路径
 *
 * 视觉：纸底 + 墨字 + 朱砂点缀。字分两档 ——
 *   UI（表单/按钮/提示）走无衬线；品牌字与说明文案走 font-content（Crimson + 文楷）。
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

function Login() {
  const { token, login, isLoading, error, clearError } = useAuthStore()
  const location = useLocation()
  const [patInput, setPatInput] = useState('')
  const [showPAT, setShowPAT] = useState(false)
  const [patExpiresAt, setPatExpiresAt] = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() + 90)
    return d.toISOString().split('T')[0]
  })
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosticResult, setDiagnosticResult] = useState<string | null>(null)

  if (token) {
    const from =
      (location.state as { from?: { pathname: string } } | null)?.from?.pathname || '/tracking'
    return <Navigate to={from} replace />
  }

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-100 p-6">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-ink-900/10 bg-paper-50 shadow-card">
        {/* 顶部一道朱砂细带 —— 印章式的品牌记号，不铺面积 */}
        <div className="h-[3px] bg-seal-600" />

        <div className="p-8 md:p-10">
          {/* 品牌区：西文衬线 + 中文文楷，两种语言各走各的字 */}
          <div className="mb-7 flex items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-seal-600 shadow-sm">
              <BookOpen className="h-5 w-5 text-paper-50" strokeWidth={1.75} />
            </div>
            <div>
              <h1 className="font-content text-[26px] font-semibold leading-none tracking-tight text-ink-900">
                AcademicFlow
              </h1>
              <p className="font-content mt-1.5 text-xs text-ink-500">
                学术工作流工具 · 用你自己的 GitHub 私库当后端
              </p>
            </div>
          </div>

          {/* PAT 手贴 */}
          <div className="space-y-4">
            <div className="space-y-3 rounded-xl border border-ink-900/10 bg-paper-100 p-4">
              <p className="text-sm font-semibold text-ink-700">
                如果你希望权限精确到单个仓库，可用 PAT 手贴登录
              </p>
              <div className="space-y-1 text-xs text-ink-600">
                <p className="text-ink-500">权限模板（创建页会预填）：</p>
                <ul className="list-disc space-y-0.5 pl-4 marker:text-ink-300">
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
                className="inline-flex items-center gap-2 rounded-lg border border-seal-600/25 bg-seal-50 px-3.5 py-2 text-sm font-medium text-seal-700 transition hover:bg-seal-100"
              >
                <ExternalLink className="h-4 w-4" />
                跳到 GitHub 创建 PAT
              </a>
            </div>

            <div>
              <label
                htmlFor="pat"
                className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700"
              >
                <KeyRound className="h-4 w-4 text-ink-400" />
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
                  className="w-full rounded-lg border border-ink-900/15 bg-paper-50 px-3 py-2 pr-10 font-mono text-sm text-ink-900 transition placeholder:text-ink-300 focus:border-seal-500 focus:outline-none focus:ring-2 focus:ring-seal-600/20 disabled:bg-ink-50"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPAT((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-400 transition hover:text-ink-700"
                >
                  {showPAT ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="pat-expires"
                className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-700"
              >
                PAT 过期时间（用于提前 7 天提醒）
              </label>
              <input
                id="pat-expires"
                type="date"
                value={patExpiresAt}
                onChange={(e) => setPatExpiresAt(e.target.value)}
                disabled={isLoading}
                className="w-full rounded-lg border border-ink-900/15 bg-paper-50 px-3 py-2 text-sm text-ink-900 transition focus:border-seal-500 focus:outline-none focus:ring-2 focus:ring-seal-600/20 disabled:bg-ink-50"
              />
              <p className="mt-1 text-xs text-ink-500">
                如果 GitHub 响应头提供了过期时间，会自动覆盖此处。
              </p>
            </div>

            {error && (
              <div className="whitespace-pre-wrap break-words rounded-lg border border-seal-200 bg-seal-50 p-3 text-sm text-seal-800">
                {error}
              </div>
            )}

            <button
              onClick={handleSubmitPAT}
              disabled={isLoading || !patInput.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink-900 px-4 py-2.5 font-medium text-paper-50 transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在验证…
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4" />
                  登录
                </>
              )}
            </button>
          </div>

          {/* 网络诊断 */}
          <div className="mt-2 border-t border-ink-900/10 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-medium text-ink-500">
                <Wifi className="h-3.5 w-3.5" />
                网络诊断
              </p>
              <button
                onClick={handleRunDiagnostics}
                disabled={diagnosing}
                className="flex items-center gap-1 text-xs font-medium text-seal-700 transition hover:text-seal-600 disabled:text-ink-300"
              >
                {diagnosing ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    检测中…
                  </>
                ) : (
                  '检测 GitHub 连通性'
                )}
              </button>
            </div>
            {diagnosticResult && (
              <div className="whitespace-pre-wrap break-words rounded-lg border border-ink-900/10 bg-paper-100 p-3 font-mono text-xs leading-relaxed text-ink-700">
                {diagnosticResult}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Login
