import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App'
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
