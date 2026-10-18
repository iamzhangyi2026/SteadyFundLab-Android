// ─────────────────────────────────────────────
// news_quality.ts · 新闻质量评分
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

const GOOD_SOURCES = new Set([
  '新华社', '人民日报', '央视', '央视新闻', '证券时报', '中国证券报', '经济日报',
  '财新', '36氪', '澎湃', '第一财经', '华尔街见闻', '东方财富', '中国新闻网',
  'MarketWatch', 'CNBC', 'Reuters', 'Bloomberg', 'WSJ', 'FT',
])
const WEAK_SOURCES = new Set(['未知', '匿名', '网友', '转载', '营销号'])

export const LOW_QUALITY_THRESHOLD = 60

/** 对单条新闻打分（0~100）。返回 {quality, quality_reason}。 */
export function scoreQuality(item: Record<string, any>): { quality: number; quality_reason: string } {
  try {
    const title = String(item?.title ?? item?.title_zh ?? '')
    const summary = String(item?.summary ?? item?.summary_zh ?? item?.content ?? '')
    const source = String(item?.source ?? '')
    const reasons: string[] = []
    let score = 50

    if (title.length >= 8) { score += 10; reasons.push('标题完整') }
    else if (title.length === 0) { score -= 20; reasons.push('标题缺失') }
    else { score -= 5; reasons.push('标题偏短') }

    if (summary.length >= 40) { score += 15; reasons.push('正文充分') }
    else if (summary.length === 0) { score -= 15; reasons.push('正文缺失') }
    else { score -= 5; reasons.push('正文偏短') }

    if (/\d/.test(title + summary)) { score += 10; reasons.push('含事实数据') }

    if (GOOD_SOURCES.has(source)) { score += 15; reasons.push('可信来源') }
    else if (WEAK_SOURCES.has(source)) { score -= 20; reasons.push('来源存疑') }
    else if (source === '') { score -= 10; reasons.push('无来源') }

    if (item?.url || item?.link) { score += 5; reasons.push('有原文链接') }
    if (item?.is_official) { score += 5; reasons.push('官方发布') }

    score = Math.max(0, Math.min(100, Math.trunc(score)))
    return { quality: score, quality_reason: reasons.length ? reasons.join('；') : '默认' }
  } catch {
    return { quality: 0, quality_reason: '评分异常' }
  }
}

/** 从 market_news 取低质量新闻（quality 缺失或低于阈值）。 */
export async function getLowQuality(db: LedgerDb, limit = 50): Promise<Record<string, unknown>[]> {
  try {
    return await db.query(
      `SELECT * FROM market_news
       WHERE quality IS NULL OR quality = '' OR CAST(quality AS INTEGER) < ?
       ORDER BY id DESC LIMIT ?`,
      [LOW_QUALITY_THRESHOLD, limit],
    )
  } catch { return [] }
}
