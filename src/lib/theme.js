// src/lib/theme.js · 深色模式（C6）
// ------------------------------------------------------------
// 只切 data-theme，不改任何版式结构：颜色令牌全部走 CSS 变量，
// 暗色变量集中在 styles/tokens.css 的 [data-theme='dark'] 里。
//
// 持久化到 localStorage，启动时由 main.jsx 调 initThemeMode() 应用，
// 避免首屏闪一下白。

const KEY = 'theme_mode'

/** 读当前主题：'light' | 'dark'（默认浅色） */
export function loadThemeMode() {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 应用主题：写 localStorage + 切 <html data-theme> */
export function applyThemeMode(mode) {
  const next = mode === 'dark' ? 'dark' : 'light'
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // 存储不可用时仍然切换本次会话
  }
  const root = document.documentElement
  if (next === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
  return next
}

/** 启动时调用：把上次选的主题装回去 */
export function initThemeMode() {
  return applyThemeMode(loadThemeMode())
}
