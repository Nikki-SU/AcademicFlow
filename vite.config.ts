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
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Vditor 是 CJS/UMD 大依赖，单独 chunk 避免主包过大
    rollupOptions: {
      output: {
        manualChunks: {
          vditor: ['vditor'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
})
