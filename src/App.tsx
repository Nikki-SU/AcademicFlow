/**
 * App 根组件：路由 + 全局初始化 + 路由保护
 * -------------------------------------------------
 * 顶部 Tab 导航布局，5 个核心页面（spec §5）
 */
import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Settings from './pages/Settings'
import TrackingPage from './pages/Tracking'
import ReadingPage from './pages/Reading'
import LearnPage from './pages/Learn'
import WritingPage from './pages/Writing'
import ManagementPage from './pages/Management'
import { useAuthStore } from './stores/auth'
import { useSettingsStore } from './stores/settings'
import { useWorkspaceStore } from './stores/workspace'

function App() {
  const initAuth = useAuthStore((s) => s.init)
  const initSettings = useSettingsStore((s) => s.init)
  const initWorkspace = useWorkspaceStore((s) => s.checkAndMaybeInit)

  useEffect(() => {
    initAuth()
    initSettings()
  }, [initAuth, initSettings])

  useEffect(() => {
    const token = useAuthStore.getState().token
    if (token) {
      initWorkspace()
    }
  }, [initWorkspace])

  return (
    <Routes>
      <Route path="/auth" element={<ProtectedAuthRoute />} />
      <Route path="/onboarding" element={<ProtectedOnboardingRoute />} />
      <Route path="*" element={<ProtectedMainRoute />} />
    </Routes>
  )
}

function ProtectedAuthRoute() {
  const { token, isInitialized } = useAuthStore()
  if (!isInitialized) return null
  if (token) return <Navigate to="/tracking" replace />
  return <Login />
}

function ProtectedOnboardingRoute() {
  const { token, isInitialized } = useAuthStore()
  const { isChecked, repo } = useWorkspaceStore()
  if (!isInitialized) return null
  if (!token) return <Navigate to="/auth" replace />
  if (isChecked && repo) return <Navigate to="/tracking" replace />
  return <Onboarding />
}

function ProtectedMainRoute() {
  const { token, isInitialized } = useAuthStore()
  const { isChecked, repo } = useWorkspaceStore()
  if (!isInitialized) return null
  if (!token) return <Navigate to="/auth" replace />
  if (isChecked && !repo) return <Navigate to="/onboarding" replace />
  return <AppLayout />
}

function AppLayout() {
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
        <Route path="/" element={<Navigate to="/tracking" replace />} />
      </Routes>
    </Layout>
  )
}

export default App
