import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // pdf.js 的 worker 是 ES module，自建 worker 入口（src/pdf.worker.ts）也必须以 module 形式打包
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } },
  },
})
