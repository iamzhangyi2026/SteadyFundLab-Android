// ─────────────────────────────────────────────
// rss_news.ts · 广义财经 RSS 抓取
//
//
// 写入表 market_news（intel_collector 依赖此表）
//
// 设计原则：
//   - 容错：单个 feed 失败不影响其余
//   - 去重：UNIQUE(link) + INSERT OR IGNORE
//   - 抓不到就空，不编
// ─────────────────────────────────────────────

import type { LedgerDb } from './budget.ts'

// ─── 类型 ────────────────────────────────────────────────────────

export interface MarketNewsRow {
  title: string
  link: string
  summary?: string
  source: string
  source_url?: string
  pub_time?: string        // 'YYYY-MM-DD HH:MM:SS'
  fetched_at: string
}

export interface RssFetchResult {
  /** 抓取的 RSS 源数 */
  sources_attempted: number
  /** 成功的源数 */
  sources_succeeded: number
  /** 抓取的条目数（未去重） */
  fetched: number
  /** 实际写入的条数（去重后） */
  inserted: number
  errors: { source: string; message: string }[]
  note: string
}

// ─── 远程 fetcher ────────────────────────────────────────────────

/** 拉 RSS XML，返回 raw 字符串（每个源一个） */
export type RssFetcher = (url: string, timeoutSec: number) => Promise<string>

let _rssFetcher: RssFetcher | null = null

export function setRssFetcher(fetcher: RssFetcher | null): void {
  _rssFetcher = fetcher
}

// ─── RSS 源 ─────────────────────────────

interface RssSource {
  name: string
  url: string
}

export const RSS_SOURCES: RssSource[] = [
  // 东方财富（JSON 接口）。⚠️ `req_trace` 是必填参数，
  // 缺了会返回 `Required String parameter 'req_trace' is not present`。
  {
    name: '东方财富',
    url: 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=347&order=1&needInteractData=0&page_index=1&page_size=30&types=1,20&req_trace=1&fields=code,showTime,title,mediaName,summary,url,uniqueUrl',
  },
  // 只保留真能出数据的源：不可用的源宁可不挂（挂上只会产生永远返回 0 条的失败请求）。
]

const FETCH_TIMEOUT = 30.0

// ─── 抓取入口 ────────────────────────────────────────────────────

export async function fetchMarketNews(
  db: LedgerDb,
  options: { sources?: RssSource[]; limitPerSource?: number } = {},
): Promise<RssFetchResult> {
  const sources = options.sources || RSS_SOURCES
  const limit = options.limitPerSource || 50
  const fetchedAt = _nowStr()
  const errors: { source: string; message: string }[] = []
  let succeeded = 0
  let fetched = 0

  for (const src of sources) {
    if (!_rssFetcher) {
      errors.push({ source: src.name, message: 'rss_fetcher_not_injected' })
      continue
    }
    try {
      const xml = await _rssFetcher(src.url, FETCH_TIMEOUT)
      const items = _parseFeed(xml, src.name, limit)
      // 诊断：**必须看到响应内容**——"HTTP 200 但解析 0 条"时，
      // 不打这一行就只能瞎猜（源格式变了？被墙页？空数组？）
      console.log(`[rss] ${src.name}: 响应 ${String(xml).length} 字符, 解析 ${items.length} 条, 头部=${JSON.stringify(String(xml).slice(0, 150))}`)
      succeeded++
      fetched += items.length
      for (const it of items) {
        await db.run(
          `INSERT OR IGNORE INTO market_news
           (title, link, summary, source, source_url, pub_time, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [it.title, it.link, it.summary || null, it.source,
           src.url, it.pub_time || null, fetchedAt],
        )
      }
    } catch (e) {
      errors.push({ source: src.name, message: (e as Error)?.message || String(e) })
    }
  }

  // 统计 inserted（fetched_at 当批次的实际新增）
  const insertedRows = await db.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM market_news WHERE fetched_at=?',
    [fetchedAt],
  )
  const inserted = (insertedRows[0]?.c as number) ?? 0

  const note =
    errors.length === 0
      ? `RSS 抓取完成：${succeeded}/${sources.length} 源，${fetched} 条入库 ${inserted}`
      : `RSS 部分失败：${succeeded}/${sources.length} 源成功；错误 ${errors.length} 项`

  return {
    sources_attempted: sources.length,
    sources_succeeded: succeeded,
    fetched,
    inserted,
    errors,
    note,
  }
}

// ─── 查询 ────────────────────────────────────────────────────────

export async function listMarketNews(db: LedgerDb, limit = 100): Promise<MarketNewsRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM market_news ORDER BY pub_time DESC, id DESC LIMIT ?',
    [limit],
  )
  return rows.map(_rowToMarketNews)
}

export async function marketNewsSince(db: LedgerDb, sinceDate: string, limit = 500): Promise<MarketNewsRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM market_news WHERE pub_time >= ? ORDER BY pub_time DESC LIMIT ?',
    [sinceDate, limit],
  )
  return rows.map(_rowToMarketNews)
}

// ─── 内部：XML 解析（极简 RSS/Atom 容错） ────────────────────────

function _parseFeed(xml: string, sourceName: string, limit: number): Omit<MarketNewsRow, 'fetched_at'>[] {
  const items: Omit<MarketNewsRow, 'fetched_at'>[] = []
  // 容错：财联社返回的是 JSON-like 而非 RSS；先尝试 JSON
  if (xml.trimStart().startsWith('{') || xml.trimStart().startsWith('[')) {
    try {
      const j = JSON.parse(xml)
      // 兼容多种接口形状：财联社(roll_data/telegraph)、东财(list/items)、裸数组
      const d = j?.data
      const list = Array.isArray(j) ? j
        : (d?.roll_data || d?.telegraph || d?.list || d?.items || (Array.isArray(d) ? d : []))
      for (const e of list) {
        const title = String(e.title || e.brief || e.text || '').trim()
        const link = String(e.shareurl || e.url || e.link || e.uniqueUrl || '').trim()
        if (!title || !link) continue
        items.push({
          title,
          link,
          summary: e.content || e.brief || e.summary || undefined,
          source: sourceName,
          pub_time: _normTime(e.ctime || e.publish_time || e.time || e.showTime || e.pub_time),
        })
      }
      return items.slice(0, limit)
    } catch {
      // 不是 JSON，回落 RSS 解析
    }
  }

  // RSS / Atom：用 <item> 或 <entry> 切片
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>|<entry[\s>]([\s\S]*?)<\/entry>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1] || m[2]
    const title = _extractTag(block, 'title')
    const link = _extractTag(block, 'link') || _extractHref(block, 'link')
    const desc = _extractTag(block, 'description') || _extractTag(block, 'summary') || _extractTag(block, 'content')
    const pub = _extractTag(block, 'pubDate') || _extractTag(block, 'published') || _extractTag(block, 'updated')
    if (!title || !link) continue
    items.push({
      title,
      link,
      summary: _stripHtml(desc).slice(0, 500),
      source: sourceName,
      pub_time: _normTime(pub),
    })
    if (items.length >= limit) break
  }
  return items
}

function _extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = block.match(re)
  return m ? _stripHtml(m[1]).trim() : ''
}

function _extractHref(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*href=["']([^"']+)["']`, 'i')
  const m = block.match(re)
  return m ? m[1].trim() : ''
}

function _stripHtml(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim()
}

function _normTime(v: unknown): string | undefined {
  if (!v) return undefined
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.length === 10 ? `${s} 00:00:00` : s
  const t = Date.parse(s)
  if (Number.isNaN(t)) return undefined
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function _nowStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function _rowToMarketNews(r: Record<string, unknown>): MarketNewsRow {
  return {
    title: String(r.title ?? ''),
    link: String(r.link ?? ''),
    summary: r.summary ? String(r.summary) : undefined,
    source: String(r.source ?? ''),
    source_url: r.source_url ? String(r.source_url) : undefined,
    pub_time: r.pub_time ? String(r.pub_time) : undefined,
    fetched_at: String(r.fetched_at ?? ''),
  }
}