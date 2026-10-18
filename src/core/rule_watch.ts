// ─────────────────────────────────────────────
// rule_watch.ts · 规则观察引擎（监测 fund_status 变化 + 费率同步）
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

const WATCH_FIELDS = ['purchase_status', 'redeem_status'] as const
export const FEE_TTL_DAYS = 7

function _now(): string { return new Date().toISOString().slice(0, 19).replace('T', ' ') }

/** 比较最新 fund_status 与上一条快照，发现变化则写入 rule_change_log。 */
export async function watchRules(db: LedgerDb): Promise<Record<string, unknown>[]> {
  const detected: Record<string, unknown>[] = []
  let codes: string[] = []
  try {
    const rows = await db.query<{ fund_code: string }>('SELECT DISTINCT fund_code FROM fund_status')
    codes = rows.map(r => r.fund_code)
  } catch { return detected }

  for (const code of codes) {
    const rows = await db.query<Record<string, any>>(
      'SELECT * FROM fund_status WHERE fund_code=? ORDER BY status_date DESC, id DESC LIMIT 2', [code],
    )
    if (rows.length < 2) continue
    const [latest, prev] = rows
    for (const kind of WATCH_FIELDS) {
      const oldV = prev[kind]
      const newV = latest[kind]
      if (newV == null || oldV === newV) continue
      const last = await db.query<{ new_value: string | null }>(
        'SELECT new_value FROM rule_change_log WHERE fund_code=? AND kind=? ORDER BY id DESC LIMIT 1', [code, kind],
      )
      if (last[0] && last[0].new_value === newV) continue
      await db.run(
        'INSERT INTO rule_change_log (fund_code, kind, old_value, new_value, detected_at) VALUES (?,?,?,?,?)',
        [code, kind, oldV == null ? null : String(oldV), String(newV), _now()],
      )
      detected.push({ fund_code: code, kind, old_value: oldV, new_value: newV })
    }
  }
  return detected
}

/** 最近 limit 条规则变动日志。 */
export async function getRuleChanges(db: LedgerDb, limit = 20): Promise<Record<string, unknown>[]> {
  try { return await db.query('SELECT * FROM rule_change_log ORDER BY id DESC LIMIT ?', [limit]) }
  catch { return [] }
}

/**
 * 同步赎回费阶梯。
 * ⚠️ 未接可用 HTTP 源 → 不抓取（返回 failed 计数），
 *    仅保留缓存读取能力（redeemTiersOf），**不编造**。
 */
export async function syncFundFees(
  db: LedgerDb, codes: string[], _force = false, _ttlDays = FEE_TTL_DAYS,
): Promise<{ fetched: number; ok: number; changed: number; failed: number }> {
  const uniq = [...new Set((codes || []).map(c => String(c).trim()).filter(Boolean))]
  return { fetched: 0, ok: 0, changed: 0, failed: uniq.length }
}

/** 读某只基金已缓存的赎回费档位；没同步过返回 null（不编造）。 */
export async function redeemTiersOf(db: LedgerDb, code: string): Promise<unknown[] | null> {
  try {
    const rows = await db.query<{ redeem_tiers: string | null }>(
      'SELECT redeem_tiers FROM fund_fee WHERE fund_code = ?', [String(code)],
    )
    const raw = rows[0]?.redeem_tiers
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

/** 检测这些基金的申购状态/限购额度变化并留痕，返回变化条数。 */
export async function watchPurchaseStatus(db: LedgerDb, codes: string[]): Promise<number> {
  let changed = 0
  for (const code of [...new Set((codes || []).map(c => String(c).trim()).filter(Boolean))]) {
    const rows = await db.query<{ purchase_status: string | null; purchase_limit: number | null }>(
      'SELECT purchase_status, purchase_limit FROM fund_status WHERE fund_code=? ORDER BY status_date DESC, id DESC LIMIT 1',
      [code],
    )
    const pi = rows[0]
    if (!pi) continue
    const cur = `${pi.purchase_status ?? ''}|${pi.purchase_limit ?? ''}`
    const last = await db.query<{ new_value: string | null }>(
      "SELECT new_value FROM rule_change_log WHERE fund_code = ? AND kind = 'purchase_status' ORDER BY id DESC LIMIT 1", [code],
    )
    if (last.length === 0) {
      await db.run('INSERT INTO rule_change_log (fund_code, kind, old_value, new_value, detected_at) VALUES (?,?,?,?,?)',
        [code, 'purchase_status', null, cur, _now()])
      continue
    }
    if (last[0].new_value !== cur) {
      await db.run('INSERT INTO rule_change_log (fund_code, kind, old_value, new_value, detected_at) VALUES (?,?,?,?,?)',
        [code, 'purchase_status', last[0].new_value, cur, _now()])
      changed++
    }
  }
  return changed
}
