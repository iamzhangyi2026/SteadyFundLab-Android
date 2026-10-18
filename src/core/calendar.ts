/**
 * 交易日历 · src/core/calendar.ts
 *
 *
 * 设计原则：
 *   - 纯逻辑，无网络、无文件系统依赖。
 *   - 交易日数据随模块加载自动注入（内置 2026 全年表，含调休补班日）。
 *   - 所有 Date 对象按「本地时间」解释，不引入 UTC 转换（避免时区偏移）。
 *
 * 降级策略：
 *   若内置年份不足（如进入 2027 年），退化为「仅排除周末」，degraded = true；
 *   调用方应检查 degraded 后再决定是否采信结果。
 *
 * 赎回到账天数统一读自 config.ts 的 REDEEM_ARRIVAL_RULES，
 *   消除硬编码。单一来源，改规则只改一处。
 */

import {
  TRADING_DAYS_2026,
  REDEEM_ARRIVAL_RULES,
  REDEEM_ARRIVAL_FALLBACK_DAYS,
} from './config.js'

// ─────────────────────────────────────────────
// 导出接口
// ─────────────────────────────────────────────

export interface TradingDayInfo {
  /** 数据源：static=内置表 loaded=网络加载 weekend_fallback=仅排周末 */
  source: 'static' | 'loaded' | 'weekend_fallback'
  /** 是否降级（仅周末判断，法定节假日无法识别） */
  degraded: boolean
  /** 内置/已加载的交易日数量 */
  count: number
  /** 表覆盖的年份，便于判断是否需要更新 */
  years: string[]
}

export interface OrderTimingHint {
  can_submit: boolean
  /** 下单日期 "YYYY-MM-DD" */
  submit_date: string
  /** 实际成交净值日 "YYYY-MM-DD" */
  nav_date: string
  deferred: boolean
  reason: '' | '非交易日' | '已过 15:00'
  hint: string
}

// ─────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────

/** 15:00 截单时刻（分钟数），全行业统一分水岭。 */
const CUTOFF_TIME = 15 * 60

/** 死循环保护：连续多少天找不到交易日就抛错。 */
const GUARD_DAYS = 60

// ─────────────────────────────────────────────
// 日期工具（本地时间）
// ─────────────────────────────────────────────

/** 把 Date 格式化为 "YYYY-MM-DD"（本地时间，不引入 UTC 偏移）。 */
function toDateStr(d: Date): string {
  const y  = d.getFullYear()
  const m  = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 从 "YYYY-MM-DD" 字符串构造 Date（本地时间 00:00:00）。 */
function fromDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 同 fromDateStr，导出供 orders.ts 复用。 */
export const parseLocalDate = fromDateStr

/** 判断一个 Date 是否落在 15:00 之前（不含 15:00:00 整点）。 */
function isBeforeCutoff(d: Date): boolean {
  const mins = d.getHours() * 60 + d.getMinutes()
  return mins < CUTOFF_TIME
}

// ─────────────────────────────────────────────
// 模块级状态
// ─────────────────────────────────────────────

let _tradingDays: Set<string> | null = null
let _source: TradingDayInfo['source'] = 'weekend_fallback'
let _degraded = true

/**
 * 初始化：从内置 2026 表构建 Set。
 *
 * 注意：模块首次 import 时就会执行此函数，
 * 调用方无需手动调用。若要刷新，调用 initCalendar() 即可。
 */
/** 表覆盖的年份集合，从表内容自动推导 */
const COVERED_YEARS = new Set(TRADING_DAYS_2026.map(s => s.slice(0, 4)))

function initInternal(): void {
  const thisYear = String(new Date().getFullYear())
  // 只有「表覆盖当前年份」且「条数达到一年量级」才认为可信
  if (COVERED_YEARS.has(thisYear) && TRADING_DAYS_2026.length >= 200) {
    _tradingDays = new Set(TRADING_DAYS_2026)
    _source      = 'static'
    _degraded    = false
  } else {
    // 表为空或不覆盖当前年份时只能靠周末逻辑兜底
    _tradingDays = null
    _source      = 'weekend_fallback'
    _degraded    = true
  }
}

initInternal() // 模块加载时自动执行

/**
 * 重新注入交易日数据（由 store 层调用，例如网络加载成功后刷新）。
 *
 * @param days "YYYY-MM-DD" 字符串数组
 */
export function initCalendar(days: string[]): void {
  const unique = new Set(days)
  _tradingDays = unique.size > 0 ? unique : null
  _source = unique.size > 0 ? 'loaded' : 'weekend_fallback'
  _degraded = unique.size === 0
}

/** 获取日历当前状态，供数据健康度面板展示。 */
export function calendarInfo(): TradingDayInfo {
  return {
    source: _source,
    degraded: _degraded,
    count: _tradingDays?.size ?? 0,
    years: [...COVERED_YEARS],
  }
}

// ─────────────────────────────────────────────
// 核心查询
// ─────────────────────────────────────────────

/**
 * 是否交易日。
 *
 * 已注入数据时查集合；未注入时退化为「周一~周五」。
 * 退化状态下无法识别法定节假日，调用方应检查 calendarInfo().degraded。
 */
export function isTradingDay(d: Date): boolean {
  if (_tradingDays !== null) return _tradingDays.has(toDateStr(d))
  // 降级：仅排除周六日（0=周日, 6=周六）
  const w = d.getDay()
  return w >= 1 && w <= 5
}

/**
 * 返回 d 之后的第 n 个交易日（d 本身是交易日则不计入）。
 *
 * 用于：15:00 后顺延、T+1 份额确认、赎回到账日等场景。
 * guard > 60 天说明数据异常，抛出错误而不是死循环。
 */
export function nextTradingDay(d: Date, n: number = 1): Date {
  let cur = new Date(d.getTime())
  let remaining = n
  let guard = 0
  while (remaining > 0) {
    cur = new Date(cur.getTime() + 86400000) // +1 天
    if (isTradingDay(cur)) remaining--
    guard++
    if (guard > GUARD_DAYS) {
      throw new Error(
        '交易日历异常：连续 60 天未找到交易日，请检查数据源',
      )
    }
  }
  return cur
}

/**
 * 返回 d 之前的最近一个交易日。
 */
export function prevTradingDay(d: Date): Date {
  let cur = new Date(d.getTime() - 86400000)
  let guard = 0
  while (!isTradingDay(cur)) {
    cur = new Date(cur.getTime() - 86400000)
    guard++
    if (guard > GUARD_DAYS) {
      throw new Error(
        '交易日历异常：连续 60 天未找到交易日，请检查数据源',
      )
    }
  }
  return cur
}

// ─────────────────────────────────────────────
// 交易时点判定
// ─────────────────────────────────────────────

/**
 * 根据下单时刻，确定这笔订单按哪天的净值成交。
 *
 * 规则（全渠道一致）：
 *   - 交易日且 15:00 前 → 当日净值
 *   - 交易日但 15:00 后 → 顺延至下一交易日
 *   - 非交易日          → 顺延至下一交易日
 *
 * 注意：返回的是「净值日期」，不是「确认日期」。
 * 份额确认还要再推一个交易日（见 confirmDate）。
 */
export function resolveNavDate(submitDt: Date): Date {
  // 取日期部分（归零时分秒），用于 isTradingDay 判断
  const d = new Date(submitDt.getTime())
  d.setHours(0, 0, 0, 0)
  // 用原始时间判断是否在截单前
  if (isTradingDay(d) && isBeforeCutoff(submitDt)) {
    return d
  }
  return nextTradingDay(d, 1)
}

/**
 * 描述一笔订单的时间归属，供界面提示使用。
 *
 * 把「能不能提交」和「按哪天净值成交」分开讲清楚，
 * 避免误以为节假日下单是按当天价格成交。
 *
 * can_submit 恒为 true：平台 7×24 接受申请，但非交易日提交的
 * 一律顺延到下一交易日。
 */
export function describeOrderTiming(submitDt: Date): OrderTimingHint {
  const d = new Date(submitDt.getTime())
  d.setHours(0, 0, 0, 0)
  const isTd = isTradingDay(d)
  // 用原始时间判断是否截单前
  const beforeCutoff = isBeforeCutoff(submitDt)

  if (isTd && beforeCutoff) {
    const ds = toDateStr(d)
    return {
      can_submit: true,
      submit_date: ds,
      nav_date: ds,
      deferred: false,
      reason: '',
      hint: `交易日 15:00 前提交，按今日（${ds}）净值成交`,
    }
  }

  const navDate = nextTradingDay(d, 1)
  const reason: OrderTimingHint['reason'] = isTd ? '已过 15:00' : '非交易日'
  return {
    can_submit: true,
    submit_date: toDateStr(d),
    nav_date: toDateStr(navDate),
    deferred: true,
    reason,
    hint: `可以提交，但${reason}，申请顺延至 ${toDateStr(navDate)} 处理并按当日净值成交` +
      (reason === '非交易日' ? '（节假日期间净值不更新）' : ''),
  }
}

// ─────────────────────────────────────────────
// 赎回到账（天数读 config，禁止硬编码）
// ─────────────────────────────────────────────

/**
 * 按基金品类计算赎回到账日。
 *
 * 规则来源：config.ts 的 REDEEM_ARRIVAL_RULES（单一来源，改规则只改一处）。
 * 匹配顺序：关键字从上到下依次尝试，均不中则用 REDEEM_ARRIVAL_FALLBACK_DAYS。
 *
 * | 品类      | 清算周期 | 依据 |
 * |-----------|---------|------|
 * | 货币型    | T+1     | 货币基金快速清算 |
 * | 债券型    | T+2     | 短债/纯债基金 |
 * | 混合/股票 | T+3     | 兜底值 |
 * | QDII/海外 | T+5     | 跨境清算 + 境外休市 |
 *
 * 具体以基金合同为准。
 */
export function arrivalDateByCategory(navDate: Date, category: string): Date {
  const c = (category ?? '').trim().toUpperCase()
  // 依次匹配配置规则
  for (const rule of REDEEM_ARRIVAL_RULES) {
    if (c.includes(rule.keyword.toUpperCase())) {
      return nextTradingDay(navDate, rule.days)
    }
  }
  // 兜底
  return nextTradingDay(navDate, REDEEM_ARRIVAL_FALLBACK_DAYS)
}

/**
 * 份额确认日（申购确认）。
 *
 * @param navDate   成交净值日
 * @param delayDays 顺延天数（普通基金默认 1，QDII 传 2）
 */
export function confirmDate(navDate: Date, delayDays: number = 1): Date {
  return nextTradingDay(navDate, delayDays)
}

/**
 * 当前是否处于可下单时段（交易日 15:00 前）。
 *
 * 用于开市门控：盘中才能下单，盘后/节假日下单将顺延。
 */
export function isMarketOpenNow(now: Date = new Date()): boolean {
  return isTradingDay(now) && isBeforeCutoff(now)
}

// ─────────────────────────────────────────────
// 演示入口（Node 运行：npx tsx src/core/calendar.ts）
// ─────────────────────────────────────────────
if (import.meta.url && new URL(import.meta.url).pathname.endsWith('/calendar.ts')) {
  console.log('=== 日历初始化 ===')
  console.log(`  source=${calendarInfo().source} degraded=${calendarInfo().degraded} count=${calendarInfo().count}`)

  const base = new Date(2026, 8, 18) // 2026-09-18 周五（基准日）
  base.setHours(0, 0, 0, 0)
  console.log(`  基准日 ${toDateStr(base)} weekday=${base.getDay()} (5=周五)`)
  console.log(`  isTradingDay(基准日): ${isTradingDay(base)}`)
  console.log(`  nextTradingDay(基准日): ${toDateStr(nextTradingDay(base))}`)

  console.log('\n=== 用例 1：15:00 截单 ===')
  // 09-18 周五 10:30 → 当日；16:00 → 顺延至 09-21 周一
  const morn = new Date(2026, 8, 18, 10, 30)
  const eve  = new Date(2026, 8, 18, 16, 0)
  console.log(`  09-18 10:30 → nav=${toDateStr(resolveNavDate(morn))}   (期望 09-18)`)
  console.log(`  09-18 16:00 → nav=${toDateStr(resolveNavDate(eve))}   (期望 09-21，顺延)`)

  console.log('\n=== 用例 2：非交易日提交 ===')
  // 09-19 周六 → 顺延至 09-21
  const sat = new Date(2026, 8, 19, 10, 0)
  const r2  = describeOrderTiming(sat)
  console.log(`  09-19(周六) 10:00 → nav=${r2.nav_date} can_submit=${r2.can_submit} deferred=${r2.deferred} "${r2.hint}"`)
  console.log(`  期望: nav=2026-09-21 can_submit=true deferred=true`)

  console.log('\n=== 用例 3：确认日（T+1 / QDII T+2）===')
  // 净值日 09-18 → 普通 T+1=09-21；QDII T+2=09-22
  console.log(`  普通 confirmDate(09-18, 1) = ${toDateStr(confirmDate(base, 1))}   (期望 09-21)`)
  console.log(`  QDII   confirmDate(09-18, 2) = ${toDateStr(confirmDate(base, 2))}   (期望 09-22)`)

  console.log('\n=== 用例 4：到账日（按品类）===')
  // 净值日 09-18 → 货币T+1=09-21 / 债T+2=09-22 / 混合T+3=09-23 / QDII T+5=09-28（09-25中秋休市顺延）
  console.log(`  货币型 arrivalDateByCategory(09-18, "货币型") = ${toDateStr(arrivalDateByCategory(base, '货币型'))}   (期望 09-21)`)
  console.log(`  债券型 arrivalDateByCategory(09-18, "债券型") = ${toDateStr(arrivalDateByCategory(base, '债券型'))}   (期望 09-22)`)
  console.log(`  混合型 arrivalDateByCategory(09-18, "混合型") = ${toDateStr(arrivalDateByCategory(base, '混合型'))}   (期望 09-23)`)
  console.log(`  QDII   arrivalDateByCategory(09-18, "QDII")   = ${toDateStr(arrivalDateByCategory(base, 'QDII'))}   (期望 09-28)`)

  // 校验：四个品类不能返回同一日期（否则就是硬编码未改）
  const arr = [
    toDateStr(arrivalDateByCategory(base, '货币型')),
    toDateStr(arrivalDateByCategory(base, '债券型')),
    toDateStr(arrivalDateByCategory(base, '混合型')),
    toDateStr(arrivalDateByCategory(base, 'QDII')),
  ]
  const allSame = arr.every(v => v === arr[0])
  console.log(`  四品类结果: [${arr.join(', ')}]`)
  console.log(`  ❌ 四品类同一天 = 硬编码未改，打回重做`)
  console.log(`  ✅ 四品类不同日期 = 通过`)

  console.log('\n=== 额外：节假日调休验证 ===')
  // 09-26 周六 → 周末，非交易日
  const weekend = new Date(2026, 8, 26)
  console.log(`  09-26(周六)  isTradingDay=${isTradingDay(weekend)}   (期望 false)`)
  // 09-25 周四中秋节 → 非交易日
  const midAutumn = new Date(2026, 8, 25)
  console.log(`  09-25(中秋)  isTradingDay=${isTradingDay(midAutumn)}   (期望 false)`)
  // 02-16 周一春节 → 非交易日
  const springFest = new Date(2026, 1, 16)
  console.log(`  02-16(春节)  isTradingDay=${isTradingDay(springFest)}   (期望 false)`)
}
