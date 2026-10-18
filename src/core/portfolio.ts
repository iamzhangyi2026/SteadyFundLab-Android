// ─────────────────────────────────────────────
// portfolio.ts · 组合级指标（当前：单基金时间加权收益率 TWR）
//
//
// TWR 与成本法（profit_pct）的区别：
//   成本法 金额加权，受加减仓的**时点和金额**影响 → 衡量「你这笔钱赚了多少」
//   TWR    只看基金净值本身的增长，剔除申赎时点影响 → 衡量「这只基金本身表现如何」
//   两者不等价：赚得少可能是择时问题，不是选品问题，组合诊断要分开看。
//
// 口径：用**累计净值** acc_nav（已把分红加回），避免分红除息造成假跌。
// 起止默认取「首个批次确认日 → 最新净值日」。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { getBudget } from './budget.ts'

export interface TwrResult {
  ok: boolean
  reason?: string
  fund_code?: string
  start_date?: string
  end_date?: string
  start_nav?: number
  end_nav?: number
  twr_pct?: number
  annualized_pct?: number | null
  days?: number
}

export async function timeWeightedReturn(
  db: LedgerDb,
  fundCode: string,
  startDate?: string | null,
  endDate?: string | null,
): Promise<TwrResult> {
  let start = startDate || null
  if (!start) {
    const r = await db.query<{ d: string | null }>(
      "SELECT MIN(confirm_date) AS d FROM lots WHERE fund_code=? AND status='active' AND source='trade'",
      [fundCode],
    )
    start = r[0]?.d ?? null
  }
  if (!start) return { ok: false, reason: '无持仓批次，无法计算 TWR' }

  // 注：SQLite 的 WHERE 不支持列别名，条件里写完整表达式
  let sql = `SELECT nav_date, COALESCE(acc_nav, nav) AS v FROM nav_daily
             WHERE fund_code = ? AND nav_date >= ? AND COALESCE(acc_nav, nav) IS NOT NULL`
  const params: unknown[] = [fundCode, start]
  if (endDate) { sql += ' AND nav_date <= ?'; params.push(endDate) }
  sql += ' ORDER BY nav_date ASC'

  const rows = await db.query<{ nav_date: string; v: number }>(sql, params)
  if (rows.length < 2) return { ok: false, reason: '净值数据不足（至少需要 2 个交易日）' }

  const v0 = Number(rows[0].v)
  const d0 = rows[0].nav_date
  const v1 = Number(rows[rows.length - 1].v)
  const d1 = rows[rows.length - 1].nav_date
  if (!v0 || v0 <= 0) return { ok: false, reason: '起始净值无效' }

  const twr = (v1 / v0 - 1) * 100
  const days = Math.max(0, Math.round(
    (new Date(d1 + 'T00:00:00').getTime() - new Date(d0 + 'T00:00:00').getTime()) / 86400000,
  ))
  let annualized: number | null = null
  if (days > 0) {
    const years = days / 365.0
    annualized = (Math.pow(v1 / v0, 1 / years) - 1) * 100
  }

  return {
    ok: true,
    fund_code: fundCode,
    start_date: d0, end_date: d1,
    start_nav: Number(v0.toFixed(4)), end_nav: Number(v1.toFixed(4)),
    twr_pct: Number(twr.toFixed(2)),
    annualized_pct: annualized == null ? null : Number(annualized.toFixed(2)),
    days,
  }
}

// ─────────────────────────────────────────────
// 组合曲线：每日快照 + 曲线统计
//
// 为什么用「每日快照」而不是实时回放历史：
//   lots 只存**当前**剩余份额，还原历史某天的持仓要回放全部订单/批次，成本高且易错。
//   改成每天收盘后写一笔快照，曲线就有真实历史轨迹。
//
// 快照口径：
//   market_value  = Σ(剩余份额 × 最新累计净值)   （累计净值口径，已把分红加回）
//   total_cost    剩余份额对应成本（按批次比例摊）
//   cash          现金余额；total_assets = 市值 + 现金
//   cumulative_pnl 累计收益 = 浮动盈亏 + 已实现盈亏
// ─────────────────────────────────────────────

export interface PortfolioState {
  market_value: number
  total_cost: number
  cash: number
  total_assets: number
  unrealized_pnl: number
  realized_pnl: number
  cumulative_pnl: number
}

const _r2 = (x: number) => Math.round(x * 100) / 100

/**
 * 当前组合状态：市值 / 成本 / 现金 / 盈亏。
 *
 * 结构隔离：**必须指定 source**（'real' 真实持仓 / 'trade' 交易盘虚拟持仓），
 * 不再允许"全表混算"。现金账本只属于交易盘 —— 真实持仓是外部导入的存量资产，
 * 本机没有它的现金流水，故 source='real' 时 cash/realized 恒为 0。
 */
export async function portfolioState(
  db: LedgerDb,
  source: 'real' | 'trade' = 'trade',
): Promise<PortfolioState> {
  const rows = await db.query<{ fund_code: string; remaining_shares: number; shares: number; cost_amount: number; nav: number | null }>(
    `SELECT l.fund_code, l.remaining_shares, l.shares, l.cost_amount,
       (SELECT COALESCE(n.acc_nav, n.nav) FROM nav_daily n
        WHERE n.fund_code = l.fund_code ORDER BY n.nav_date DESC LIMIT 1) AS nav
     FROM lots l
     WHERE l.status = 'active' AND l.remaining_shares > 0 AND l.source = ?`,
    [source],
  )
  let mv = 0, cost = 0
  for (const r of rows) {
    const nav = r.nav || 0
    mv += r.remaining_shares * nav
    if (r.shares) cost += r.cost_amount * (r.remaining_shares / r.shares)
  }

  let cash = 0, realized = 0
  if (source === 'trade') {
    try {
      const b = await getBudget()
      cash = b?.cash_balance ?? 0
      realized = b?.realized_pnl ?? 0
    } catch { /* 未初始化 → 0 */ }
  }

  return {
    market_value: _r2(mv),
    total_cost: _r2(cost),
    cash: _r2(cash),
    total_assets: _r2(mv + cash),
    unrealized_pnl: _r2(mv - cost),
    realized_pnl: _r2(realized),
    cumulative_pnl: _r2(mv - cost + realized),
  }
}

/**
 * 记录当日组合快照。同一天同一 source 重复调用会覆盖，不产生重复行。
 * 结构隔离：快照按 source 分行存（real / trade 各一条），互不覆盖。
 */
export async function takeSnapshot(
  db: LedgerDb,
  snapDate?: string,
  source: 'real' | 'trade' = 'trade',
): Promise<Record<string, unknown>> {
  const d = snapDate || new Date().toISOString().slice(0, 10)
  const s = await portfolioState(db, source)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  await db.run(
    `INSERT INTO portfolio_daily
       (snap_date, source, market_value, cash, total_assets, total_cost, unrealized_pnl, realized_pnl, cumulative_pnl, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(snap_date, source) DO UPDATE SET
       market_value=excluded.market_value, cash=excluded.cash, total_assets=excluded.total_assets,
       total_cost=excluded.total_cost, unrealized_pnl=excluded.unrealized_pnl,
       realized_pnl=excluded.realized_pnl, cumulative_pnl=excluded.cumulative_pnl,
       created_at=excluded.created_at`,
    [d, source, s.market_value, s.cash, s.total_assets, s.total_cost, s.unrealized_pnl, s.realized_pnl, s.cumulative_pnl, now],
  )
  return { ok: true, snap_date: d, source, ...s }
}

/** 最大回撤（%）：序列从历史峰值回落的最大幅度。 */
export function maxDrawdownOf(values: number[]): number {
  let peak: number | null = null
  let mdd = 0
  for (const v of values) {
    if (peak == null || v > peak) peak = v
    if (peak && peak > 0) {
      const dd = ((peak - v) / peak) * 100
      if (dd > mdd) mdd = dd
    }
  }
  return _r2(mdd)
}

/** 组合曲线序列 + 区间统计（累计收益率、最大回撤）。 */
export async function curve(
  db: LedgerDb,
  limit = 365,
  source: 'real' | 'trade' = 'trade',
): Promise<Record<string, unknown>> {
  // 结构隔离：曲线按 source 取（legacy 历史混账行不参与任一曲线）
  const rows = await db.query<Record<string, any>>(
    `SELECT snap_date, market_value, cash, total_assets, total_cost, unrealized_pnl, realized_pnl, cumulative_pnl
     FROM portfolio_daily WHERE source = ? ORDER BY snap_date DESC LIMIT ?`, [source, limit],
  )
  rows.reverse()
  const items = rows
  const stats: Record<string, unknown> = {
    points: items.length, max_drawdown_pct: 0, total_return_pct: 0,
    start_assets: null, end_assets: null, latest_cumulative_pnl: null,
  }
  if (items.length) {
    const assets = items.map(r => Number(r.total_assets))
    stats.start_assets = _r2(assets[0])
    stats.end_assets = _r2(assets[assets.length - 1])
    stats.max_drawdown_pct = maxDrawdownOf(assets)
    if (assets[0] > 0) stats.total_return_pct = _r2(((assets[assets.length - 1] - assets[0]) / assets[0]) * 100)
    stats.latest_cumulative_pnl = items[items.length - 1].cumulative_pnl
  }
  return { count: items.length, items, stats, note: '曲线来自 portfolio_daily 每日快照（每日收盘后自动记录，也可手动触发）' }
}

/** 当前组合概要：市值 / 成本 / 现金 / 盈亏 + 持仓数。 */
export async function getPortfolioSummary(
  db: LedgerDb,
  source: 'real' | 'trade' = 'trade',
): Promise<Record<string, unknown>> {
  const s = await portfolioState(db, source)
  const rows = await db.query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM lots WHERE status='active' AND remaining_shares > 0 AND source = ?",
    [source],
  )
  return { ...s, holdings_count: rows[0]?.c ?? 0 }
}
