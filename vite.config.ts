import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// GitHub Pages 项目页部署路径必须与仓库名一致（AcademicFlow）
// 结尾斜杠不能省，否则相对资源会 404
export default defineConfig({
  base: '/AcademicFlow/',
  plugins: [react()],
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
