// ─────────────────────────────────────────────
// dividend.ts · 分红识别与处理
//
//
// 为什么必须处理分红
//   分红会让单位净值除息下调（1.5 分红 0.1 后变 1.4）。引擎若不识别，
//   会把它记成单日暴跌 6.7%，污染回撤曲线和波动率。
//
// 识别原理
//   累计每份分红 D(t) = acc_nav(t) − nav(t)；当 D 在某天跳增（跳增额 / 前一日净值 ≥ gap%），
//   说明那天发生了除息，跳增量就是每份分红金额。
//
// 两种方式：cash 现金分红（入账，计已实现盈亏）/ reinvest 红利再投（折算新批次）
// 注意：历史某日持有份额无法精确还原，用**当前持有份额**近似估算。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { appendLedger } from './budget.ts'

export const CASH = 'cash'
export const REINVEST = 'reinvest'
const DEFAULT_GAP_PCT = 3.0

const round = (x: number, n: number) => Math.round(x * 10 ** n) / 10 ** n

/** 取该基金的分红方式，未设置则返回默认（现金分红）。 */
export async function getDividendMethod(db: LedgerDb, fundCode: string): Promise<string> {
  const rows = await db.query<{ dividend_method: string | null }>(
    'SELECT dividend_method FROM funds WHERE fund_code=?', [fundCode],
  )
  const m = rows[0]?.dividend_method
  return (m === CASH || m === REINVEST) ? m : CASH
}

/** 设置分红方式。 */
export async function setDividendMethod(
  db: LedgerDb, fundCode: string, method: string,
): Promise<{ ok: boolean; reason?: string; fund_code?: string; dividend_method?: string }> {
  if (method !== CASH && method !== REINVEST) {
    return { ok: false, reason: `分红方式必须是 ${CASH}（现金分红）或 ${REINVEST}（红利再投）` }
  }
  const exist = await db.query('SELECT 1 AS x FROM funds WHERE fund_code=?', [fundCode])
  if (!exist.length) return { ok: false, reason: '基金不在库中，请先添加该基金' }
  await db.run('UPDATE funds SET dividend_method=? WHERE fund_code=?', [method, fundCode])
  return { ok: true, fund_code: fundCode, dividend_method: method }
}

export interface DividendEvent {
  ex_date: string
  dividend_per_share: number
  nav_before: number
  nav_after: number
  drop_pct: number
}

/** 从 nav_daily 识别分红事件（不落库，纯计算）。 */
export async function detectDividends(
  db: LedgerDb, fundCode: string, gapPct?: number,
): Promise<DividendEvent[]> {
  const gap = gapPct ?? DEFAULT_GAP_PCT
  const rows = await db.query<{ nav_date: string; nav: number; acc_nav: number | null }>(
    'SELECT nav_date, nav, acc_nav FROM nav_daily WHERE fund_code=? ORDER BY nav_date ASC',
    [fundCode],
  )
  const events: DividendEvent[] = []
  let prev: { nav: number; cum: number } | null = null
  for (const r of rows) {
    const nav = r.nav || 0
    const acc = r.acc_nav != null ? r.acc_nav : nav
    const cum = acc - nav
    if (prev && prev.nav > 0) {
      const delta = cum - prev.cum
      if (delta > 0) {
        const pct = (delta / prev.nav) * 100
        if (pct >= gap) {
          events.push({
            ex_date: r.nav_date,
            dividend_per_share: round(delta, 6),
            nav_before: round(prev.nav, 4),
            nav_after: round(nav, 4),
            drop_pct: round(pct, 3),
          })
        }
      }
    }
    prev = { nav, cum }
  }
  return events
}

async function _heldShares(db: LedgerDb, fundCode: string): Promise<number> {
  // 结构隔离：显式声明取**两套系统**的持仓（分红事件对该基金的全部持仓都成立）；
  // 红利再投批次的 source 由下方 INSERT 按该基金已有持仓跟随，不混账。
  const rows = await db.query<{ s: number }>(
    `SELECT COALESCE(SUM(remaining_shares), 0) AS s FROM lots
     WHERE fund_code=? AND status='active' AND remaining_shares > 0 AND source IN ('real','trade')`,
    [fundCode],
  )
  return rows[0]?.s ?? 0
}

export interface DividendProcessResult {
  fund_code: string
  method: string
  detected: number
  applied: Record<string, unknown>[]
  skipped: Record<string, unknown>[]
}

/** 识别分红 → 落库 dividends → 按分红方式处理（幂等，重复调用不重复入账）。 */
export async function processDividends(db: LedgerDb, fundCode: string): Promise<DividendProcessResult> {
  const method = await getDividendMethod(db, fundCode)
  const events = await detectDividends(db, fundCode)
  const applied: Record<string, unknown>[] = []
  const skipped: Record<string, unknown>[] = []
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  for (const e of events) {
    const exist = await db.query('SELECT id FROM dividends WHERE fund_code=? AND ex_date=?', [fundCode, e.ex_date])
    if (exist.length) { skipped.push({ ...e, reason: '该除息日已处理过' }); continue }

    const shares = await _heldShares(db, fundCode)
    const amount = e.dividend_per_share * shares
    const reinvest = method === REINVEST ? 1 : 0

    await db.run(
      `INSERT INTO dividends
         (fund_code, ex_date, dividend_per_share, nav_before, nav_after, reinvest, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [fundCode, e.ex_date, e.dividend_per_share, e.nav_before, e.nav_after, reinvest, 'nav_daily_detect', now],
    )

    if (amount > 0 && reinvest) {
      // 红利再投：按除息后净值折算份额，新建批次（成本记为分红金额）
      const nav = e.nav_after || e.nav_before || 0
      const newShares = nav > 0 ? amount / nav : 0
      if (newShares > 0) {
        const orderId = `D${e.ex_date.replace(/-/g, '')}${String(Date.now()).slice(-5)}`
        await db.run(
          `INSERT OR IGNORE INTO orders
             (order_id, type, fund_code, amount, nav_date, status, decision_source, reason,
              fee_purchase, filled_nav, filled_shares, filled_net_amount, created_at, updated_at)
           VALUES (?, 'buy', ?, ?, ?, 'filled', 'auto', ?, 0, ?, ?, ?, ?, ?)`,
          [orderId, fundCode, amount, e.ex_date, `红利再投自动（${e.ex_date} 除息）`, nav, newShares, amount, now, now],
        )
        await db.run(
          // 结构隔离：红利再投批次**跟随该基金已有持仓的 source**（真实持仓的分红仍归真实，
          // 交易盘的分红归交易盘）；该基金没有任何批次时兜底 'trade'。
          `INSERT INTO lots
             (fund_code, buy_order_id, confirm_date, shares, remaining_shares, cost_amount, status, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active',
                   COALESCE((SELECT source FROM lots WHERE fund_code = ? LIMIT 1), 'trade'), ?)`,
          [fundCode, orderId, e.ex_date, newShares, newShares, amount, fundCode, now],
        )
      }
    } else if (amount > 0) {
      // 现金分红：分红到账入账
      await appendLedger(amount, `${fundCode} ${e.ex_date} 现金分红到账`, { action: 'dividend', fund_code: fundCode })
    }

    applied.push({ ...e, shares: round(shares, 2), amount: round(amount, 2), method })
  }

  return { fund_code: fundCode, method, detected: events.length, applied, skipped }
}

/** 分红记录列表。 */
export async function listDividends(db: LedgerDb, limit = 50): Promise<Record<string, unknown>[]> {
  return db.query(
    'SELECT * FROM dividends ORDER BY ex_date DESC, id DESC LIMIT ?', [limit],
  )
}
