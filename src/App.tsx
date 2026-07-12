/**
 * App 根组件：路由 + 全局初始化
 * -------------------------------------------------
 * 路由：
 * - /       → Home（受保护）
 * - /login  → Login
 * - *       → 重定向到 /
 */
import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import Home from './pages/Home'
import Login from './pages/Login'
import { useAuthStore } from './stores/auth'

function App() {
  const init = useAuthStore((s) => s.init)

  useEffect(() => {
    // 应用启动时从 IndexedDB 恢复登录态
    init()
  }, [init])

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Home />
          </ProtectedRoute>
        }
      />
      {/* 兜底：未知路径回首页（首页会再判断是否已登录） */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
