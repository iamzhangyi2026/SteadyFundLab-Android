// ─────────────────────────────────────────────
// corpus.ts · 归档库引擎
//
// ⚠️ CapacitorSQLite 单库架构下不开第二连接 → 本模块以主库为准：
//    - initCorpus()  → 返回说明（无独立归档库）
//    - corpusStats() → 用主库 news_triage / sector_news 计数
//    - syncFromOperational() → no-op（数据本就在主库）
//    离线安全，绝不抛异常。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

export async function initCorpus(): Promise<string> {
  return '(mobile: 无独立归档库，归档数据即在主库 news_triage / sector_news)'
}

export async function corpusStats(db: LedgerDb): Promise<Record<string, number>> {
  try {
    const n = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM news_triage')
    const s = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM sector_news')
    const nc = n[0]?.c ?? 0
    const sc = s[0]?.c ?? 0
    return { _total: nc + sc, news: nc, sector_news: sc }
  } catch {
    return { _total: 0, news: 0, sector_news: 0 }
  }
}

/** 手机端归档即主库，无需同步（保留签名兼容）。 */
export async function syncFromOperational(_db: LedgerDb): Promise<Record<string, number>> {
  return {}
}
