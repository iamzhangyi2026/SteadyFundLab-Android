// src/lib/alerts.js · 预警中心
// ------------------------------------------------------------
// 四类预警，共用一套规则存储（localStorage `alert_rules`）：
//   1. 涨跌预警    单日涨跌幅绝对值 ≥ movePct
//   2. 净值预警    最新净值 ≤ 用户设定的目标净值
//   3. 估值洼地    累计净值历史分位 < undervaluedPct
//   4. 再平衡      实际占比与目标占比偏离 ≥ rebalanceDevPct 个百分点
//
// ⚠️  修正：此前「我的」页开关存 notify_prefs、本模块读 alert_rules，
//    两套存储互不联通，且估值洼地只有开关没有检查逻辑（假开关）。
//    现在统一到 alert_rules，由「我的」页直接读写。
//
// 通知策略：同一只基金、同一天、同一类型只提醒一次；每类汇总成一条通知，
// 避免多只同时命中时刷屏。没通知权限时只返回命中结果，不发通知。

import { fetchHoldingsLive } from './live.js'
import { fetchFund } from './eastmoney.js'
import { navPercentile } from './deep_analysis.js'
import { detectJumps } from './navSanitize.js'
import { toSeries } from './navCache.js'
import { rebalancePlan } from './portfolio_tools.js'
import { sendFundAlert } from './notify.js'

const RULES_KEY = 'alert_rules'
const NOTIFIED_KEY = 'alert_notified'
const REBALANCE_TARGET_KEY = 'rebalance_targets'

export const ALERT_DEFAULTS = {
  enabled: true, // 涨跌预警总开关
  movePct: 3, // 单日涨跌阈值（%）
  navTargets: {}, // { code: 目标净值 }，最新净值 ≤ 目标时提醒
  undervaluedEnabled: true, // 估值洼地提醒
  undervaluedPct: 30, // 分位低于该值视为洼地
  rebalanceEnabled: true, // 再平衡提醒
  rebalanceDevPct: 10, // 偏离目标 ≥ 该百分点提醒
}

/** 读预警规则（缺失字段用默认值补齐；存储损坏时退回默认） */
export function loadAlertRules() {
  try {
    const raw = localStorage.getItem(RULES_KEY)
    const obj = raw ? JSON.parse(raw) : null
    return {
      ...ALERT_DEFAULTS,
      ...(obj && typeof obj === 'object' ? obj : {}),
      navTargets:
        obj && typeof obj.navTargets === 'object' && obj.navTargets ? obj.navTargets : {},
    }
  } catch {
    return { ...ALERT_DEFAULTS, navTargets: {} }
  }
}

/**
 * 局部更新预警规则并落盘
 * @param {object} patch 要覆盖的字段（enabled / movePct / navTargets / ...）
 * @returns {object} 合并后的完整规则（即使落盘失败，本次会话仍按新规则生效）
 */
export function saveAlertRules(patch) {
  const next = { ...loadAlertRules(), ...patch }
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(next))
  } catch {
    // 存储失败：本次会话仍生效
  }
  return next
}

function loadNotified() {
  try {
    const obj = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}')
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function saveNotified(obj) {
  try {
    const cutoff = Date.now() - 3 * 86400000
    const next = {}
    for (const [k, t] of Object.entries(obj)) {
      if (typeof t === 'number' && t >= cutoff) next[k] = t
    }
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(next))
  } catch {
    // 忽略
  }
}

function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function loadRebalanceTargets() {
  try {
    const obj = JSON.parse(localStorage.getItem(REBALANCE_TARGET_KEY) || '{}')
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

/* ---------------- 1. 涨跌预警（只计算，不通知） ---------------- */

/**
 * 涨跌预警：当日涨跌幅绝对值 ≥ 阈值的基金
 * @param {string[]} codes 基金代码
 * @param {{force?: boolean}} opts force=忽略行情缓存
 * @returns {Promise<Array<{code:string, pct:number}>>}
 */
export async function checkPriceAlerts(codes, { force = false } = {}) {
  const rules = loadAlertRules()
  if (!rules.enabled) return []
  const uniq = [...new Set((codes || []).filter(Boolean))]
  if (uniq.length === 0) return []

  const live = await fetchHoldingsLive(uniq, { force })
  const hits = []
  for (const code of uniq) {
    const pct = live[code]?.pct
    if (pct == null || !Number.isFinite(pct)) continue
    if (Math.abs(pct) < Number(rules.movePct)) continue
    hits.push({ code, pct })
  }
  return hits
}

/* ---------------- 2. 净值预警 ---------------- */

/**
 * 净值预警：最新净值 ≤ 用户设定目标净值 的基金
 * @param {string[]} codes 基金代码
 * @param {object} [rules] 预警规则（默认读本机存储）
 * @returns {Promise<Array<{code:string, nav:number, target:number}>>}
 */
export async function checkNavTargetAlerts(codes, rules = loadAlertRules()) {
  const targets = rules.navTargets || {}
  const withTarget = (codes || []).filter(
    (c) => targets[c] != null && Number(targets[c]) > 0,
  )
  if (withTarget.length === 0) return []

  const live = await fetchHoldingsLive(withTarget)
  const hits = []
  for (const code of withTarget) {
    const nav = live[code]?.nav
    const target = Number(targets[code])
    if (nav != null && Number.isFinite(nav) && nav <= target) {
      hits.push({ code, nav, target })
    }
  }
  return hits
}

/* ---------------- 3. 估值洼地预警 ---------------- */

/**
 * 对给定基金算累计净值历史分位，低于阈值即命中。
 * 每只基金一次 pingzhongdata 请求（有内存缓存），失败跳过、不猜。
 * 净值序列含异常跳变时该基金不参与（分位会失真，见 lib/navSanitize.js）。
 */
export async function checkUndervaluedAlerts(codes, rules = loadAlertRules()) {
  if (!rules.undervaluedEnabled) return []
  const uniq = [...new Set((codes || []).filter(Boolean))]
  if (uniq.length === 0) return []

  const pairs = await Promise.all(
    uniq.map(async (code) => {
      try {
        const d = await fetchFund(code)
        const series = toSeries(d)
        if (detectJumps(series).length > 0) return null
        const pct = navPercentile(series)
        if (pct == null || pct >= Number(rules.undervaluedPct)) return null
        return { code, name: d.name, percentile: +pct.toFixed(1) }
      } catch {
        return null
      }
    }),
  )
  return pairs.filter(Boolean)
}

/* ---------------- 4. 再平衡提醒 ---------------- */

/**
 * 再平衡预警：实际占比与目标占比偏离 ≥ 阈值的基金
 * @param {Array} holdings 账本行（真实或模拟，口径由调用方决定）
 * @param {object} [rules] 预警规则
 * @returns {Array<{code,name,actual,target,diff,action,amount}>}
 */
export function checkRebalanceAlerts(holdings, rules = loadAlertRules()) {
  if (!rules.rebalanceEnabled) return []
  if (!Array.isArray(holdings) || holdings.length === 0) return []
  const plan = rebalancePlan(holdings, loadRebalanceTargets())
  if (!plan) return []
  const dev = Number(rules.rebalanceDevPct) || 10
  return plan.rows
    .filter((r) => Math.abs(r.diff) >= dev)
    .map((r) => ({
      code: r.code,
      name: r.name,
      actual: r.pct,
      target: r.target,
      diff: r.diff,
      action: r.action,
      amount: Math.abs(r.amount),
    }))
}

/* ---------------- 统一检查 + 通知 ---------------- */

/**
 * 一次跑全部预警，按类型汇总发通知，并做「同日同基金同类型」去重。
 * @param {{codes?: string[], holdings?: Array}} p
 * @returns {Promise<{price:Array, navTarget:Array, undervalued:Array, rebalance:Array, notified:number}>}
 */
export async function checkAllAlerts({ codes = [], holdings = [] } = {}) {
  const rules = loadAlertRules()
  const uniq = [...new Set((codes || []).filter(Boolean))]

  const [price, navTarget, undervalued] = await Promise.all([
    rules.enabled ? checkPriceAlerts(uniq, { force: false }) : [],
    checkNavTargetAlerts(uniq, rules),
    checkUndervaluedAlerts(uniq, rules),
  ])
  const rebalance = checkRebalanceAlerts(holdings, rules)

  const day = todayKey()
  const notified = loadNotified()
  let sent = 0

  function fresh(kind, code) {
    const k = `${day}:${kind}:${code}`
    if (notified[k]) return false
    notified[k] = Date.now()
    return true
  }

  // 涨跌 + 净值：合成一条「价格类」通知
  const priceLines = []
  for (const h of price) {
    if (fresh('price', h.code)) {
      priceLines.push(`${h.code} ${h.pct > 0 ? '+' : ''}${h.pct.toFixed(2)}%`)
    }
  }
  for (const h of navTarget) {
    if (fresh('navtarget', h.code)) {
      priceLines.push(`${h.code} 净值 ${h.nav.toFixed(4)} 已到目标 ${h.target.toFixed(4)}`)
    }
  }
  if (priceLines.length > 0) {
    await sendFundAlert({
      type: 'priceMove',
      title: '持仓预警',
      body:
        priceLines.slice(0, 5).join('、') +
        (priceLines.length > 5 ? ` 等 ${priceLines.length} 条` : ''),
    })
    sent++
  }

  // 估值洼地：单独一条，红点指向「发现」
  const uvLines = []
  for (const h of undervalued) {
    if (fresh('undervalued', h.code)) {
      uvLines.push(`${h.name || h.code} 分位 ${h.percentile}%`)
    }
  }
  if (uvLines.length > 0) {
    await sendFundAlert({
      type: 'undervalued',
      title: '估值洼地提醒',
      body: `跌进历史低分位：${uvLines.slice(0, 4).join('、')}`,
    })
    sent++
  }

  // 再平衡：单独一条
  const rbLines = []
  for (const h of rebalance) {
    if (fresh('rebalance', h.code || h.name)) {
      rbLines.push(`${h.name || h.code} ${h.action} ${Math.abs(h.diff).toFixed(1)} 个百分点`)
    }
  }
  if (rbLines.length > 0) {
    await sendFundAlert({
      type: 'rebalance',
      title: '再平衡提醒',
      body: rbLines.slice(0, 4).join('、'),
    })
    sent++
  }

  saveNotified(notified)
  return { price, navTarget, undervalued, rebalance, notified: sent }
}
