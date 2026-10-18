// ─────────────────────────────────────────────
// review.ts · 组合回顾引擎
// ⚠️ 只给事实，不下"该不该买"的结论。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { getPortfolioSummary } from './portfolio.ts'

export const DEFAULT_DAYS = 20
export const DEFAULT_TOP_N = 8

/** 组合概况（基于真实持仓与账本）。 */
export async function reviewPortfolioSummary(
  db: LedgerDb,
  source: 'real' | 'trade' = 'trade',
): Promise<Record<string, unknown>> {
  // 结构隔离：复盘摘要按 source 取（默认交易盘）
  const s = await getPortfolioSummary(db, source)
  const rows = await db.query<Record<string, any>>(
    `SELECT l.fund_code, f.fund_name, l.remaining_shares, l.cost_amount, l.shares,
       (SELECT COALESCE(n.acc_nav, n.nav) FROM nav_daily n WHERE n.fund_code=l.fund_code ORDER BY n.nav_date DESC LIMIT 1) AS nav
     FROM lots l LEFT JOIN funds f ON f.fund_code = l.fund_code
     WHERE l.status='active' AND l.remaining_shares > 0 AND l.source = ?`,
    [source],
  )
  const positions = rows.map(r => {
    const mv = (r.remaining_shares || 0) * (r.nav || 0)
    const cost = r.shares ? r.cost_amount * (r.remaining_shares / r.shares) : 0
    return {
      fund_code: r.fund_code, fund_name: r.fund_name,
      shares: r.remaining_shares, cost_amount: cost,
      market_value: mv, profit: mv - cost,
      profit_pct: cost > 0 ? ((mv - cost) / cost) * 100 : null,
    }
  })
  return {
    total_assets: s.total_assets, market_value: s.market_value, cash: s.cash,
    positions, position_count: positions.length,
  }
}

/** 历史表现（基于 portfolio_daily 快照）。结构隔离：按 source 取（默认交易盘，与 reviewPortfolioSummary 一致；legacy 混账行不参与）。 */
export async function getPerformanceHistory(db: LedgerDb, source: 'real' | 'trade' = 'trade', days = 90): Promise<Record<string, unknown>[]> {
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const rows = await db.query<Record<string, any>>(
    `SELECT snap_date, market_value, unrealized_pnl, total_cost FROM portfolio_daily
     WHERE source = ? AND snap_date >= ? ORDER BY snap_date DESC`, [source, start],
  )
  const history = rows.map(r => {
    const mv = r.market_value || 0
    const profit = r.unrealized_pnl || 0
    return { date: r.snap_date, market_value: mv, profit, profit_pct: mv > 0 ? Math.round((profit / mv * 100) * 100) / 100 : 0 }
  })
  return history.reverse()
}

/** 生成回顾报告。结构隔离：source 贯穿（概况与历史曲线同一口径，默认交易盘）。 */
export async function generateReviewReport(db: LedgerDb, source: 'real' | 'trade' = 'trade', period = 'weekly'): Promise<Record<string, unknown>> {
  const portfolio = await reviewPortfolioSummary(db, source)
  const days = period === 'monthly' ? 30 : 7
  const history = await getPerformanceHistory(db, source, days * 2)
  let periodReturn = 0
  if (history.length >= 2) {
    const oldV = Number(history[0].market_value) || 0
    const newV = Number(history[history.length - 1].market_value) || 0
    periodReturn = oldV > 0 ? ((newV - oldV) / oldV) * 100 : 0
  }
  const cash = Number(portfolio.cash) || 0
  const mv = Number(portfolio.market_value) || 0
  const base = cash + mv
  const totalReturn = base > 0 ? (mv / base * 100 - 100) : 0
  return {
    period, portfolio,
    period_return: Math.round(periodReturn * 100) / 100,
    total_return: Math.round(totalReturn * 100) / 100,
    generated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
}

/** 近 days 天里，按事件数排前的主题（来自 news_triage.impact_boards）。 */
async function _eventSeries(db: LedgerDb, days: number, topN: number): Promise<Record<string, unknown>[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  try {
    const rows = await db.query<{ impact_boards: string; events: number; first_day: string | null }>(
      `SELECT impact_boards, COUNT(*) AS events, MIN(COALESCE(first_pub_time, processed_at)) AS first_day
       FROM news_triage WHERE TRIM(COALESCE(impact_boards,'')) <> '' AND COALESCE(first_pub_time, processed_at) >= ?
       GROUP BY impact_boards ORDER BY events DESC LIMIT ?`, [since, topN],
    )
    return rows.map(r => ({ theme: r.impact_boards, events: r.events, first_day: String(r.first_day || '').slice(0, 10) }))
  } catch { return [] }
}

/** 某板块自 fromDate 起的价格轨迹（(日期, 累计涨跌幅%)）。 */
async function _boardTrack(db: LedgerDb, board: string, fromDate: string): Promise<[string, number][]> {
  const rows = await db.query<{ d: string; chg: number | null }>(
    `SELECT substr(fetched_at,1,10) AS d, AVG(change_pct) AS chg FROM sector_news
     WHERE sector = ? AND substr(fetched_at,1,10) >= ? GROUP BY d ORDER BY d`, [board, fromDate],
  )
  if (!rows.length) return []
  let base = 100
  const out: [string, number][] = []
  for (const r of rows) {
    base *= (1 + (r.chg || 0) / 100)
    out.push([r.d, Math.round((base - 100) * 100) / 100])
  }
  return out
}

/** 主题复盘：把「事件什么时候冒出来」与「那之后板块怎么走」摆在一起（只给事实）。 */
export async function buildReview(db: LedgerDb, days = DEFAULT_DAYS, topN = DEFAULT_TOP_N): Promise<Record<string, unknown>> {
  const items: Record<string, unknown>[] = []
  for (const e of await _eventSeries(db, days, topN)) {
    const board = String(e.theme || '').split(',')[0].trim()
    const firstDay = String(e.first_day || '')
    const track = (board && firstDay) ? await _boardTrack(db, board, firstDay) : []
    items.push({
      theme: e.theme, events: e.events, first_day: e.first_day,
      has_data: track.length > 0, cum_pct: track.length ? track[track.length - 1][1] : null, track,
    })
  }
  return {
    as_of: new Date().toISOString().slice(0, 19).replace('T', ' '),
    days, items,
    note: '只给「事件首现 → 之后板块表现」的事实，不判断该不该买；无价格轨迹的主题标 has_data=false（不编造）',
  }
}

/** 映射校准：把复盘数据归纳成统计（只归纳事实，不自动改规则）。 */
export async function buildCalibration(db: LedgerDb, days = 60, topN = 30): Promise<Record<string, unknown>> {
  const base = await buildReview(db, days, topN)
  const items = (base.items as Record<string, unknown>[]) || []
  let up = 0, down = 0, nodata = 0
  const cums: number[] = []
  for (const it of items) {
    if (!it.has_data || it.cum_pct == null) { nodata++; it.verdict = 'nodata'; continue }
    cums.push(Number(it.cum_pct))
    if (Number(it.cum_pct) > 0) { up++; it.verdict = 'up' } else { down++; it.verdict = 'down' }
  }
  const withData = up + down
  const avgCum = cums.length ? Math.round((cums.reduce((s, x) => s + x, 0) / cums.length) * 100) / 100 : null
  const conclusion = withData === 0
    ? '有价格轨迹的主题为 0，暂无法校准（先积累几日热点榜历史）'
    : `${withData} 个有轨迹的主题里，事件后累计上涨 ${up} 个（${Math.round(up / withData * 100)}%）、下跌 ${down} 个；简单平均 ${avgCum! >= 0 ? '+' : ''}${avgCum}%。统计事实仅供参考，是否据此调整映射由 AI/人判断`
  return {
    as_of: base.as_of, days, total: items.length, with_data: withData, up, down,
    flat: items.length - withData - nodata, nodata, avg_cum: avgCum, items, conclusion,
    note: '只归纳统计事实，不自动改映射规则；无价格轨迹的主题标 nodata（不编造）',
  }
}
