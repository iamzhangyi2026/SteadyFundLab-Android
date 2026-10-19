/**
 * 同意状态：隐私政策 + 通知权限
 * ------------------------------------------------------------
 * 正规流程，两道门，各只在首次问一次：
 *     ① 隐私政策（PrivacyGate）—— 同意后才进入 App
 *     ② 通知权限（NotifyGate）—— 用户主动点「开启」才调系统权限框
 *
 * 「同意」的确切含义：
 *    同意 = 用户知情后放行，它**是**上报的开关 ——
 *    点「知道了」之前，App 既不调 enableStats()、也不启动 usage 采集；
 *    同意之后才开启设备规格类上报（机型 / 系统版本 / App 版本 / 电量 / 使用时长）。
 *
 *    capacitor.config.json 里的 statsUrl 是空串，含义是「插件默认关闭」——
 *    真正的上报地址由 App.jsx 在同意后调 enableStats(STATS_URL) 在运行时设入。
 *    所以「config 里为空」≠「没有上报」，两者别混。
 */

const KEY = 'privacy_agreed_at'
const NOTIFY_KEY = 'notify_asked'

/**
 * 隐私政策同意状态（强同意）
 * ------------------------------------------------------------
 * 必须由用户主动点击「知道了」才进入 App。
 * 未同意前：不渲染 App 界面，也不发起任何请求。
 * @returns {string|null} 同意时间戳（毫秒字符串）；未同意为 null
 */
export function getConsent() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** 记录同意（用户点了隐私弹窗上的「知道了」） */
export function setConsent() {
  try {
    localStorage.setItem(KEY, String(Date.now()))
  } catch {
    // 隐私模式下可能不可用，忽略
  }
}

/* ------------------------------------------------------------------
   通知权限那一步问过没有 —— 记住标记，免得每次启动都问一遍
   ------------------------------------------------------------------ */

/** 是否已经问过通知权限（问过就不再弹第二道门） */
export function hasAskedNotify() {
  try {
    return localStorage.getItem(NOTIFY_KEY) === '1'
  } catch {
    return false
  }
}

/** 记录「已问过通知权限」（存储不可用时静默忽略） */
export function markNotifyAsked() {
  try {
    localStorage.setItem(NOTIFY_KEY, '1')
  } catch {
    // 忽略
  }
}
