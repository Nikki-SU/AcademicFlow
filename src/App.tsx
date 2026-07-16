/**
 * App 根组件：路由 + 全局初始化
 * -------------------------------------------------
 * 顶部 Tab 导航布局，5 个核心页面
 */
import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Settings from './pages/Settings'
import TrackingPage from './pages/Tracking'
import ReadingPage from './pages/Reading'
import LearnPage from './pages/Learn'
import WritingPage from './pages/Writing'
import ManagementPage from './pages/Management'
import JournalFormat from './pages/JournalFormat'
import JournalTemplates from './pages/JournalTemplates'
import { useAuthStore } from './stores/auth'
import { useSettingsStore } from './stores/settings'

function App() {
  const initAuth = useAuthStore((s) => s.init)
  const initSettings = useSettingsStore((s) => s.init)

  useEffect(() => {
    initAuth()
    initSettings()
  }, [initAuth, initSettings])

  return (
    <Routes>
      {/* 登录页：无布局 */}
      <Route path="/login" element={<Login />} />

      {/* 有顶部 Tab 导航的布局 */}
      <Route element={<AppLayout />}>
        <Route path="/tracking" element={<TrackingPage />} />
        <Route path="/reading" element={<ReadingPage />} />
        <Route path="/learn" element={<LearnPage />} />
        <Route path="/writing" element={<WritingPage />} />
        <Route path="/management" element={<ManagementPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/journal-format" element={<JournalFormat />} />
        <Route path="/journal-templates" element={<JournalTemplates />} />
        {/* 默认重定向到追踪页 */}
        <Route path="/" element={<Navigate to="/tracking" replace />} />
      </Route>

      {/* 兜底 */}
      <Route path="*" element={<Navigate to="/tracking" replace />} />
    </Routes>
  )
}

/** 带 Layout 的路由包装 */ 
function AppLayout() {
  const location = useLocation()
  const isLoginPage = location.pathname === '/login'

  if (isLoginPage) {
    return <Navigate to="/tracking" replace />
  }

  return (
    <Layout>
      <Routes>
        <Route path="/tracking" element={<TrackingPage />} />
        <Route path="/reading" element={<ReadingPage />} />
        <Route path="/learn" element={<LearnPage />} />
        <Route path="/writing" element={<WritingPage />} />
        <Route path="/management" element={<ManagementPage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/journal-format" element={<JournalFormat />} />
        <Route path="/journal-templates" element={<JournalTemplates />} />
        <Route path="/" element={<Navigate to="/tracking" replace />} />
      </Routes>
    </Layout>
  )
}

export default App
