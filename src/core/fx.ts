// ─────────────────────────────────────────────
// fx.ts · 汇率引擎（USD/CNY 等）
//
// 权威库 fx_rate 表：(pair, rate_date, rate, source, fetched_at)。
// 离线安全：表为空或查询失败时 latestUsdCny 降级到 ~7.25。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

export const DEFAULT_USD_CNY = 7.25

function _now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

export interface FxRate { rate: number | null; date: string | null; source: string | null }

/** 读取 USD/CNY 最新汇率；空表/异常时降级到 7.25。 */
export async function latestUsdCny(db: LedgerDb): Promise<FxRate> {
  try {
    const rows = await db.query<{ rate: number; rate_date: string; source: string | null }>(
      "SELECT * FROM fx_rate WHERE pair='USD/CNY' ORDER BY rate_date DESC, fetched_at DESC LIMIT 1",
    )
    if (rows[0]) return { rate: rows[0].rate, date: rows[0].rate_date, source: rows[0].source }
  } catch { /* 降级 */ }
  return { rate: DEFAULT_USD_CNY, date: null, source: 'default' }
}

/** 取指定 pair（及可选日期）的汇率；缺省取最新。 */
export async function getFxRate(db: LedgerDb, pair = 'USD/CNY', date?: string | null): Promise<FxRate> {
  try {
    const rows = date
      ? await db.query<{ rate: number; rate_date: string; source: string | null }>(
          'SELECT * FROM fx_rate WHERE pair=? AND rate_date=? ORDER BY fetched_at DESC LIMIT 1', [pair, date])
      : await db.query<{ rate: number; rate_date: string; source: string | null }>(
          'SELECT * FROM fx_rate WHERE pair=? ORDER BY rate_date DESC, fetched_at DESC LIMIT 1', [pair])
    if (rows[0]) return { rate: rows[0].rate, date: rows[0].rate_date, source: rows[0].source }
  } catch { /* ignore */ }
  return { rate: null, date: null, source: null }
}

/** 写入一条汇率（复合主键冲突则更新）。 */
export async function recordFx(
  db: LedgerDb, pair: string, rate: number, rateDate: string, source?: string | null,
): Promise<FxRate> {
  await db.run(
    `INSERT INTO fx_rate (pair, rate_date, rate, source, fetched_at) VALUES (?,?,?,?,?)
     ON CONFLICT(pair, rate_date) DO UPDATE SET
       rate=excluded.rate, source=excluded.source, fetched_at=excluded.fetched_at`,
    [pair, rateDate, Number(rate), source ?? null, _now()],
  )
  return getFxRate(db, pair, rateDate)
}
