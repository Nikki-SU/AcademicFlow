/**
 * 顶部 Tab 导航布局
 * 所有功能模块通过顶部 Tab 切换
 */
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Search,
  Library,
  FileText,
  BookOpen,
  GraduationCap,
  PenTool,
  Send,
  Settings,
  LogOut,
  User,
} from 'lucide-react'
import { useAuthStore } from '../stores/auth'

const tabs = [
  { path: '/', label: '工作台', icon: LayoutDashboard },
  { path: '/tracking', label: '文献追踪', icon: Search },
  { path: '/library', label: '文献库', icon: Library },
  { path: '/pdf-to-md', label: 'PDF转MD', icon: FileText },
  { path: '/reading', label: '阅读', icon: BookOpen },
  { path: '/learn', label: '学习', icon: GraduationCap },
  { path: '/writing', label: '写作', icon: PenTool },
  { path: '/compile', label: '投稿编译', icon: Send },
]

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()

  const currentPath = location.pathname

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* 顶部导航栏 */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-4">
          <div className="flex items-center justify-between h-12">
            {/* Logo */}
            <Link to="/" className="flex items-center gap-2 flex-shrink-0 mr-4">
              <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center">
                <span className="text-white text-xs font-bold">AF</span>
              </div>
              <span className="font-semibold text-slate-800 text-sm hidden sm:block">AcademicFlow</span>
            </Link>

            {/* Tab 导航 */}
            <nav className="flex items-center gap-0.5 overflow-x-auto flex-1 no-scrollbar">
              {tabs.map((tab) => {
                const isActive = currentPath === tab.path || (tab.path !== '/' && currentPath.startsWith(tab.path))
                const Icon = tab.icon
                return (
                  <Link
                    key={tab.path}
                    to={tab.path}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium whitespace-nowrap transition ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="hidden md:inline">{tab.label}</span>
                  </Link>
                )
              })}
            </nav>

            {/* 右侧：用户 + 设置 */}
            <div className="flex items-center gap-1 flex-shrink-0 ml-4">
              <Link
                to="/settings"
                className={`p-2 rounded-md transition ${
                  currentPath === '/settings'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
                title="设置"
              >
                <Settings className="w-4 h-4" />
              </Link>

              {user ? (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-50">
                    <img
                      src={`https://avatars.githubusercontent.com/u/${user.id}?s=32`}
                      alt={user.login}
                      className="w-5 h-5 rounded-full"
                    />
                    <span className="text-xs text-slate-600 hidden lg:inline">@{user.login}</span>
                  </div>
                  <button
                    onClick={() => {
                      logout()
                      navigate('/login')
                    }}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                    title="登出"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <Link
                  to="/login"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-md transition"
                >
                  <User className="w-3.5 h-3.5" />
                  登录
                </Link>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
