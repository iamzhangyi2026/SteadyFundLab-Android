// src/lib/trade_days.js · 交易日推算与 15:00 截单
// ------------------------------------------------------------
// 基金交易按「交易日」走，两条规则：
//   ① 15:00 截单 —— 交易日 15:00 前提交按当日净值成交；15:00 后、以及非交易日
//      提交，顺延到下一个交易日；
//   ② 确认/到账按 T+n 个交易日 —— 普通基金申购 T+1 确认、赎回 T+1~T+3 到账，
//      QDII 更久。具体天数取接口字段（见 lib/trade_status.js），取不到就不推算。
//
// 「交易日」的判定：2026 年查 A 股交易日表（lib/trading_calendar.js，含法定节假日
// 与调休）；表外年份没有数据，降级为「只排周末」近似 —— 每年元旦补表后恢复精确。
// 境外市场（QDII）不做日历：休市自动反映在申购/赎回状态字段里，由 buyGate/sellGate 处理。

import { fmtDateStr } from './date.js'
import { inTradingTable, TABLE_YEAR } from './trading_calendar.js'

// 再导出，方便调用方统一从 trade_days 取交易日相关常量
export { TABLE_YEAR }

/** 截单时刻：15:00 */
export const CUTOFF_HOUR = 15

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 是否交易日：表内年份查表（含法定节假日），表外年份只排周末 */
export function isTradingDay(d) {
  const x = new Date(d)
  if (x.getFullYear() === TABLE_YEAR) return inTradingTable(x)
  const day = x.getDay()
  return day !== 0 && day !== 6
}

/** 顺延到下一个交易日（返回新 Date，不改入参） */
export function nextTradingDay(d) {
  const x = startOfDay(d)
  do {
    x.setDate(x.getDate() + 1)
  } while (!isTradingDay(x))
  return x
}

/** 加 n 个交易日（n <= 0 返回当天副本） */
export function addTradingDays(d, n) {
  let x = startOfDay(d)
  const step = Math.max(0, Math.floor(Number(n)) || 0)
  for (let i = 0; i < step; i++) x = nextTradingDay(x)
  return x
}

/**
 * 15:00 截单：这次提交实际按哪个交易日的净值成交
 * 15:00 整点算当日（含整点），15:00:01 起顺延；非交易日提交一律顺延。
 * 按设备系统时间解读（目标用户手机时区即北京时间）。
 * @param {Date|string|number} when 默认现在
 * @returns {Date} 生效交易日（本地零点）
 */
export function effectiveSubmitDay(when = new Date()) {
  const d = when instanceof Date ? new Date(when.getTime()) : new Date(when)
  if (Number.isNaN(d.getTime())) return startOfDay(new Date())
  const cutoff = new Date(d)
  cutoff.setHours(CUTOFF_HOUR, 0, 0, 0)
  if (!isTradingDay(d) || d.getTime() > cutoff.getTime()) return nextTradingDay(d)
  return startOfDay(d)
}

/** 该日期是否落在交易日历覆盖的年份内（当前仅 2026 有精确表；
 *  表外年份 isTradingDay 会降级「只排周末」，结果仅供参考） */
export function isCoveredYear(d) {
  const x = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(x.getTime())) return false
  return x.getFullYear() === TABLE_YEAR
}

/** 生效交易日 → YYYY-MM-DD */
export function effectiveSubmitDayStr(when = new Date()) {
  return fmtDateStr(effectiveSubmitDay(when))
}

/**
 * 申购确认日：生效日 + n 个交易日。n 取不到时返回 null（不猜）
 * @param {Date|string} submitDay 生效交易日
 * @param {number|null} n 接口给的确认天数
 */
export function confirmDayStr(submitDay, n) {
  if (!Number.isFinite(n) || n <= 0) return null
  return fmtDateStr(addTradingDays(submitDay, n))
}
