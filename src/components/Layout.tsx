/**
 * 顶部 Tab 导航布局
 * 五个核心页面：追踪、阅读、学习、写作、管理
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

const tabs = [
  { path: '/tracking', label: '追踪', icon: Search },
  { path: '/reading', label: '阅读', icon: BookOpen },
  { path: '/learn', label: '学习', icon: GraduationCap },
  { path: '/writing', label: '写作', icon: PenTool },
  { path: '/management', label: '管理', icon: FolderCog },
]

import type { GitHubUser } from '../types'

function AuthDropdown({ user, method, expiresAt, logout, navigate }: {
  user: GitHubUser | null
  method: 'device_flow' | 'pat' | null
  expiresAt: number | null
  logout: () => Promise<void>
  navigate: (to: string) => void
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
        <img
          src={`https://avatars.githubusercontent.com/u/${user?.id}?s=32`}
          alt={user?.login}
          className="w-5 h-5 rounded-full"
        />
        <span className="text-xs text-slate-600 hidden lg:inline">@{user?.login}</span>
        <div className={`px-1.5 py-0.5 rounded text-xs font-medium ${
          isExpiringSoon && daysUntilExpire !== null && daysUntilExpire >= 0
            ? 'bg-red-100 text-red-700'
            : daysUntilExpire !== null && daysUntilExpire < 0
              ? 'bg-slate-200 text-slate-500'
              : 'bg-indigo-100 text-indigo-700'
        }`}>
          {method === 'device_flow' ? 'Device Flow' : 'PAT'}
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
  const { user, method, expiresAt, logout } = useAuthStore()
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    return subscribeGlobalAuthError((err) => setAuthError(err))
  }, [])

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
    <div className="min-h-screen bg-slate-50 flex flex-col">
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
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-[100rem] mx-auto px-4">
          <div className="flex items-center justify-between h-12">
            {/* Logo */}
            <Link to="/tracking" className="flex items-center gap-2 flex-shrink-0 mr-6">
              <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center">
                <span className="text-white text-xs font-bold">AF</span>
              </div>
              <span className="font-semibold text-slate-800 text-sm hidden sm:block">AcademicFlow</span>
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
                <span className="hidden sm:inline">设置</span>
              </Link>

              {user ? (
                <AuthDropdown
                  user={user}
                  method={method}
                  expiresAt={expiresAt}
                  logout={logout}
                  navigate={navigate}
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

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto">
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
