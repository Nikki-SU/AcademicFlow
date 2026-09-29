/**
 * App 根组件：路由 + 全局初始化 + 路由保护
 * -------------------------------------------------
 * 顶部 Tab 导航布局。
 * 导航顺序（见 Layout.tsx 的 tabs）：日程 / 追踪 / 阅读 / 会议·课程 / 学习 / 写作 / 管理
 * （其中「日程」「会议·课程」是架构调整新增的空壳页，见 架构.md §2）
 */
import { useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import Layout from './components/Layout'
import { MigrationScreen } from './components/MigrationScreen'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Settings from './pages/Settings'
import SchedulePage from './pages/Schedule'
import TrackingPage from './pages/Tracking'
import ReadingPage from './pages/Reading'
import SessionPage from './pages/Session'
import LearnPage from './pages/Learn'
import WritingPage from './pages/Writing'
import ManagementPage from './pages/Management'
import { useAuthStore } from './stores/auth'
import { useSettingsStore, SENSITIVE_FIELDS } from './stores/settings'
import { useWorkspaceStore } from './stores/workspace'
import { useTaskStore } from './stores/task'
import { probeAsrKey } from './services/asr'
import {
  saveCredentialsVault,
  restoreCredentialsFromVault,
} from './services/credentialsVault'

function App() {
  const initAuth = useAuthStore((s) => s.init)
  const initSettings = useSettingsStore((s) => s.init)
  const syncSettingsFromGitHub = useSettingsStore((s) => s.syncFromGitHub)
  const initWorkspace = useWorkspaceStore((s) => s.checkAndMaybeInit)
  const loadCurrentTask = useTaskStore((s) => s.loadCurrent)
  const { isChecked, repo } = useWorkspaceStore()
  const token = useAuthStore((s) => s.token)
  const settingsReady = useSettingsStore((s) => s.isInitialized)
  const asrApiKey = useSettingsStore((s) => s.asrApiKey)
  const asrBaseUrl = useSettingsStore((s) => s.asrBaseUrl)
  const asrModel = useSettingsStore((s) => s.asrModel)

  useEffect(() => {
    initAuth()
    initSettings()
  }, [initAuth, initSettings])

  // 启动连通性自检：配了会议转写 Key 就真探一次硅基流动。
  // 只探 GET /models（轻量、不碰麦克风）；连不通当场报错，别等用户录了一分钟才发现没字。
  const asrCheckedRef = useRef(false)
  useEffect(() => {
    if (!settingsReady || !asrApiKey.trim() || asrCheckedRef.current) return
    asrCheckedRef.current = true
    void probeAsrKey({
      baseUrl: asrBaseUrl,
      apiKey: asrApiKey,
      asrModel,
      translateModel: '',
      translateToZh: false,
    }).then((r) => {
      if (!r.ok) {
        toast.error(`会议转写 Key 连不通：${r.detail}`, { duration: 12000 })
      } else {
        console.log(`[asr] 启动连通性自检通过：${r.detail}`)
      }
    })
  }, [settingsReady, asrApiKey, asrBaseUrl, asrModel])

  // 当 token 从 IndexedDB 恢复出来（或登录成功）后，检测/初始化 workspace 私库
  // 关键：依赖 token 本身，而不是只在 mount 时读一次 getState()
  useEffect(() => {
    if (token) {
      initWorkspace()
    }
  }, [token, initWorkspace])

  // workspace 就绪后从 GitHub 私库加载非敏感设置（SPEC §4.8）
  useEffect(() => {
    if (isChecked && repo) {
      syncSettingsFromGitHub()
    }
  }, [isChecked, repo, syncSettingsFromGitHub])

  // workspace 就绪后拉取「当前任务」（跨设备同步，见 stores/task.ts）
  useEffect(() => {
    if (isChecked && repo) {
      loadCurrentTask()
    }
  }, [isChecked, repo, loadCurrentTask])

  // 跨设备凭据回填：GitHub Secrets 只写不可读，新设备拿不到 Key；
  // 于是从私库保险箱（PAT 派生密钥加密的密文）解密，只回填本机为空的敏感字段。
  useEffect(() => {
    if (!isChecked || !repo || !token) return
    void restoreCredentialsFromVault(repo.owner.login, repo.name, token).then((filled) => {
      if (filled.length > 0) {
        toast.success(`已从私库保险箱回填 ${filled.length} 项凭据`)
      }
    })
  }, [isChecked, repo, token])

  // 敏感字段变化 → 防抖加密写回私库保险箱（sig 去重，内容没变不产生空提交）
  useEffect(() => {
    if (!isChecked || !repo || !token) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = useSettingsStore.subscribe((state, prev) => {
      const changed = SENSITIVE_FIELDS.some((f) => state[f] !== prev[f])
      if (!changed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void saveCredentialsVault(repo.owner.login, repo.name, token).catch((e) =>
          console.warn('[credentialsVault] 保存失败：', e),
        )
      }, 1500)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [isChecked, repo, token])

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
  // 数据格式迁移闸门：探测 / 升级期间把应用整个挡在后面（不渲染任何旧格式数据）
  const [migrationReady, setMigrationReady] = useState(false)
  if (!isInitialized) return null
  if (!token) return <Navigate to="/auth" replace />
  if (isChecked && !repo) return <Navigate to="/onboarding" replace />
  if (isChecked && repo && !migrationReady) {
    return <MigrationScreen onReady={() => setMigrationReady(true)} />
  }
  return <AppLayout />
}

function AppLayout() {
  return (
    <Layout>
      <Routes>
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/tracking" element={<TrackingPage />} />
        <Route path="/reading" element={<ReadingPage />} />
        <Route path="/session" element={<SessionPage />} />
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
