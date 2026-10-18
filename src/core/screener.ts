// ─────────────────────────────────────────────
// screener.ts · 基金池筛选引擎
//
//
// - screenAll()       全量筛选（只读本地净值，按分位升序返回候选）
// - getPoolStats()    基金池统计
// - buildCandidates() 新闻导向候选挖掘（事件主题 → 板块资金 → 候选基金）
//
// ⚠️ 只给「事实与依据」，**不推荐买哪只**（决策权在接管 agent / 用户）。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { SCREEN_RULES } from './config.ts'
import {
  MIN_SERIES, navSeries, percentile, ret1y, ret3m, annualVol, maxDrawdown,
  screenCandidates, type Candidate,
} from './screen_rules.ts'

export interface PoolStats {
  total_funds: number
  with_nav_data: number
  candidates: number
  candidate_codes: string[]
}

/** 单只基金的关键统计（供批量筛选）。 */
async function _fundStats(db: LedgerDb, code: string): Promise<Record<string, unknown> | null> {
  const vals = await navSeries(db, code)
  if (vals.length < MIN_SERIES) return null
  return {
    fund_code: code,
    percentile: percentile(vals),
    ret_1y: ret1y(vals),
    ret_3m: ret3m(vals),
    annual_vol: annualVol(vals),
    max_drawdown: maxDrawdown(vals),
  }
}

/**
 * 全量筛选（扫描有足够净值的基金，按分位升序）。
 * @param opts.limit 最多扫描多少只（默认 3000；手机端避免一次扫 2.7 万只太慢）
 */
export async function screenAll(db: LedgerDb, opts: { limit?: number } = {}): Promise<Candidate[]> {
  const limit = opts.limit ?? 3000
  const rows = await db.query<{ fund_code: string; c: number }>(
    `SELECT fund_code, COUNT(*) AS c FROM nav_daily
     GROUP BY fund_code HAVING c >= ? LIMIT ?`,
    [MIN_SERIES, limit],
  )
  const stats: Record<string, unknown>[] = []
  for (const r of rows) {
    const s = await _fundStats(db, r.fund_code)
    if (s) stats.push(s)
  }
  return screenCandidates(stats, SCREEN_RULES)
}

/** 基金池统计。 */
export async function getPoolStats(db: LedgerDb): Promise<PoolStats> {
  const totalRows = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM funds')
  const navRows = await db.query<{ c: number }>('SELECT COUNT(DISTINCT fund_code) AS c FROM nav_daily')
  const candidates = await screenAll(db)
  return {
    total_funds: totalRows[0]?.c ?? 0,
    with_nav_data: navRows[0]?.c ?? 0,
    candidates: candidates.length,
    candidate_codes: candidates.slice(0, 5).map(c => c.fund_code),
  }
}

/** 按主题关键词匹配候选基金（基金名称命中主题词）。 */
async function _matchFunds(db: LedgerDb, theme: string, limit = 12): Promise<Record<string, unknown>[]> {
  const kw = (theme || '').trim()
  if (!kw) return []
  const rows = await db.query<{ fund_code: string; fund_name: string | null; category: string | null }>(
    'SELECT fund_code, fund_name, category FROM funds WHERE fund_name LIKE ? ORDER BY fund_code LIMIT ?',
    [`%${kw}%`, limit],
  )
  const out: Record<string, unknown>[] = []
  for (const r of rows) {
    out.push({
      code: r.fund_code,
      name: (r.fund_name || '').trim(),
      type: String(r.category || '').trim(),
      screening: await _screenOne(db, r.fund_code),
    })
  }
  return out
}

async function _screenOne(db: LedgerDb, code: string): Promise<Record<string, unknown> | null> {
  const vals = await navSeries(db, code)
  const p = percentile(vals)
  const r = ret1y(vals)
  const d = maxDrawdown(vals)
  if (p == null || r == null || d == null) return null
  return { percentile: p, ret_1y: r, max_dd: d }
}

/**
 * 新闻导向候选挖掘：
 *   ① 近 days 天情报事件最多的 Top 主题（intel_events.impact_boards）
 *   ② 该主题在板块资金流的方向（作为"验证"事实，本地无则 unknown）
 *   ③ 按主题名匹配候选基金（附筛选事实）
 * ⚠️ 只给依据与事实，不代替决策。
 */
export async function buildCandidates(
  db: LedgerDb, days = 3, topN = 5,
): Promise<{ as_of: string; days: number; themes: Record<string, unknown>[] }> {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  let rows: { impact_boards: string | null; events: number }[] = []
  try {
    rows = await db.query<{ impact_boards: string | null; events: number }>(
      `SELECT impact_boards, COUNT(*) AS events FROM intel_events
       WHERE TRIM(COALESCE(impact_boards,'')) <> '' AND event_date >= ?
       GROUP BY impact_boards ORDER BY events DESC LIMIT ?`,
      [since, topN],
    )
  } catch {
    rows = []
  }

  const themes: Record<string, unknown>[] = []
  for (const r of rows) {
    const board = (r.impact_boards || '').split(',')[0].trim()
    themes.push({
      theme: r.impact_boards,
      events: r.events,
      funds: await _matchFunds(db, board),
      flow_state: 'unknown',   // 本地无 sector_news 表 → 无法给资金方向
    })
  }
  return { as_of: new Date().toISOString().slice(0, 19).replace('T', ' '), days, themes }
}
