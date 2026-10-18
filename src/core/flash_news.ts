// ─────────────────────────────────────────────
// flash_news.ts · 闪电/快讯新闻（来自 market_news 最近发布）
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

/** 从 market_news 读取最近新闻（pub_time 倒序，缺失行排末尾）。 */
export async function getFlashNews(db: LedgerDb, limit = 50): Promise<Record<string, unknown>[]> {
  try {
    return await db.query(
      `SELECT * FROM market_news
       ORDER BY (CASE WHEN pub_time IS NULL OR pub_time='' THEN '0' ELSE pub_time END) DESC, id DESC
       LIMIT ?`,
      [limit],
    )
  } catch { return [] }
}
