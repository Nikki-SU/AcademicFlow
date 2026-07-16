/**
 * App 根组件：路由 + 全局初始化
 * -------------------------------------------------
 * 顶部 Tab 导航布局，所有功能模块通过 Tab 切换
 */
import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import Home from './pages/Home'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Settings from './pages/Settings'
import JournalFormat from './pages/JournalFormat'
import JournalTemplates from './pages/JournalTemplates'
import TrackingPage from './pages/Tracking'
import LibraryPage from './pages/Library'
import PdfToMdPage from './pages/PdfToMd'
import ReadingPage from './pages/Reading'
import LearnPage from './pages/Learn'
import WritingPage from './pages/Writing'
import CompilePage from './pages/Compile'
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
        <Route path="/" element={<Home />} />
        <Route path="/tracking" element={<TrackingPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/pdf-to-md" element={<PdfToMdPage />} />
        <Route path="/reading" element={<ReadingPage />} />
        <Route path="/learn" element={<LearnPage />} />
        <Route path="/writing" element={<WritingPage />} />
        <Route path="/compile" element={<CompilePage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/journal-format" element={<JournalFormat />} />
        <Route path="/journal-templates" element={<JournalTemplates />} />
        <Route path="/onboarding" element={<Onboarding />} />
      </Route>

      {/* 兜底 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

/** 带 Layout 的路由包装 */ 
function AppLayout() {
  const location = useLocation()
  const isLoginPage = location.pathname === '/login'

  if (isLoginPage) {
    return <Navigate to="/" replace />
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/tracking" element={<TrackingPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/pdf-to-md" element={<PdfToMdPage />} />
        <Route path="/reading" element={<ReadingPage />} />
        <Route path="/learn" element={<LearnPage />} />
        <Route path="/writing" element={<WritingPage />} />
        <Route path="/compile" element={<CompilePage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/journal-format" element={<JournalFormat />} />
        <Route path="/journal-templates" element={<JournalTemplates />} />
        <Route path="/onboarding" element={<Onboarding />} />
      </Routes>
    </Layout>
  )
}

export default App
