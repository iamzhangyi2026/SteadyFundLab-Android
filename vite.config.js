import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // base 必须是相对路径：Capacitor 用 file:// 或自定义 scheme 加载本地资源，
  // 用默认的 '/' 会导致所有 JS/CSS 404，界面白屏。
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
