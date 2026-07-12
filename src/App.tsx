/**
 * App 根组件：路由 + 全局初始化
 * -------------------------------------------------
 * 路由：
 * - /            → Home（受保护）
 * - /onboarding  → Onboarding（受保护，M2 引导页）
 * - /login       → Login
 * - *            → 重定向到 /
 */
import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import Home from './pages/Home'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Settings from './pages/Settings'
import { useAuthStore } from './stores/auth'
import { useSettingsStore } from './stores/settings'

function App() {
  const initAuth = useAuthStore((s) => s.init)
  const initSettings = useSettingsStore((s) => s.init)

  useEffect(() => {
    // 应用启动时从 IndexedDB 恢复登录态 + 用户设置
    initAuth()
    initSettings()
  }, [initAuth, initSettings])

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
      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            <Onboarding />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        }
      />
      {/* 兜底：未知路径回首页（首页会再判断是否已登录 / 已 onboarding） */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
