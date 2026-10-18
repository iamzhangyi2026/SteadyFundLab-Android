// lib/theme.js · 主题（浅色 / 深色 / 跟随系统）
//
// 设计：CSS 变量驱动 —— tokens.css 里 :root 是浅色，[data-theme="dark"] 是深色覆盖层。
// 本模块只负责「决定当前是 light 还是 dark」并写到 <html data-theme>。
// ⚠️ 组件颜色一律走 var()；canvas（ECharts）读不到 CSS 变量，用 themeColor() 取实际值。

export const THEME_MODES = ['light', 'dark', 'system']

const STORAGE_KEY = 'fundapp_theme'

/** 读取用户选择的模式（light | dark | system） */
export function getStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* localStorage 不可用 */ }
  return 'system'
}

/** 保存用户选择的模式 */
export function storeTheme(mode) {
  try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* 忽略 */ }
}

function systemPrefersDark() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  } catch { return false }
}

/** 模式 → 实际主题（system 时看系统） */
export function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode
  return systemPrefersDark() ? 'dark' : 'light'
}

const listeners = new Set()

/** 订阅主题变化（canvas 图表读不到 CSS 变量，需借此重绘）；返回取消函数 */
export function subscribeTheme(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 应用到 <html data-theme>，返回实际生效的主题 */
export function applyTheme(mode) {
  const resolved = resolveTheme(mode)
  try {
    document.documentElement.setAttribute('data-theme', resolved)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f141a' : '#F5F7FA')
  } catch { /* 忽略 */ }
  listeners.forEach((cb) => { try { cb(resolved) } catch { /* 单个订阅者出错不影响其他 */ } })
  return resolved
}

/** 当前是否深色主题 */
export function isDark() {
  try { return document.documentElement.getAttribute('data-theme') === 'dark' } catch { return false }
}

/** 读当前主题下的 CSS 变量实际值（ECharts 等 canvas 场景用） */
export function themeColor(name, fallback = '#000000') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name)
    return (v || '').trim() || fallback
  } catch { return fallback }
}

/** 监听系统主题变化；返回取消函数 */
export function watchSystemTheme(cb) {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => cb()
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  } catch { return () => {} }
}
