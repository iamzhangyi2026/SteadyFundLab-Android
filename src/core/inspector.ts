// ─────────────────────────────────────────────
// inspector.ts · 巡检引擎（每日健康检查）
// 检查项（每项写一条 data_health，source='inspector'）：
//   1 nav_daily 新鲜度 / 2 funds 候选池数量 / 3 orders 待处理 / 4 cash_ledger 余额
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { recordHealth } from './health.ts'

function _diffDays(latest: string | null): number {
  if (!latest) return 9999
  const t = Date.parse(String(latest).slice(0, 10) + 'T00:00:00')
  if (Number.isNaN(t)) return 9999
  return Math.floor((Date.now() - t) / 86400000)
}

export interface InspectionSummary {
  source: string
  checked_at: string
  checks: Record<string, Record<string, unknown>>
}

/** 执行健康检查，写入多条 data_health 行，返回汇总。 */
export async function runInspection(db: LedgerDb): Promise<InspectionSummary> {
  const summary: Record<string, Record<string, unknown>> = {}

  // 1) nav_daily 新鲜度
  let latest: string | null = null
  let n = 0
  try {
    const a = await db.query<{ d: string | null }>('SELECT MAX(nav_date) AS d FROM nav_daily')
    latest = a[0]?.d ?? null
    const b = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM nav_daily')
    n = b[0]?.c ?? 0
  } catch { /* ignore */ }
  let status: string, msg: string
  if (!latest) { status = 'fail'; msg = 'nav_daily 无数据' }
  else {
    const diff = _diffDays(latest)
    if (diff <= 1) { status = 'ok'; msg = `最新净值日期 ${latest}（${diff} 天前）` }
    else if (diff <= 7) { status = 'warn'; msg = `净值偏旧：最新 ${latest}（${diff} 天前）` }
    else { status = 'fail'; msg = `净值严重滞后：最新 ${latest}（${diff} 天前）` }
  }
  await recordHealth(db, 'inspector', 'nav_daily', status, n, msg)
  summary.nav_daily = { latest, count: n, status, message: msg }

  // 2) funds 候选池
  let active = 0, total = 0
  try {
    const a = await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM funds WHERE status='active'")
    active = a[0]?.c ?? 0
    const b = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM funds')
    total = b[0]?.c ?? 0
  } catch { /* ignore */ }
  const st2 = active > 0 ? 'ok' : 'fail'
  await recordHealth(db, 'inspector', 'funds', st2, active, `active=${active}, total=${total}`)
  summary.funds = { active, total, status: st2 }

  // 3) orders 待处理
  let pending = 0, totalOrders = 0
  try {
    const a = await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM orders WHERE status='pending'")
    pending = a[0]?.c ?? 0
    const b = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM orders')
    totalOrders = b[0]?.c ?? 0
  } catch { /* ignore */ }
  const st3 = pending === 0 ? 'ok' : 'warn'
  await recordHealth(db, 'inspector', 'orders', st3, pending, `pending=${pending}, total=${totalOrders}`)
  summary.orders = { pending, total: totalOrders, status: st3 }

  // 4) cash_ledger 余额
  let balance: number | null = null, nLedger = 0
  try {
    const a = await db.query<{ balance_after: number | null }>('SELECT balance_after FROM cash_ledger ORDER BY id DESC LIMIT 1')
    balance = a[0]?.balance_after ?? null
    const b = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM cash_ledger')
    nLedger = b[0]?.c ?? 0
  } catch { /* ignore */ }
  let st4: string, msg4: string
  if (balance == null) { st4 = 'warn'; msg4 = 'cash_ledger 无余额记录' }
  else if (balance < 0) { st4 = 'fail'; msg4 = `现金余额为负：${balance}` }
  else { st4 = 'ok'; msg4 = `当前余额 ${balance}` }
  await recordHealth(db, 'inspector', 'cash_ledger', st4, nLedger, msg4)
  summary.cash_ledger = { balance, count: nLedger, status: st4 }

  return { source: 'inspector', checked_at: new Date().toISOString().slice(0, 19).replace('T', ' '), checks: summary }
}

/** 最近 limit 条 inspector 健康检查记录。 */
export async function getInspection(db: LedgerDb, limit = 20): Promise<Record<string, unknown>[]> {
  try {
    return await db.query(
      "SELECT * FROM data_health WHERE source='inspector' ORDER BY created_at DESC, id DESC LIMIT ?", [limit],
    )
  } catch { return [] }
}
