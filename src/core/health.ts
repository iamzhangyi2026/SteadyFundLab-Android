// ─────────────────────────────────────────────
// health.ts · 健康度引擎（数据源健康检查 / 异常检测）
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

/** 写入一条 data_health 记录。 */
export async function recordHealth(
  db: LedgerDb, source: string, dataType: string, status: string, recordCount: number, message: string,
): Promise<void> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  await db.run(
    `INSERT INTO data_health (source, data_type, status, record_count, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [source, dataType, status, recordCount, message, now],
  )
}

export interface NavHealth {
  fund_code: string
  status: string
  latest_date?: string
  latest_nav?: number
  recent_records?: number
  message: string
}

/** 检查单只基金的健康度。 */
export async function checkNavHealth(db: LedgerDb, fundCode: string): Promise<NavHealth> {
  const latestRows = await db.query<{ nav_date: string; nav: number }>(
    'SELECT nav_date, nav, acc_nav FROM nav_daily WHERE fund_code = ? ORDER BY nav_date DESC LIMIT 1', [fundCode],
  )
  const latest = latestRows[0]
  if (!latest) return { fund_code: fundCode, status: 'no_data', message: '暂无净值数据' }

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const cntRows = await db.query<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM nav_daily WHERE fund_code = ? AND nav_date >= ?', [fundCode, sevenDaysAgo],
  )
  const recentCount = cntRows[0]?.cnt ?? 0
  const status = recentCount >= 5 ? 'ok' : 'missing'
  return {
    fund_code: fundCode, status,
    latest_date: latest.nav_date, latest_nav: latest.nav, recent_records: recentCount,
    message: `最新净值 ${latest.nav_date}: ${latest.nav}`,
  }
}

/** 检查所有基金的健康度。⚠️ 安卓 funds 表是全市场（2.7 万只）→ 必须限量。 */
export async function checkAllHealth(db: LedgerDb, limit = 300): Promise<NavHealth[]> {
  const rows = await db.query<{ fund_code: string }>('SELECT fund_code FROM funds LIMIT ?', [limit])
  const out: NavHealth[] = []
  for (const r of rows) out.push(await checkNavHealth(db, r.fund_code))
  return out
}

/** 检测净值异常（单日涨跌超 5%）。 */
export async function detectAnomalies(db: LedgerDb, fundCode: string, window = 5): Promise<Record<string, unknown>[]> {
  const rows = await db.query<{ nav_date: string; acc_nav: number | null }>(
    'SELECT nav_date, acc_nav FROM nav_daily WHERE fund_code = ? ORDER BY nav_date DESC LIMIT ?', [fundCode, window + 1],
  )
  const anomalies: Record<string, unknown>[] = []
  if (rows.length < window + 1) return anomalies
  for (let i = 0; i < rows.length - 1; i++) {
    const curr = rows[i], prev = rows[i + 1]
    if (prev.acc_nav && prev.acc_nav > 0 && curr.acc_nav != null) {
      const changePct = ((curr.acc_nav - prev.acc_nav) / prev.acc_nav) * 100
      if (Math.abs(changePct) > 5) {
        anomalies.push({ date: curr.nav_date, type: 'big_move', change_pct: Math.round(changePct * 100) / 100, detail: `单日涨跌幅 ${changePct.toFixed(2)}%` })
      }
    }
  }
  return anomalies
}

/** 运行完整健康检查。 */
export async function runHealthCheck(db: LedgerDb): Promise<{ total: number; ok: number; missing: number; details: NavHealth[] }> {
  const details = await checkAllHealth(db)
  const ok = details.filter(r => r.status === 'ok').length
  const missing = details.filter(r => r.status === 'missing').length
  return { total: details.length, ok, missing, details }
}
