// src/lib/date.js · 本地日期（YYYY-MM-DD）
// ------------------------------------------------------------
// 一律用本地 getFullYear/getMonth/getDate 拼字符串，不用 toISOString()：
// toISOString 输出的是 UTC 时间，东八区在 00:00–08:00 之间会整整早一天。
// 这里按设备系统时间取年月日（目标用户手机时区即北京时间）。

const pad = (n) => String(n).padStart(2, '0')

function fmt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 今天的本地（系统）日期 */
export function todayStr() {
  return fmt(new Date())
}

/** 时间戳 / 日期对象 → 本地（系统）日期字符串；解析不出来返回空串 */
export function toLocalDateStr(v) {
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? '' : fmt(d)
}

/** 今天往后（n 为正则往后）n 年的本地（系统）日期 */
export function plusYearsStr(n) {
  const d = new Date()
  d.setFullYear(d.getFullYear() + n)
  return fmt(d)
}

/** 日期对象 → 本地（系统）日期字符串 */
export function fmtDateStr(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return ''
  return fmt(d)
}
