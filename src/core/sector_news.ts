// ─────────────────────────────────────────────
// sector_news.ts · 行业/概念板块行情
// 抓取由调用方传入 boards（端上板块 fetcher 在 init_app 注入）。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

/** 读取 sector_news（按 board_type、hot_rank 升序）。 */
export async function getSectorNews(db: LedgerDb, boardType = 'industry', limit = 40): Promise<Record<string, unknown>[]> {
  try {
    return await db.query(
      `SELECT * FROM sector_news WHERE board_type = ?
       ORDER BY CASE WHEN hot_rank IS NULL OR hot_rank=0 THEN 9999 ELSE hot_rank END ASC, change_pct DESC
       LIMIT ?`,
      [boardType, limit],
    )
  } catch { return [] }
}

export interface BoardRow { sector: string; change_pct?: number; net_inflow?: number }

/** 把板块行情写入 sector_news。返回 {fetched, saved}。 */
export async function refreshSectorNews(db: LedgerDb, boards: BoardRow[]): Promise<{ fetched: number; saved: number }> {
  const fetched = boards?.length ?? 0
  let saved = 0
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  for (const b of boards || []) {
    try {
      await db.run(
        `INSERT INTO sector_news
           (sector, sector_code, change_pct, net_inflow, leader_stock, leader_change_pct,
            hot_rank, news_title, news_url, news_source, news_summary, fetched_at, board_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [String(b.sector || ''), '', Number(b.change_pct || 0), Number(b.net_inflow || 0),
         '', 0, 0, '', '', '', '', now, 'industry'],
      )
      saved++
    } catch { /* 单条失败跳过 */ }
  }
  return { fetched, saved }
}
