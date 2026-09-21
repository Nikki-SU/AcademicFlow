/**
 * 顶部 Tab 导航布局
 * 五个核心页面：追踪、阅读、学习、写作、管理
 * （「排版」不再是独立页面 —— 已并进写作页的 LaTeX 工作区）
 */
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Search,
  BookOpen,
  GraduationCap,
  PenTool,
  FolderCog,
  Settings,
  LogOut,
  User,
  ChevronDown,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
  X,
} from 'lucide-react'
import { useAuthStore } from '../stores/auth'
import { subscribeGlobalAuthError, clearGlobalAuthError } from '../services/authError'
import { useOrientation } from '../hooks/useOrientation'

const tabs = [
  { path: '/tracking', label: '追踪', icon: Search },
  { path: '/reading', label: '阅读', icon: BookOpen },
  { path: '/learn', label: '学习', icon: GraduationCap },
  { path: '/writing', label: '写作', icon: PenTool },
  { path: '/management', label: '管理', icon: FolderCog },
]

import type { GitHubUser } from '../types'

function AuthDropdown({ user, method, expiresAt, logout, navigate, orientation }: {
  user: GitHubUser | null
  method: 'device_flow' | 'pat' | null
  expiresAt: number | null
  logout: () => Promise<void>
  navigate: (to: string) => void
  orientation: 'landscape' | 'portrait'
}) {
  const [isOpen, setIsOpen] = useState(false)

  const getDaysUntilExpire = () => {
    if (!expiresAt) return null
    const diff = expiresAt - Date.now()
    return Math.ceil(diff / (1000 * 60 * 60 * 24))
  }

  const daysUntilExpire = getDaysUntilExpire()
  const isExpiringSoon = daysUntilExpire !== null && daysUntilExpire <= 7

  const handleLogout = () => {
    if (confirm('登出后本设备的登录态将被清除。如需彻底撤销此设备对 GitHub 的访问权限，请到 GitHub → Settings → Applications 手动 revoke。')) {
      logout()
      navigate('/auth')
    }
  }

  const handleReLogin = () => {
    logout()
    navigate('/auth')
  }

  const authUrl = method === 'device_flow'
    ? 'https://github.com/settings/applications'
    : 'https://github.com/settings/tokens'

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-2 py-1 rounded-md bg-slate-50 hover:bg-slate-100 transition"
      >
        <div
          className="w-6 h-6 rounded-full bg-gradient-to-br from-slate-100 to-slate-200 border border-slate-300 flex items-center justify-center text-[14px] leading-none shrink-0 shadow-inner"
          title={user?.login ?? '未登录'}
        >
          🕊️
        </div>
        {orientation === 'landscape' && (
          <span className="text-xs text-slate-600">@{user?.login}</span>
        )}
        <div className={`px-1.5 py-0.5 rounded text-xs font-medium ${
          isExpiringSoon && daysUntilExpire !== null && daysUntilExpire >= 0
            ? 'bg-red-100 text-red-700'
            : daysUntilExpire !== null && daysUntilExpire < 0
              ? 'bg-slate-200 text-slate-500'
              : 'bg-indigo-100 text-indigo-700'
        }`}>
          {'PAT'}
        </div>
        {daysUntilExpire !== null && (
          <span className={`text-xs ${isExpiringSoon && daysUntilExpire >= 0 ? 'text-red-600' : 'text-slate-400'}`}>
            {daysUntilExpire >= 0 ? `(${daysUntilExpire}天)` : '(已过期)'}
          </span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-50">
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            <ExternalLink className="w-4 h-4" />
            查看/管理 GitHub 授权
          </a>
          <button
            onClick={handleReLogin}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className="w-4 h-4" />
            重新登录
          </button>
          <div className="border-t border-slate-100 my-1" />
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
          >
            <LogOut className="w-4 h-4" />
            登出
          </button>
        </div>
      )}
    </div>
  )
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const orientation = useOrientation()
  const { user, method, expiresAt, logout, token } = useAuthStore()
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    return subscribeGlobalAuthError((err) => setAuthError(err))
  }, [])

  // Token 变化时自动解冻 —— 用户换了新 token 后不需要手动点"重新登录"
  useEffect(() => {
    if (token && authError) {
      console.info('[Layout] 检测到新 token，自动清除冻结状态')
      clearGlobalAuthError()
    }
  }, [token, authError])

  const currentPath = location.pathname

  const daysUntilExpire = expiresAt
    ? Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
    : null
  const showExpiryBanner =
    daysUntilExpire !== null && (daysUntilExpire <= 7 || daysUntilExpire < 0)

  const handleReLogin = () => {
    clearGlobalAuthError()
    logout()
    navigate('/auth')
  }

  return (
    /*
     * 外壳用 h-screen + overflow-hidden 把「视口高度」变成确定值，
     * 主内容区再自己滚动。这样页面里直接写 h-full 就能撑满，
     * 不需要再各自算 calc(100vh - 3rem) —— 那个算法一旦多出 PAT 横幅就会算错。
     */
    <div className="h-screen bg-slate-50 flex flex-col overflow-hidden">
      {/* PAT 过期横幅 */}
      {showExpiryBanner && user && (
        <div className={`px-4 py-2 text-sm flex items-center justify-center gap-2 ${
          daysUntilExpire < 0 ? 'bg-slate-200 text-slate-600' : 'bg-red-50 text-red-700'
        }`}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>
            {daysUntilExpire < 0
              ? '你的 GitHub PAT 已过期，写操作已暂停。请重新登录。'
              : `你的 GitHub PAT 将在 ${daysUntilExpire} 天后过期，建议尽快更换。`}
          </span>
          <button
            onClick={handleReLogin}
            className="underline hover:no-underline font-medium ml-1"
          >
            重新登录
          </button>
        </div>
      )}

      {/* 顶部导航栏 */}
      <header className="bg-white border-b border-slate-200 z-50 flex-shrink-0">
        <div className="page-container">
          <div className="flex items-center justify-between h-12">
            {/* Logo */}
            <Link to="/tracking" className="flex items-center gap-2 flex-shrink-0 mr-6">
              <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center">
                <span className="text-white text-xs font-bold">AF</span>
              </div>
              {orientation === 'landscape' && (
                <span className="font-semibold text-slate-800 text-sm">AcademicFlow</span>
              )}
            </Link>

            {/* Tab 导航 */}
            <nav className="flex items-center gap-1 flex-1">
              {tabs.map((tab) => {
                const isActive = currentPath === tab.path || currentPath.startsWith(tab.path + '/')
                const Icon = tab.icon
                return (
                  <Link
                    key={tab.path}
                    to={tab.path}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap transition ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{tab.label}</span>
                  </Link>
                )
              })}
            </nav>

            {/* 右侧：设置 + 用户 */}
            <div className="flex items-center gap-2 flex-shrink-0 ml-4">
              <Link
                to="/settings"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition ${
                  currentPath === '/settings'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
                title="设置"
              >
                <Settings className="w-4 h-4" />
                {orientation === 'landscape' && <span>设置</span>}
              </Link>

              {user ? (
                <AuthDropdown
                  user={user}
                  method={method}
                  expiresAt={expiresAt}
                  logout={logout}
                  navigate={navigate}
                  orientation={orientation}
                />
              ) : (
                <Link
                  to="/auth"
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

      {/* 主内容区：唯一的滚动容器；页面写 h-full 即可撑满 */}
      <main className="flex-1 min-h-0 overflow-auto">
        {children}
      </main>

      {/* 全局 Token 失效 modal */}
      {authError && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-red-100 rounded-full">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-slate-800">GitHub 授权失败</h3>
                <p className="mt-2 text-sm text-slate-600">{authError}</p>
                <p className="mt-2 text-xs text-slate-500">
                  在重新登录前，所有写入 GitHub 私库的操作已被冻结，防止数据丢失。
                </p>
              </div>
              <button
                onClick={() => clearGlobalAuthError()}
                className="text-slate-400 hover:text-slate-600"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => clearGlobalAuthError()}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                稍后处理
              </button>
              <button
                onClick={handleReLogin}
                className="px-4 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 rounded-lg transition"
              >
                重新登录
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
