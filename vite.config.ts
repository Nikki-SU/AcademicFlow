import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

// GitHub Pages 项目页部署路径必须与仓库名一致（AcademicFlow）
// 结尾斜杠不能省，否则相对资源会 404
export default defineConfig({
  base: '/AcademicFlow/',
  plugins: [
    react(),
    // GitHub Pages SPA 路由支持：构建后复制 index.html → 404.html
    // 这样任何子路径刷新时都会回退到 index.html，由前端路由接管
    {
      name: 'spa-404-fallback',
      apply: 'build',
      closeBundle() {
        const outDir = path.resolve(__dirname, 'dist')
        const indexPath = path.join(outDir, 'index.html')
        const notFoundPath = path.join(outDir, '404.html')
        if (fs.existsSync(indexPath)) {
          fs.copyFileSync(indexPath, notFoundPath)
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    open: false,
    hmr: {
      path: '@vite/client',
    },
    // ═══ AI Provider Dev Proxy ═══
    // 浏览器没有走代理/VPN 时直连 API 会被墙。
    // Vite dev server（Node.js）能走 HTTPS_PROXY 环境变量出网，
    // 所以把 /ai-proxy/<provider>/* 代理到真实 API，
    // 浏览器同源请求，同时绕开 CORS + 网络问题。
    //
    // Provider 前缀映射（与 src/services/ai/devProxy.ts 保持一致）：
    //   /ai-proxy/deepseek/*  → https://api.deepseek.com/v1/*
    //   /ai-proxy/kimi/*      → https://api.moonshot.cn/v1/*
    //   /ai-proxy/qiniu/*     → https://api.qnaigc.com/v1/*
    proxy: {
      '/ai-proxy/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ai-proxy\/deepseek/, '/v1'),
        secure: true,
      },
      '/ai-proxy/kimi': {
        target: 'https://api.moonshot.cn',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ai-proxy\/kimi/, '/v1'),
        secure: true,
      },
      '/ai-proxy/qiniu': {
        target: 'https://api.qnaigc.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ai-proxy\/qiniu/, '/v1'),
        secure: true,
      },
    },
    // Dev 模式完全禁用 HTTP 缓存 — 防止 F5 刷出旧版
    configureServer(server: any) {
      server.middlewares.use((_req: any, res: any, next: any) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')
        res.setHeader('Surrogate-Control', 'no-store')
        next()
      })
    },
  } as any,
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('vditor')) return 'vditor'
          if (id.includes('react') || id.includes('react-router')) return 'react'
        },
      },
    },
  },
})
