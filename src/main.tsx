import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App'

// 自托管字体：站点 CSP 是 font-src 'self' data:，不能引外部 CDN
// 文楷按 unicode-range 切成 97 片，浏览器只下用到的几片
import '@fontsource-variable/crimson-pro'
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css'
import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css'
import 'lxgw-wenkai-webfont/lxgwwenkaimono-regular.css'

import './index.css'

// Vite `base` 是 /AcademicFlow/，BrowserRouter 需要匹配的 basename
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={BASENAME}>
      <App />
      <Toaster
        position="top-center"
        richColors
        closeButton
        duration={3500}
      />
    </BrowserRouter>
  </StrictMode>,
)
