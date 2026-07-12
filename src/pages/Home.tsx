/**
 * 已登录首页
 * -------------------------------------------------
 * M1 阶段作为占位主页，显示当前登录信息和 M0 时的 Hello 卡片。
 * M2 会在这里挂上真正的工作台入口（笔记列表 / 新建笔记 / AI 对话等）。
 */
import {
  BookOpen,
  CheckCircle2,
  Github,
  LogOut,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'

function Home() {
  const { user, scopes, logout } = useAuthStore()
  const buildTime = new Date().toISOString()

  const handleLogout = async () => {
    await logout()
    toast.success('已登出，token 已从本地清除')
  }

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
      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* 欢迎卡片 */}
        <div className="bg-white rounded-2xl shadow-xl p-8 md:p-10 border border-slate-200">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-green-100 rounded-lg">
              <CheckCircle2 className="w-7 h-7 text-green-600" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-slate-800">
                你好，{user?.name || user?.login} 👋
              </h1>
              <p className="text-sm text-slate-500">
                M1 认证模块已就绪，M2 起可以开始搭建笔记工作台
              </p>
            </div>
          </div>

          {/* 认证状态卡片 */}
          <div className="space-y-3 mb-8">
            <div className="flex items-start gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
              <ShieldCheck className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-slate-700 flex-1">
                <strong className="text-slate-900">已认证：</strong>
                GitHub PAT 有效，Token 仅存于你浏览器的 IndexedDB
              </div>
            </div>

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
                <strong className="text-slate-900">下一步 (M2)：</strong>
                前端调用 GitHub API 自动创建私库 <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">academicflow-workspace</span>，作为你的笔记后端仓库。
              </div>
            </div>
          </div>

          {/* Build 元信息 */}
          <div className="pt-6 border-t border-slate-200 text-xs text-slate-400 font-mono space-y-1">
            <div>Build: {buildTime}</div>
            <div>Base: /AcademicFlow/</div>
            <div>License: AGPL-3.0-or-later</div>
            <div>Stage: M1 (认证已通)</div>
          </div>
        </div>
      </main>
    </div>
  )
}

export default Home
