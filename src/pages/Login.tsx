/**
 * PAT 登录页
 * -------------------------------------------------
 * 让用户走"跳转 GitHub 一键创建 PAT → 复制回粘贴 → 登录"三步。
 */
import { FormEvent, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import {
  BookOpen,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import { buildPATCreateURL } from '../services/github'

function Login() {
  const { token, login, isLoading, error, clearError } = useAuthStore()
  const location = useLocation()
  const [patInput, setPatInput] = useState('')
  const [showPAT, setShowPAT] = useState(false)

  // 已登录跳首页
  if (token) {
    const from =
      (location.state as { from?: { pathname: string } } | null)?.from?.pathname ||
      '/'
    return <Navigate to={from} replace />
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    clearError()
    try {
      await login(patInput)
      toast.success('登录成功！')
    } catch {
      // 错误信息已经在 store.error 里，Login 页面下面会渲染
    }
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

        {/* 步骤指引 */}
        <div className="mb-6 p-4 bg-slate-50 rounded-lg border border-slate-200">
          <p className="text-sm font-semibold text-slate-700 mb-3">
            首次使用只需 3 步：
          </p>
          <ol className="space-y-2 text-sm text-slate-600 list-decimal list-inside">
            <li>点下面的按钮跳到 GitHub 创建 Personal Access Token</li>
            <li>在 GitHub 页面点击 <span className="font-mono bg-slate-200 px-1 rounded">Generate token</span> 后复制 token</li>
            <li>粘贴到下面的输入框登录</li>
          </ol>

          <a
            href={buildPATCreateURL()}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition"
          >
            <ExternalLink className="w-4 h-4" />
            一键跳转 GitHub 创建 PAT
          </a>
          <p className="mt-2 text-xs text-slate-400">
            会预填 scope=<span className="font-mono">repo,workflow</span> 和 description=<span className="font-mono">AcademicFlow</span>，你在 GitHub 页面直接点绿色按钮生成即可。
          </p>
        </div>

        {/* PAT 表单
            设计权衡（M3.6.2-a-fix-c）：
            - Login PAT 保持 type=password：让 Chrome 密码管理器保存 + autofill，
              避免用户 sign out / 跨设备时重新粘贴 PAT
            - Settings 页所有 API Key 字段用 type=text + CSS 遮罩（详见 APIKeyInput.tsx）：
              Chrome 只 autofill 到 password 字段，不会污染 text 字段
            - autoComplete="current-password" 明确告诉 Chrome"就填这里、只填这里" */}
        <form onSubmit={handleSubmit} className="space-y-4">
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
                aria-label={showPAT ? '隐藏 token' : '显示 token'}
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
            type="submit"
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
        </form>

        {/* 数据主权声明 */}
        <div className="mt-6 pt-6 border-t border-slate-200">
          <p className="text-xs text-slate-500 leading-relaxed">
            🔒 <strong>你的 token 只保存在你自己浏览器的 IndexedDB 里</strong>，不会上传到任何服务器。
            AcademicFlow 是纯前端应用（AGPL-3.0 开源，
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
        </div>
      </div>
    </div>
  )
}

export default Login
