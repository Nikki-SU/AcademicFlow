/**
 * 已登录首页
 * -------------------------------------------------
 * M2 起：加载时先检测 workspace 私库是否已初始化。
 *   - 未初始化 → Navigate 到 /onboarding
 *   - 已初始化 → 展示 workspace 元信息卡片
 *
 * 后续里程碑（M3+）会在这里挂真正的工作台（笔记列表 / 新建 / AI 对话等）。
 */
import {
  BookOpen,
  ExternalLink,
  Github,
  Loader2,
  LogOut,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  FileText,
  BookMarked,
} from 'lucide-react'
import { useEffect } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'

function Home() {
  const { user, scopes, logout } = useAuthStore()
  const {
    isChecked,
    isLoading: wsLoading,
    repo,
    checkAndMaybeInit,
  } = useWorkspaceStore()

  useEffect(() => {
    // 登录后首次进入 Home → 检测 workspace
    if (!isChecked && !wsLoading) {
      checkAndMaybeInit()
    }
  }, [isChecked, wsLoading, checkAndMaybeInit])

  const handleLogout = async () => {
    await logout()
    toast.success('已登出，token 已从本地清除')
  }

  // 未检测完成 → 显示加载态（避免闪跳）
  if (!isChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-600">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
          <span className="text-sm">正在检查工作区…</span>
        </div>
      </div>
    )
  }

  // 检测完但未 onboarding → 去引导页
  if (isChecked && !repo) {
    return <Navigate to="/onboarding" replace />
  }

  const buildTime = new Date().toISOString()

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50">
      {/* 顶栏 */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-indigo-100 rounded-md">
              <BookOpen className="w-5 h-5 text-indigo-600" />
            </div>
            <span className="font-bold text-slate-800">AcademicFlow</span>
          </div>

          {user && (
            <div className="flex items-center gap-3">
              <a
                href={user.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 hover:opacity-80 transition"
              >
                <img
                  src={user.avatar_url}
                  alt={user.login}
                  className="w-7 h-7 rounded-full border border-slate-200"
                />
                <span className="text-sm text-slate-700 hidden sm:inline">
                  @{user.login}
                </span>
              </a>
              <Link
                to="/settings"
                className="flex items-center gap-1 px-2.5 py-1.5 text-sm text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
                title="设置"
              >
                <SettingsIcon className="w-4 h-4" />
                <span className="hidden sm:inline">设置</span>
              </Link>
              <button
                onClick={handleLogout}
                className="flex items-center gap-1 px-2.5 py-1.5 text-sm text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                title="登出"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">登出</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* 主内容 */}
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* 欢迎卡片 */}
        <div className="bg-white rounded-2xl shadow-xl p-8 md:p-10 border border-slate-200">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-green-100 rounded-lg">
              <ShieldCheck className="w-7 h-7 text-green-600" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-slate-800">
                你好，{user?.name || user?.login} 👋
              </h1>
              <p className="text-sm text-slate-500">
                认证 + 工作区已就绪，M3 起将开放 AI 与笔记功能
              </p>
            </div>
          </div>

          {/* Workspace 卡片 */}
          {repo && (
            <div className="mb-6 p-5 bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl">
              <div className="flex items-start gap-3 mb-3">
                <Github className="w-6 h-6 text-indigo-700 mt-1 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-indigo-600 font-semibold uppercase tracking-wide mb-1">
                    你的工作区
                  </div>
                  <div className="font-mono text-sm md:text-base text-slate-900 font-semibold break-all">
                    {repo.full_name}
                  </div>
                  {repo.description && (
                    <div className="text-xs text-slate-600 mt-1">
                      {repo.description}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                <div className="text-xs">
                  <div className="text-slate-500">可见性</div>
                  <div className="font-mono text-slate-800">
                    {repo.private ? '🔒 private' : '🌐 public'}
                  </div>
                </div>
                <div className="text-xs">
                  <div className="text-slate-500">默认分支</div>
                  <div className="font-mono text-slate-800">
                    {repo.default_branch}
                  </div>
                </div>
                <div className="text-xs">
                  <div className="text-slate-500">创建于</div>
                  <div className="font-mono text-slate-800">
                    {new Date(repo.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-xs">
                  <div className="text-slate-500">更新于</div>
                  <div className="font-mono text-slate-800">
                    {new Date(repo.updated_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
              <a
                href={repo.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-white border border-indigo-300 rounded-md text-xs text-indigo-700 hover:bg-indigo-50 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                在 GitHub 打开
              </a>
            </div>
          )}

          {/* 功能入口 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <Link
              to="/journal-format"
              className="group p-5 bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl hover:shadow-lg hover:border-indigo-300 transition-all"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 bg-indigo-100 rounded-lg group-hover:bg-indigo-200 transition">
                  <FileText className="w-6 h-6 text-indigo-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 group-hover:text-indigo-700 transition">
                    AI 期刊排版
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Markdown → LaTeX，按期刊格式自动排版，DOI 引用一键解析
                  </div>
                </div>
                <BookMarked className="w-5 h-5 text-indigo-400 group-hover:text-indigo-600 transition flex-shrink-0" />
              </div>
            </Link>

            <div className="p-5 bg-slate-50 border border-slate-200 rounded-xl opacity-60">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-slate-200 rounded-lg">
                  <Sparkles className="w-6 h-6 text-slate-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-700">
                    更多功能
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    词汇学习、文献追踪、笔记管理 — 开发中
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 认证状态 */}
          <div className="space-y-3 mb-6">
            <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
              <Github className="w-5 h-5 text-slate-700 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-slate-700 flex-1">
                <strong className="text-slate-900">授权 scope：</strong>
                <span className="ml-1 space-x-1">
                  {scopes.length > 0 ? (
                    scopes.map((s) => (
                      <span
                        key={s}
                        className="inline-block px-2 py-0.5 bg-white border border-slate-200 rounded text-xs font-mono text-slate-600"
                      >
                        {s}
                      </span>
                    ))
                  ) : (
                    <span className="text-slate-400">（无）</span>
                  )}
                </span>
              </div>
            </div>

            <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
              <Sparkles className="w-5 h-5 text-indigo-500 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-slate-700 flex-1">
                <strong className="text-slate-900">下一步 (M3)：</strong>
                设置页 + AI 双引擎（硅基流动 Qwen2.5-72B / DeepSeek-R1），跑通一次 fact_check。
              </div>
            </div>
          </div>

          {/* Build 元信息 */}
          <div className="pt-6 border-t border-slate-200 text-xs text-slate-400 font-mono space-y-1">
            <div>Build: {buildTime}</div>
            <div>Base: /AcademicFlow/</div>
            <div>License: AGPL-3.0-or-later</div>
            <div>Stage: M3 (设置页 + AI 双引擎)</div>
          </div>
        </div>
      </main>
    </div>
  )
}

export default Home
