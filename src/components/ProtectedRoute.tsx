/**
 * 路由守卫：未登录用户跳到 /login
 */
import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/auth'
import { BookOpen } from 'lucide-react'

interface Props {
  children: React.ReactNode
}

function ProtectedRoute({ children }: Props) {
  const { token, isInitialized } = useAuthStore()
  const location = useLocation()

  // 初始化还没跑完时，避免闪烁跳登录页
  if (!isInitialized) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50">
        <div className="p-3 bg-indigo-100 rounded-lg mb-4 animate-pulse">
          <BookOpen className="w-8 h-8 text-indigo-600" />
        </div>
        <div className="text-slate-500 text-sm">正在加载 AcademicFlow…</div>
      </div>
    )
  }

  if (!token) {
    // 记录来源，方便登录后跳回
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}

export default ProtectedRoute
