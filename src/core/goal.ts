// ─────────────────────────────────────────────
// goal.ts · 目标规划
//
// 退休 / 教育 / 目标投：用户设目标金额 + 目标日期 + 预期年化 + 每月定投，
// 基于「当前本金（真实持仓市值，或用户自填）+ 每月定投」按复利估算到目标日
// 的达成额，算缺口 / 达成率 / 若要达成每月需投多少。
//
// 口径诚实：收益率是**用户假设**，不是承诺；只做数学推算，不预测市场。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { loadRealPositions } from './risk.ts'

const r2 = (x: number) => Math.round(x * 100) / 100

export interface GoalRow {
  id: number
  name: string
  target_amount: number        // 目标金额（元）
  target_date: string          // 目标日期 YYYY-MM-DD
  annual_return: number        // 预期年化收益率（%）
  monthly_saving: number       // 每月定投（元）
  initial_amount: number | null // 起始本金（null = 用当前真实持仓市值）
  created_at: string
  updated_at: string
}

export interface GoalProjection {
  months: number
  initial: number
  monthly_saving: number
  annual_return: number
  future_value: number         // 预计达成额（本金复利 + 定投）
  target_amount: number
  gap: number                  // 缺口（正=还差多少；负=超出）
  achievement_pct: number      // 达成率（%）
  required_monthly: number     // 若要达成，每月需投（元）
  on_track: boolean
  note: string
}

/** 整月数（不足一月不计） */
export function monthsBetween(from: Date, to: Date): number {
  let m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
  if (to.getDate() < from.getDate()) m -= 1
  return Math.max(0, m)
}

/**
 * 单目标推算（纯函数）。
 * 期末额 = 本金×(1+r)^n + 每月定投×[((1+r)^n − 1)/r]（r=月利率）；r=0 时退化为线性。
 */
export function computeGoal(g: GoalRow, initialAmount: number, now: Date = new Date()): GoalProjection {
  const initial = g.initial_amount != null ? Number(g.initial_amount) : Math.max(0, initialAmount)
  const target = Number(g.target_amount) || 0
  const ms = Number(g.monthly_saving) || 0
  const r = (Number(g.annual_return) || 0) / 12 / 100
  const months = monthsBetween(now, new Date(g.target_date))

  let fv: number
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
      required = (target - fvInitial) * r / (Math.pow(1 + r, months) - 1)
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

// ─── 存取 ────────────────────────────────────────────────────

export async function listGoals(db: LedgerDb): Promise<GoalRow[]> {
  return db.query<GoalRow>(
    `SELECT id, name, target_amount, target_date, annual_return, monthly_saving,
            initial_amount, created_at, updated_at
       FROM goal_plan ORDER BY target_date ASC, id ASC`,
    [],
  )
}

/** 新增（无 id）或更新（有 id） */
export async function upsertGoal(
  db: LedgerDb,
  g: Partial<GoalRow> & { name: string; target_amount: number; target_date: string },
): Promise<number> {
  const now = new Date().toISOString()
  const annual = Number(g.annual_return ?? 6)
  const ms = Number(g.monthly_saving ?? 0)
  const initial = g.initial_amount == null || g.initial_amount === ('' as unknown) ? null : Number(g.initial_amount)
  if (g.id) {
    await db.run(
      `UPDATE goal_plan SET name=?, target_amount=?, target_date=?, annual_return=?,
        monthly_saving=?, initial_amount=?, updated_at=? WHERE id=?`,
      [g.name, Number(g.target_amount), g.target_date, annual, ms, initial, now, g.id],
    )
    return g.id
  }
  const res = await db.run(
    `INSERT INTO goal_plan (name, target_amount, target_date, annual_return, monthly_saving, initial_amount, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [g.name, Number(g.target_amount), g.target_date, annual, ms, initial, now, now],
  ) as { lastInsertId?: number } | undefined
  return res?.lastInsertId ?? 0
}

export async function deleteGoal(db: LedgerDb, id: number): Promise<void> {
  await db.run(`DELETE FROM goal_plan WHERE id=?`, [id])
}

export interface GoalWithProjection extends GoalRow {
  projection: GoalProjection
}

export interface GoalReport {
  ok: boolean
  reason?: string
  initial: number            // 当前可用本金（真实持仓市值合计）
  goals: GoalWithProjection[]
}

/** 编排：读目标 + 当前真实持仓市值 → 逐目标推算 */
export async function goalReport(db: LedgerDb): Promise<GoalReport> {
  const goals = await listGoals(db)
  let initial = 0
  try {
    const positions = await loadRealPositions(db)
    initial = positions.reduce((s, p) => s + (p.market_value ?? 0), 0)
  } catch { /* 无持仓 → 本金按 0，用户可在目标里填起始本金 */ }

  const now = new Date()
  return {
    ok: true,
    initial: r2(initial),
    goals: goals.map(g => ({ ...g, projection: computeGoal(g, initial, now) })),
  }
}
