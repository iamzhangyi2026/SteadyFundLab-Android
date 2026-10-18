// ─────────────────────────────────────────────
// monitor.ts · 持仓监控（跑纪律检查 + 组合快照）
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { checkDiscipline } from './rules.ts'
import { takeSnapshot } from './portfolio.ts'

export interface MonitorResult {
  as_of: string
  positions_checked: number
  alerts: Record<string, unknown>[]
  triggered_count: number
  snapshot: Record<string, unknown>
}

/** 对所有持仓跑纪律线检查并记录组合快照。 */
export async function monitorPositions(db: LedgerDb): Promise<MonitorResult> {
  const asOf = new Date().toISOString().slice(0, 10)
  // 结构隔离：纪律线/风控只对**真实持仓**生效（保护真钱）。
  // 交易盘是练手账本，不配真钱止损语义。
  const held = await db.query<{ fund_code: string }>(
    "SELECT DISTINCT fund_code FROM lots WHERE status='active' AND remaining_shares > 0 AND source='real'",
  )
  const alerts: Record<string, unknown>[] = []
  const codes = new Set<string>()
  for (const h of held) {
    codes.add(h.fund_code)
    const navRows = await db.query<{ nav: number; acc_nav: number | null }>(
      'SELECT nav, acc_nav FROM nav_daily WHERE fund_code=? ORDER BY nav_date DESC LIMIT 1', [h.fund_code],
    )
    const r = navRows[0]
    if (!r) continue
    const nav = r.nav
    const acc = r.acc_nav ?? nav
    try {
      const lines = await checkDiscipline(db, h.fund_code, nav, acc, asOf)
      for (const l of lines || []) {
        alerts.push({ fund_code: h.fund_code, ...(l as unknown as Record<string, unknown>), action_taken: 'alert_created' })
      }
    } catch { /* 单只失败跳过 */ }
  }
  const snapshot = await takeSnapshot(db, undefined, 'real')
  return { as_of: asOf, positions_checked: codes.size, alerts, triggered_count: alerts.length, snapshot }
}
