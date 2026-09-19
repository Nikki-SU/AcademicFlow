/**
 * 临时验证页：写作页左侧栏「堆叠面板」布局自检。用完即删。
 * 访问 /AcademicFlow/nav-check.html
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import './index.css'
import Writing from './pages/Writing'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter>
      <div className="h-full">
        <Writing />
      </div>
    </MemoryRouter>
  </StrictMode>,
)
