// ─────────────────────────────────────────────
// active_news.ts · 待推送/活跃新闻（来自 news_feed）
// news_feed 无 pushed 列，故按 id 倒序返回全部。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

export async function getActiveNews(db: LedgerDb, limit = 50): Promise<Record<string, unknown>[]> {
  try {
    return await db.query('SELECT * FROM news_feed ORDER BY id DESC LIMIT ?', [limit])
  } catch { return [] }
}
