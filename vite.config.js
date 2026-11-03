import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 本地开发 / 预览时把神经元 API 转发到线上（用 IP 绕开本机 DNS 缓存问题）
const neuralProxy = {
  '/neural-api': {
    target: 'https://47.238.233.55',
    changeOrigin: true,
    secure: false,
  },
}

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { proxy: neuralProxy },
  preview: { proxy: neuralProxy },
})