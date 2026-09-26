/**
 * 临时样式预览脚手架（不提交）
 * -------------------------------------------------
 * 认证页之外的页面都挂在登录墙后面，改样式时没法直接看。
 * 这个入口把页面组件单独挂出来，绕过路由守卫，只用于本地肉眼校对。
 * 用法：/AcademicFlow/dev-preview.html?page=onboarding
 * 用完即删：dev-preview.html + src/dev-preview.tsx。
 */
import { StrictMode, Component, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '@fontsource-variable/crimson-pro'
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css'
import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css'
import 'lxgw-wenkai-webfont/lxgwwenkaimono-regular.css'
import './index.css'

import Layout from './components/Layout'
import Onboarding from './pages/Onboarding'
import Settings from './pages/Settings'
import JournalTemplates from './pages/JournalTemplates'
import Tracking from './pages/Tracking'
import Learn from './pages/Learn'
import Writing from './pages/Writing'
import Management from './pages/Management'
import { useSettingsStore } from './stores/settings'

const PAGES: Record<string, { comp: ComponentType; shell: boolean }> = {
  onboarding: { comp: Onboarding, shell: false },
  settings: { comp: Settings, shell: true },
  templates: { comp: JournalTemplates, shell: true },
  tracking: { comp: Tracking, shell: true },
  learn: { comp: Learn, shell: true },
  writing: { comp: Writing, shell: true },
  management: { comp: Management, shell: true },
}

class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null }
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) }
  }
  render() {
    if (this.state.err) {
      return (
        <div className="bg-red-50 p-4 font-mono text-xs text-red-700">
          render error: {this.state.err}
        </div>
      )
    }
    return this.props.children
  }
}

const key = new URLSearchParams(location.search).get('page') || 'onboarding'
const entry = PAGES[key]

function Preview() {
  if (!entry) {
    return (
      <div className="p-6 text-ink-500">
        未知页面。可选：{Object.keys(PAGES).join(' / ')}
      </div>
    )
  }
  const Page = entry.comp
  return entry.shell ? (
    <Layout>
      <Page />
    </Layout>
  ) : (
    <Page />
  )
}

/**
 * 真实 App 在 App.tsx 里调 initSettings（从 IndexedDB 恢复 API key 这类敏感凭据）。
 * 脚手架不走 App：不补这一步，页面会直接以「请先填写 AI-1 位的 API Key」报错；
 * 而且必须在**首次渲染之前**等它完成，所以这里挡一道 ready。
 */
function Bootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void useSettingsStore
      .getState()
      .init()
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])
  if (!ready) return null
  return <>{children}</>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter initialEntries={['/']}>
      <Boundary>
        <Bootstrap>
          <Preview />
        </Bootstrap>
      </Boundary>
    </MemoryRouter>
  </StrictMode>,
)
