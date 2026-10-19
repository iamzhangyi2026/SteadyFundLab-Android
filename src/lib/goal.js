// src/lib/goal.js · 目标规划（C17 完整版）
// ------------------------------------------------------------
// 退休 / 教育 / 目标投：支持**多个目标**，每个目标有名称、目标金额、
// 目标日期（不是年限）、假设年化、每月定投、起始本金（可空 = 用真实持仓市值）。
//
// 口径（与项目 v139 定义一致）：
//   月利率 r = 年化 / 12 / 100
//   期末额 = 本金×(1+r)^n + 每月定投×[((1+r)^n − 1)/r]，r≈0 时退化线性
//   缺口 = 目标 − 期末额；达成率 = 期末额 / 目标；每月需投 = 反解
//   收益率是用户假设，不是承诺；只做数学推算，不预测市场。
//
// 存储：localStorage（原型架构），结构 goal_plans 数组。

import { loadRealHoldings, calcHolding } from './realLedger.js'
import { fetchHoldingsLive } from './live.js'

const KEY = 'goal_plans'

const r2 = (x) => Math.round(x * 100) / 100

/** 整月数（不足一月不计） */
export function monthsBetween(from, to) {
  let m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
  if (to.getDate() < from.getDate()) m -= 1
  return Math.max(0, m)
}

/**
 * 单目标推算（纯函数）
 * @param {object} g { target_amount, target_date, annual_return, monthly_saving, initial_amount }
 * @param {number} initialAmount 当前可用本金（真实持仓市值）
 */
export function computeGoal(g, initialAmount, now = new Date()) {
  const initial =
    g.initial_amount != null && Number.isFinite(Number(g.initial_amount))
      ? Number(g.initial_amount)
      : Math.max(0, Number(initialAmount) || 0)
  const target = Number(g.target_amount) || 0
  const ms = Number(g.monthly_saving) || 0
  const r = (Number(g.annual_return) || 0) / 12 / 100
  const months = monthsBetween(now, new Date(g.target_date))

  let fv
  if (months <= 0) fv = initial
  else if (Math.abs(r) < 1e-9) fv = initial + ms * months
  else fv = initial * Math.pow(1 + r, months) + ms * ((Math.pow(1 + r, months) - 1) / r)

  const gap = target - fv
  const achievement = target > 0 ? (fv / target) * 100 : 0

  let required = 0
  if (months > 0) {
    if (Math.abs(r) < 1e-9) required = (target - initial) / months
    else {
      const fvInitial = initial * Math.pow(1 + r, months)
      required = ((target - fvInitial) * r) / (Math.pow(1 + r, months) - 1)
    }
  }
  required = Math.max(0, required)

  const onTrack = fv >= target
  const note = onTrack
    ? `按假设年化 ${g.annual_return}%，到时预计有 ${r2(fv)} 元，可达目标`
    : `按假设年化 ${g.annual_return}%，到时预计有 ${r2(fv)} 元，还差 ${r2(gap)} 元`

  return {
    months,
    initial: r2(initial),
    monthly_saving: ms,
    annual_return: Number(g.annual_return) || 0,
    future_value: r2(fv),
    target_amount: r2(target),
    gap: r2(gap),
    achievement_pct: r2(achievement),
    required_monthly: r2(required),
    on_track: onTrack,
    note,
  }
}

/* ---------------- 存取 ---------------- */

function normalize(raw) {
  const arr = Array.isArray(raw) ? raw : []
  return arr
    .filter((g) => g && g.name && g.target_amount != null && g.target_date)
    .map((g) => ({
      id: Number(g.id) || 0,
      name: String(g.name),
      target_amount: Number(g.target_amount) || 0,
      target_date: String(g.target_date).slice(0, 10),
      annual_return: Number(g.annual_return) || 0,
      monthly_saving: Number(g.monthly_saving) || 0,
      initial_amount:
        g.initial_amount == null || g.initial_amount === '' ? null : Number(g.initial_amount),
      created_at: g.created_at || '',
      updated_at: g.updated_at || '',
    }))
}

/** 读取全部目标（按目标日期升序） */
export function loadGoals() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return normalize(raw).sort((a, b) =>
      String(a.target_date).localeCompare(String(b.target_date)),
    )
  } catch {
    return []
  }
}

function saveGoals(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/** 新增（无 id）或更新（有 id）；返回 id，失败返回 0 */
export function upsertGoal(g) {
  const list = loadGoals()
  const now = new Date().toISOString()
  const rec = {
    name: String(g.name || '').trim(),
    target_amount: Number(g.target_amount) || 0,
    target_date: String(g.target_date || '').slice(0, 10),
    annual_return: g.annual_return == null || g.annual_return === '' ? 6 : Number(g.annual_return),
    monthly_saving: Number(g.monthly_saving) || 0,
    initial_amount:
      g.initial_amount == null || g.initial_amount === '' ? null : Number(g.initial_amount),
    updated_at: now,
  }
  if (!rec.name || !(rec.target_amount > 0) || !rec.target_date) return 0

  if (g.id) {
    const i = list.findIndex((x) => x.id === Number(g.id))
    if (i < 0) return 0
    list[i] = { ...list[i], ...rec }
    return saveGoals(list) ? list[i].id : 0
  }

  const id = list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1
  list.push({ id, ...rec, created_at: now })
  return saveGoals(list) ? id : 0
}

/** 删除目标 */
export function deleteGoal(id) {
  const list = loadGoals().filter((x) => x.id !== Number(id))
  return saveGoals(list)
}

/**
 * 当前可用本金 = 真实持仓最新市值合计（与持仓页同口径）。
 * 拿不到实时行情时退回账本金额/导入净值口径；没有持仓返回 0。
 */
export async function currentPrincipal() {
  const list = loadRealHoldings()
  if (list.length === 0) return 0
  let liveMap = {}
  try {
    liveMap = await fetchHoldingsLive(list.map((r) => r.code).filter(Boolean))
  } catch {
    // 网络失败：用账本自身口径
  }
  let total = 0
  for (const r of list) {
    const c = calcHolding({ ...r, live: r.code ? liveMap[r.code] || null : null })
    total += c.mv ?? 0
  }
  return r2(total)
}

/**
 * 编排：读目标 + 当前真实持仓市值 → 逐目标推算
 * @returns {Promise<{initial:number, goals:Array}>}
 */
export async function goalReport(now = new Date()) {
  const initial = await currentPrincipal()
  return goalsWithProjection(initial, now)
}

/** 指定本金做投影（模拟持仓页传入自己的总市值时用） */
export function goalsWithProjection(initial, now = new Date()) {
  const goals = loadGoals()
  return {
    initial,
    goals: goals.map((g) => ({ ...g, projection: computeGoal(g, initial, now) })),
  }
}
