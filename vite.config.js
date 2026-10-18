import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  resolve: {
    alias: {
      // Node-only modules（rules.ts / ledger.ts 的 _selfTest 运行时用到）；
      // 在 WebView 打包时置空 stub，避免 vite 报 "is not exported by __vite-browser-external"
      'node:url': 'src/core/shim/node-url.ts',
      'node:process': 'src/core/shim/node-process.ts',
      'echarts/core': 'echarts/core.js',
      'echarts/charts': 'echarts/charts.js',
      'echarts/components': 'echarts/components.js',
      'echarts/renderers': 'echarts/renderers.js',
      'echarts-for-react/lib/core': 'echarts-for-react/lib/core.js',
    },
  },
  // Android 纯前端架构：无后端代理，vite dev server 仅用于本地开发调试
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
