/**
 * 临时样式预览脚手架（不提交）
 * -------------------------------------------------
 * 认证页之外的页面都挂在登录墙后面，改样式时没法直接看。
 * 这个入口把页面组件单独挂出来，绕过路由守卫，只用于本地肉眼校对。
 * 用法：/AcademicFlow/dev-preview.html?page=onboarding
 * 用完即删：dev-preview.html + src/dev-preview.tsx。
 */
import { StrictMode, Component, type ComponentType, type ReactNode } from 'react'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter initialEntries={['/']}>
      <Boundary>
        <Preview />
      </Boundary>
    </MemoryRouter>
  </StrictMode>,
)
