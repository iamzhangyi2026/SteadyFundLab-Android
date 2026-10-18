// ─────────────────────────────────────────────
// rebalance.ts · 组合再平衡提醒
//
// 调仓提醒基于**模拟持仓（交易盘虚拟持仓）**：真实持仓只能看 / 分析，
// 调仓是「交易」页虚拟盘的练手功能。
// 用户为模拟持仓设定目标权重；App 检测实际权重（市值占比）偏离目标
// 超过阈值 → 提醒再平衡，并给出每只基金的调仓建议（买/卖多少）。
//
// 口径（与 portfolio.ts 一致）：
//   - 只算模拟持仓（lots.source = 'trade'）
//   - 实际权重 = 该基金市值 / 组合总市值 × 100；市值 = 最新单位净值 nav × 剩余份额
//   - 无净值（market_value 为 null）→ 不算入组合，明确标缺数据，绝不编
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

/** 再平衡参数（策略类，可调） */
export const REBALANCE_CONFIG = {
  /** 任一基金 |实际占比 − 目标占比| ≥ 此值（%）→ 判定需要再平衡 */
  drift_threshold_pct: 5.0,
  /** 提醒冷却（小时）：避免每次打开 App 都弹 */
  cooldown_hours: 24,
}

const r2 = (x: number) => Math.round(x * 100) / 100

// ─── 模拟持仓读取（source='trade'，按 fund_code 聚合） ─────────

interface TradePos {
  fund_code: string
  fund_name: string | null
  category: string | null
  market_value: number | null
  cost_amount: number
}

/** 读取交易盘模拟持仓（按 fund_code 合并多批次），市值 = 剩余份额 × 最新单位净值。 */
async function loadTradePositions(db: LedgerDb): Promise<TradePos[]> {
  const rows = await db.query<{
    fund_code: string; fund_name: string | null; category: string | null
    market_value: number | null; cost_amount: number | null
  }>(
    `SELECT l.fund_code, f.fund_name, f.category,
       SUM(l.remaining_shares * COALESCE((SELECT nav FROM nav_daily WHERE fund_code=l.fund_code ORDER BY nav_date DESC LIMIT 1), 0)) AS market_value,
       SUM(l.cost_amount * (l.remaining_shares / NULLIF(l.shares, 0))) AS cost_amount
     FROM lots l LEFT JOIN funds f ON f.fund_code = l.fund_code
     WHERE l.status='active' AND l.remaining_shares > 0 AND l.source='trade'
     GROUP BY l.fund_code, f.fund_name, f.category`,
    [],
  )
  return rows.map(r => ({
    fund_code: r.fund_code,
    fund_name: r.fund_name,
    category: r.category,
    market_value: r.market_value,
    cost_amount: r.cost_amount ?? 0,
  }))
}

// ─── 目标权重存取 ─────────────────────────────────────────────

export interface RebalanceTargetRow {
  fund_code: string
  target_weight: number
}

/** 读取所有目标权重（fund_code → 目标占比%） */
export async function loadTargets(db: LedgerDb): Promise<Map<string, number>> {
  const rows = await db.query<{ fund_code: string; target_weight: number }>(
    `SELECT fund_code, target_weight FROM rebalance_targets`, [],
  )
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.fund_code, Number(r.target_weight))
  return m
}

/**
 * 保存目标权重：先清空再插入非零项（目标表只服务再平衡，无副作用）。
 * 传入应含全部模拟持仓基金的目标（空 / 0 / 非法 → 视为未设，不存）。
 */
export async function saveTargets(db: LedgerDb, rows: RebalanceTargetRow[]): Promise<void> {
  await db.run(`DELETE FROM rebalance_targets`)
  for (const r of rows) {
    const w = Number(r.target_weight)
    if (!Number.isFinite(w) || w <= 0) continue
    await db.run(
      `INSERT INTO rebalance_targets (fund_code, target_weight, updated_at) VALUES (?,?,?)`,
      [r.fund_code, r2(w), new Date().toISOString()],
    )
  }
}

// ─── 纯函数：实际 vs 目标偏离 + 调仓建议 ─────────────────────

export interface RebalancePositionRow {
  fund_code: string
  fund_name: string | null
  category: string | null
  market_value: number          // 实际市值（元）
  cost_amount: number
  actual_weight: number         // 实际占比 %
  target_weight: number | null  // 目标占比 %（null = 未设）
  drift: number | null          // 实际 − 目标（%）
  suggest_amount: number | null // 正=买入 / 负=卖出（元）；null=未设目标
}

export interface RebalanceReport {
  ok: boolean
  reason?: string
  scope: 'trade'
  total_market_value: number
  rows: RebalancePositionRow[]
  drift_threshold: number
  need_rebalance: boolean
  max_drift: number
  has_target: boolean
}

export function computeRebalance(
  positions: {
    fund_code: string; fund_name: string | null; category: string | null
    market_value: number | null; cost_amount: number
  }[],
  targets: Map<string, number>,
  t: { drift_threshold_pct: number },
  totalMarketValue: number,
): RebalanceReport {
  const valued = positions.filter(p => p.market_value != null && (p.market_value as number) > 0)
  if (totalMarketValue <= 0 || valued.length === 0) {
    return {
      ok: false, reason: '没有可计算市值的模拟持仓', scope: 'trade',
      total_market_value: totalMarketValue, rows: [], drift_threshold: t.drift_threshold_pct,
      need_rebalance: false, max_drift: 0, has_target: targets.size > 0,
    }
  }
  const rows: RebalancePositionRow[] = valued.map(p => {
    const mv = p.market_value as number
    const actual = r2(mv / totalMarketValue * 100)
    const target = targets.has(p.fund_code) ? targets.get(p.fund_code)! : null
    const drift = target != null ? r2(actual - target) : null
    const suggest = target != null ? r2(mv - totalMarketValue * target / 100) : null
    return {
      fund_code: p.fund_code, fund_name: p.fund_name, category: p.category,
      market_value: r2(mv), cost_amount: r2(p.cost_amount),
      actual_weight: actual, target_weight: target, drift, suggest_amount: suggest,
    }
  })
  const maxDrift = rows.reduce((m, r) => Math.max(m, Math.abs(r.drift ?? 0)), 0)
  const need = targets.size > 0 && maxDrift >= t.drift_threshold_pct
  return {
    ok: true, scope: 'trade', total_market_value: r2(totalMarketValue),
    rows: rows.sort((a, b) => Math.abs(b.drift ?? 0) - Math.abs(a.drift ?? 0)),
    drift_threshold: t.drift_threshold_pct, need_rebalance: need,
    max_drift: r2(maxDrift), has_target: targets.size > 0,
  }
}

/** 编排：读模拟持仓 + 目标 → 算再平衡报告 */
export async function rebalanceReport(db: LedgerDb): Promise<RebalanceReport> {
  const positions = await loadTradePositions(db)
  if (positions.length === 0) {
    return {
      ok: false, reason: '还没有模拟持仓，先去「交易」页下单买入', scope: 'trade',
      total_market_value: 0, rows: [],
      drift_threshold: REBALANCE_CONFIG.drift_threshold_pct,
      need_rebalance: false, max_drift: 0, has_target: false,
    }
  }
  const total = positions.reduce((s, p) => s + (p.market_value ?? 0), 0)
  const targets = await loadTargets(db)
  return computeRebalance(positions, targets, REBALANCE_CONFIG, total)
}

// ─── 提醒评估 ────────────────────────────────────────────────

export interface RebalanceHistoryRow {
  id: number
  triggered_at: string
  need_rebalance: number
  max_drift: number
  detail: string
}

/** 提醒历史（最新在前） */
export async function listRebalanceHistory(db: LedgerDb, limit = 50): Promise<RebalanceHistoryRow[]> {
  return db.query<RebalanceHistoryRow>(
    `SELECT id, triggered_at, need_rebalance, max_drift, detail
       FROM rebalance_history ORDER BY triggered_at DESC LIMIT ?`,
    [limit],
  )
}

/**
 * 评估是否需要提醒再平衡：need_rebalance 且过冷却 → 记一条记录（上层据此发本地通知）。
 * 返回 { triggered, report, record? }。
 */
export async function evaluateRebalance(
  db: LedgerDb,
  opts: { cooldownHours?: number } = {},
): Promise<{ triggered: boolean; report: RebalanceReport; record?: RebalanceHistoryRow }> {
  const cooldown = opts.cooldownHours ?? REBALANCE_CONFIG.cooldown_hours
  const report = await rebalanceReport(db)
  const last = await db.query<{ triggered_at: string }>(
    `SELECT triggered_at FROM rebalance_history ORDER BY triggered_at DESC LIMIT 1`, [],
  )
  const lastTime = last[0]?.triggered_at ? new Date(last[0].triggered_at).getTime() : 0
  const now = new Date()
  const cooldownMs = cooldown * 3600 * 1000
  if (report.need_rebalance && (now.getTime() - lastTime) >= cooldownMs) {
    const detail = JSON.stringify({
      max_drift: report.max_drift,
      drift_threshold: report.drift_threshold,
      rows: report.rows
        .filter(r => r.drift != null)
        .map(r => ({ fund_code: r.fund_code, actual: r.actual_weight, target: r.target_weight, drift: r.drift })),
    })
    const at = now.toISOString()
    await db.run(
      `INSERT INTO rebalance_history (triggered_at, need_rebalance, max_drift, detail) VALUES (?,?,?,?)`,
      [at, 1, report.max_drift, detail],
    )
    const rec: RebalanceHistoryRow = {
      id: 0, triggered_at: at, need_rebalance: 1, max_drift: report.max_drift, detail,
    }
    return { triggered: true, report, record: rec }
  }
  return { triggered: false, report }
}
