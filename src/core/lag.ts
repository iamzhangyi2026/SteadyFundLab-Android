// ─────────────────────────────────────────────
// lag.ts · 滞后信号检测引擎（估值洼地信号 / 趋势反转）
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { percentile } from './screen_rules.ts'

export interface ValleySignal {
  fund_code: string
  signal_type: string
  percentile: number
  latest_nav: number | null
  detected_at: string
}

/** 检测估值洼地信号（近 minDays 天内有净值 且 历史分位 < 30）。
 *  ⚠️ 安卓按 limit 限量扫描（全市场 2.7 万只，逐只算分位太慢）。 */
export async function detectValleySignals(db: LedgerDb, minDays = 5, limit = 500): Promise<ValleySignal[]> {
  const signals: ValleySignal[] = []
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const codesRows = await db.query<{ fund_code: string }>(
    'SELECT DISTINCT fund_code FROM nav_daily WHERE nav_date >= ? LIMIT ?', [since, limit],
  )
  const minSince = new Date(Date.now() - minDays * 86400000).toISOString().slice(0, 10)
  for (const { fund_code } of codesRows) {
    const recent = await db.query<{ acc_nav: number | null }>(
      'SELECT nav_date, acc_nav FROM nav_daily WHERE fund_code = ? AND nav_date >= ? ORDER BY nav_date DESC',
      [fund_code, minSince],
    )
    if (recent.length < 5) continue
    const latest = recent[0]?.acc_nav ?? null
    const full = await db.query<{ acc_nav: number | null }>(
      'SELECT acc_nav FROM nav_daily WHERE fund_code = ? ORDER BY nav_date', [fund_code],
    )
    const series = full.map(r => r.acc_nav).filter((v): v is number => v != null)
    const pct = percentile(series)
    if (pct != null && pct < 30) {
      signals.push({
        fund_code, signal_type: 'valley',
        percentile: Math.round(pct * 10) / 10, latest_nav: latest,
        detected_at: new Date().toISOString(),
      })
    }
  }
  return signals
}

/** 检测趋势反转信号（近 window 日动量）。 */
export async function detectTrendReversal(db: LedgerDb, fundCode: string, window = 20): Promise<Record<string, unknown>> {
  const rows = await db.query<{ nav_date: string; acc_nav: number | null }>(
    'SELECT nav_date, acc_nav FROM nav_daily WHERE fund_code = ? ORDER BY nav_date DESC LIMIT ?', [fundCode, window],
  )
  if (rows.length < window) return { fund_code: fundCode, signal: null }
  const values = rows.map(r => r.acc_nav ?? 0).reverse()
  const momentum = values[0] > 0 ? ((values[values.length - 1] - values[0]) / values[0]) * 100 : 0
  const signal = momentum > 5 ? 'reversal_up' : (momentum < -5 ? 'reversal_down' : 'stable')
  return { fund_code: fundCode, signal, momentum: Math.round(momentum * 100) / 100, period: `${values[0]} -> ${values[values.length - 1]}` }
}
