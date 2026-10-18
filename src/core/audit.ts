// ─────────────────────────────────────────────
// audit.ts · 审计日志
// 审计日志落 audit_log 表存储。离线安全，绝不抛异常。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

export async function auditLog(db: LedgerDb, action: string, detail = ''): Promise<{ ok: boolean; ts?: string; action?: string; error?: string }> {
  try {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await db.run('INSERT INTO audit_log (ts, action, detail) VALUES (?, ?, ?)', [ts, action, detail])
    return { ok: true, ts, action }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) }
  }
}

/** 读取最近的审计记录。 */
export async function getAudit(db: LedgerDb, limit = 50): Promise<{ ts: string; action: string; detail: string }[]> {
  try {
    return await db.query<{ ts: string; action: string; detail: string }>(
      'SELECT ts, action, detail FROM audit_log ORDER BY id DESC LIMIT ?', [limit],
    )
  } catch { return [] }
}
