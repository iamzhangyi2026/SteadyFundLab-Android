/**
 * 应用入口
 * ------------------------------------------------------------
 * 挂载 React 根组件。
 *
 * 样式在这里统一引入，顺序有讲究：
 *   tokens.css（设计令牌，先）→ app.css（组件样式，后）
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { initThemeMode } from './lib/theme.js'
import { applySeed } from './lib/seed.js'
import './styles/tokens.css'
import './styles/app.css'

/* 种子数据写入本地缓存（秒开）：必须在渲染前，同步完成。
   已有真实缓存的不覆盖 —— 快照只用来填首次的空窗。 */
applySeed()
// 应用上次选择的主题（深色模式），必须在渲染前，避免首屏闪白
initThemeMode()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
