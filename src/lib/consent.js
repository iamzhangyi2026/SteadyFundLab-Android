/**
 * 同意状态：使用说明 + 通知权限
 * ------------------------------------------------------------
 * 开源项目，两道提示，各只在首次问一次：
 *     ① 使用说明（PrivacyGate）—— 首次安装弹一次，点「知道了」即进入（不强制拦截）
 *     ② 通知权限（NotifyGate）—— 用户主动点「开启」才调系统权限框
 *
 * ⚠️ 本 App 不上报任何数据（ 已移除全部统计代码），
 *    所以「同意」只表示「看过说明」，不承载任何数据授权含义。
 */

const KEY = 'privacy_agreed_at'
const NOTIFY_KEY = 'notify_asked'

/**
 * 使用说明已读状态（首次安装弹一次，不强制拦截）
 * ------------------------------------------------------------
 * 未读时：首屏显示说明弹窗；点「知道了」后记录时间戳并进入 App。
 * @returns {string|null} 已读时间戳（毫秒字符串）；未读为 null
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
