// src/lib/dingtou_plan.js · 定投计划（完整版）
// ------------------------------------------------------------
// 与 fund-app 的定投定义对齐：
//   字段：基金代码 / 名称 / 每期金额 / 频率（每周、每两周、每月）/
//         周几 或 每月几号 / 开始日期 / 启用状态
//   能力：新增、编辑、暂停/恢复、删除、下次扣款日、已投期数、累计投入
//   提醒：到期当天发一次本地通知（同日去重）
//
// ⚠️ 这是「计划管理 + 提醒」，不是自动扣款 —— App 没有交易通道，
//    不做任何真实申购。到期只提醒，投不投由用户自己操作。

import { sendFundAlert } from './notify.js'
import { fetchHoldingsLive } from './live.js'
import { appendRealHolding, loadRealHoldings } from './realLedger.js'

const KEY = 'dingtou_plans'
const NOTIFIED_KEY = 'dingtou_notified'

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export const FREQ_LABEL = { weekly: '每周', biweekly: '每两周', monthly: '每月' }

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * 读全部定投计划
 * @returns {Array<{id:number,code:string,name:string,amount:number,frequency:string,
 *   weekday:number,day_of_month:number,start_date:string,enabled:boolean}>}
 */
export function loadPlans() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(arr)) return []
    const valid = arr.filter((p) => p && p.code && p.amount != null)
    // 先把已有合法 id 收进来，再给缺 id 的记录补号：老数据和导入数据以前会
    // 被 Number(p.id) || 0 全部归一为 0，自动追加写回时只命中第一条，
    // 其余计划每轮都被判「未投满」→ 重复扣款、账本凭空多份额。补号后落盘
    // 一次性修掉。
    const seen = new Set()
    valid.forEach((p) => {
      const n = Number(p.id)
      if (Number.isFinite(n) && n > 0) seen.add(n)
    })
    let changed = false
    let next = 1
    const list = valid.map((p) => {
      let id = Number(p.id)
      if (!Number.isFinite(id) || id <= 0) {
        while (seen.has(next)) next++
        id = next
        seen.add(id)
        changed = true
      }
      return {
        id,
        code: String(p.code),
        name: p.name || '',
        amount: Number(p.amount) || 0,
        frequency: ['weekly', 'biweekly', 'monthly'].includes(p.frequency)
          ? p.frequency
          : 'monthly',
        weekday: Number(p.weekday) || 0,
        day_of_month: Math.min(28, Math.max(1, Number(p.day_of_month) || 1)),
        start_date: p.start_date || '',
        enabled: p.enabled !== false,
        auto_applied_periods: Number(p.auto_applied_periods) || 0,
        last_auto_at: p.last_auto_at || '',
        created_at: p.created_at || '',
      }
    })
    if (changed) savePlans(list)
    return list
  } catch {
    return []
  }
}

function savePlans(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/**
 * 新增或更新一条定投计划
 * @param {object} p 计划字段；带 id 时为更新，否则新增
 * @returns {number} 计划 id；校验失败或落盘失败返回 0
 */
export function upsertPlan(p) {
  const list = loadPlans()
  const rec = {
    code: String(p.code || '').trim(),
    name: String(p.name || '').trim(),
    amount: Number(p.amount) || 0,
    frequency: ['weekly', 'biweekly', 'monthly'].includes(p.frequency) ? p.frequency : 'monthly',
    weekday: Number(p.weekday) || 0,
    day_of_month: Math.min(28, Math.max(1, Number(p.day_of_month) || 1)),
    start_date: p.start_date || fmtDate(new Date()),
    enabled: p.enabled !== false,
  }
  if (!rec.code || !(rec.amount > 0)) return 0

  if (p.id) {
    const i = list.findIndex((x) => x.id === Number(p.id))
    if (i < 0) return 0
    list[i] = { ...list[i], ...rec }
    return savePlans(list) ? list[i].id : 0
  }
  const id = list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1
  list.push({ id, ...rec, created_at: new Date().toISOString() })
  return savePlans(list) ? id : 0
}

/**
 * 删除一条定投计划
 * @param {number} id 计划 id
 * @returns {boolean} 是否落盘成功
 */
export function deletePlan(id) {
  return savePlans(loadPlans().filter((x) => x.id !== Number(id)))
}

/**
 * 暂停 / 恢复一条定投计划
 * @param {number} id 计划 id
 * @returns {boolean} 是否落盘成功（计划不存在返回 false）
 */
export function togglePlan(id) {
  const list = loadPlans()
  const p = list.find((x) => x.id === Number(id))
  if (!p) return false
  p.enabled = !p.enabled
  return savePlans(list)
}

/** 第一个扣款日（>= 开始日期） */
function firstDeductDate(plan) {
  /* ⚠️ start_date 可能是导入进来的脏数据（如 '2021/13/45'）。
     new Date(脏值).getDay() === NaN，weekly/biweekly 的 while 会永不退出，
     把调用方卡死。无效日期一律回退今天。 */
  const raw = plan.start_date ? new Date(plan.start_date) : new Date()
  const start = Number.isNaN(raw.getTime()) ? new Date() : startOfDay(raw)
  if (plan.frequency === 'monthly') {
    const d = new Date(start)
    d.setDate(Math.min(28, Math.max(1, Number(plan.day_of_month) || 1)))
    if (d < start) d.setMonth(d.getMonth() + 1)
    return d
  }
  const d = new Date(start)
  const wd = Number(plan.weekday) || 0
  let guard = 0
  while (d.getDay() !== wd && guard < 14) {
    d.setDate(d.getDate() + 1)
    guard++
  }
  return d
}

function advance(d, frequency) {
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1)
  else if (frequency === 'biweekly') d.setDate(d.getDate() + 14)
  else d.setDate(d.getDate() + 7)
}

/**
 * 计划统计
 * @returns {{periods:number, invested:number, nextDate:string, due:boolean, next:Date}}
 *   periods = 已过扣款期数（不含今天待扣）；due = 今天正好是扣款日
 */
export function planStats(plan, now = new Date()) {
  const amount = Number(plan.amount) || 0
  const today = startOfDay(now)
  let cursor = firstDeductDate(plan)

  let periods = 0
  let guard = 0
  while (cursor < today && guard < 3000) {
    periods++
    advance(cursor, plan.frequency)
    guard++
  }

  return {
    periods,
    invested: +(periods * amount).toFixed(2),
    nextDate: fmtDate(cursor),
    due: plan.enabled && sameDay(cursor, today),
    next: cursor,
  }
}

/** 今天到期的计划（启用的） */
export function duePlans(plans, now = new Date()) {
  return plans.filter((p) => planStats(p, now).due)
}

/**
 * 到期提醒：同一天同一计划只发一次
 * @returns {Promise<number>} 本次提醒条数
 */
export async function notifyDueDingtou(now = new Date()) {
  const list = loadPlans()
  const due = duePlans(list, now)
  if (due.length === 0) return 0

  let notified = {}
  try {
    notified = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}') || {}
  } catch {
    notified = {}
  }

  const day = fmtDate(now)
  const fresh = due.filter((p) => !notified[`${day}:${p.id}`])
  if (fresh.length === 0) return 0

  for (const p of fresh) notified[`${day}:${p.id}`] = Date.now()

  // 只保留最近 7 天
  const cutoff = Date.now() - 7 * 86400000
  const next = {}
  for (const [k, t] of Object.entries(notified)) {
    if (typeof t === 'number' && t >= cutoff) next[k] = t
  }
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(next))
  } catch {
    // 忽略
  }

  const lines = fresh.map((p) => `${p.name || p.code} ¥${p.amount}`)
  await sendFundAlert({
    type: 'priceMove',
    title: '定投提醒',
    body: `今天该投：${lines.slice(0, 5).join('、')}`,
  })
  return fresh.length
}

/* ---------------- 到期自动追加到持仓 ---------------- */

const AUTO_KEY = 'dingtou_auto_apply'

/** 读「到期自动追加到持仓」开关（默认关：账本变更必须由用户主动开启） */
export function loadAutoApply() {
  try {
    const obj = JSON.parse(localStorage.getItem(AUTO_KEY) || 'null')
    return { enabled: false, ...(obj && typeof obj === 'object' ? obj : {}) }
  } catch {
    return { enabled: false }
  }
}

/**
 * 局部更新自动追加开关
 * @param {{enabled?: boolean}} patch
 * @returns {{enabled: boolean}} 合并后的配置
 */
export function saveAutoApply(patch) {
  const next = { ...loadAutoApply(), ...patch }
  try {
    localStorage.setItem(AUTO_KEY, JSON.stringify(next))
  } catch {
    // 忽略
  }
  return next
}

/**
 * 到期自动追加「资金」：把已到期但未自动投的期数，按**当前净值**折算成份额，
 * 追加到真实持仓（只改本机账本，不发起任何真实交易）。
 *
 * 口径与边界（诚实）：
 *   - 只对持仓里已有的基金追加；该基金不在持仓 → 跳过（不凭空建仓）
 *   - 拿不到净值 → 跳过（不编价格）
 *   - 补投一律按「当前净值」折算份额，不回溯历史期数的当时净值
 *   - 关掉开关（loadAutoApply().enabled=false）则完全不自动改账本
 *
 * @returns {Promise<{applied:Array<{code,name,periods,amount}>, skipped:Array<{code,reason}>}>}
 */
export async function autoApplyDuePlans(now = new Date()) {
  const cfg = loadAutoApply()
  if (!cfg.enabled) return { applied: [], skipped: [] }

  const list = loadPlans().filter((p) => p.enabled)
  if (list.length === 0) return { applied: [], skipped: [] }

  const held = new Set(loadRealHoldings().map((r) => r.code).filter(Boolean))
  let liveMap = {}
  try {
    liveMap = await fetchHoldingsLive(list.map((p) => p.code))
  } catch {
    liveMap = {}
  }

  const applied = []
  const skipped = []

  for (const p of list) {
    const s = planStats(p, now)
    const dueTotal = s.periods + (s.due ? 1 : 0)
    const already = Number(p.auto_applied_periods) || 0
    const due = dueTotal - already
    if (due <= 0) continue

    if (!held.has(p.code)) {
      skipped.push({ code: p.code, reason: 'not-held' })
      continue
    }
    const live = liveMap[p.code]
    const nav = live?.nav ?? null
    if (nav == null || !(nav > 0)) {
      skipped.push({ code: p.code, reason: 'no-nav' })
      continue
    }

    const amount = due * p.amount
    const ok = appendRealHolding({
      code: p.code,
      name: p.name,
      deltaShares: amount / nav,
      amountCost: amount,
      nav,
      navDate: live?.navDate || '',
    })
    if (!ok) {
      skipped.push({ code: p.code, reason: 'append-failed' })
      continue
    }

    p.auto_applied_periods = dueTotal
    p.last_auto_at = new Date().toISOString()
    applied.push({ id: p.id, code: p.code, name: p.name, periods: due, amount })
  }

  if (applied.length > 0) {
    // 把已投期数写回计划（按 id 匹配，避免同一基金多个计划时写串；保留其它字段）
    const all = loadPlans()
    for (const a of applied) {
      const src = list.find((x) => x.id === a.id)
      const t = all.find((x) => x.id === a.id)
      if (t && src) {
        t.auto_applied_periods = src.auto_applied_periods
        t.last_auto_at = src.last_auto_at
      }
    }
    savePlans(all)
  }

  return { applied, skipped }
}
