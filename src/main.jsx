/**
 * 应用入口
 * ------------------------------------------------------------
 * 两件事，顺序不能变：
 *   1. notifyReady() —— 启动握手，必须在渲染之前调用。
 *      不调的话热更新插件会判定「这次更新启动失败」并回滚到旧包。
 *   2. 挂载 React 根组件。
 *
 * 样式在这里统一引入，顺序有讲究：
 *   tokens.css（设计令牌，先）→ app.css（组件样式，后）
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { notifyReady } from './lib/updater.js'
import { initThemeMode } from './lib/theme.js'
import './styles/tokens.css'
import './styles/app.css'

// 启动握手：告诉原生层「这次启动是成功的」
notifyReady()
// 应用上次选择的主题（深色模式），必须在渲染前，避免首屏闪白
initThemeMode()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
