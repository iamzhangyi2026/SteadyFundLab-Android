// ─────────────────────────────────────────────
// news.ts · 基金公告 + 重仓股新闻抓取
//
//
// 底层原则：
//   只有资金是虚拟的；净值、持仓、行业配置、板块资金流、基金状态
//   全部来自真实世界，抓取失败就标「无数据」，绝不编造。
//   本模块只做「取数 + 组装 + 写人话」，不替用户做买卖决定。
//
// 数据源：
//   ① 基金公告：fund_announcement_personnel_em(symbol=code) / fund_announcement_dividend_em()
//      分红全市场表只在循环外抓一次
//   ② 重仓股新闻：fund_portfolio_hold_em(symbol=code) → stock_news_em(symbol=sc)
//
// 设计原则：
//   - 去重：news_feed 唯一键 (fund_code, kind, title, pub_time) → INSERT OR IGNORE
//   - 容错：每个接口单独 try，一个失败不影响其余
//   - 接口拿不到 → 标「无数据」（E3），不入库
// ─────────────────────────────────────────────

import type { LedgerDb } from './budget.ts'

// ─── 类型 ────────────────────────────────────────────────────────

export interface NewsFeedRow {
  fund_code: string
  fund_name?: string
  kind: 'fund_announce' | 'stock_news'
  title: string
  content?: string
  source?: string
  pub_time?: string        // 'YYYY-MM-DD HH:MM:SS'
  url?: string
  related_stock?: string   // 仅 stock_news
  fetched_at: string
}

export interface NewsFetchResult {
  fund_code: string
  /** 抓取的公告条数 */
  announce_count: number
  /** 抓取的股票新闻条数 */
  stock_news_count: number
  /** 实际写入数据库的条数（去重后） */
  inserted_count: number
  /** 错误明细 */
  errors: string[]
  /** 笔记：方便上层展示 */
  note: string
}

// ─── 远程 fetcher（注入式） ──────────────────────────────────────

/** 调对应 HTTP 接口，返回行数组 */
export type NewsRemoteFetcher = (apiName: string, params: Record<string, string | number>) => Promise<unknown[]>

let _newsFetcher: NewsRemoteFetcher | null = null

/** 注入远程 fetcher（生产 = CapacitorHttp；测试 = mock） */
export function setNewsFetcher(fetcher: NewsRemoteFetcher | null): void {
  _newsFetcher = fetcher
}

// ─── 工具 ────────────────────────────────────────────────────────

function _nowStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function _s(v: unknown): string {
  return v == null ? '' : String(v)
}

function _safeDate(v: unknown): string | undefined {
  if (!v) return undefined
  const s = String(v)
  // 已是 'YYYY-MM-DD HH:MM:SS' 或 'YYYY-MM-DD' 直接用；否则尝试 Date.parse
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.length === 10 ? `${s} 00:00:00` : s
  const t = Date.parse(s)
  if (Number.isNaN(t)) return undefined
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ─── 抓取入口 ────────────────────────────────────────────────────

/**
 * 单只基金的「公告 + 重仓股新闻」全量抓取并入库。
 *
 * @param db        LedgerDb 接口
 * @param fundCode  基金代码
 * @param fundName  基金名称（可空，从 funds 表查）
 * @param options   limitPerKind：单类最多抓几条（默认 30）
 */
export async function fetchFundNews(
  db: LedgerDb,
  fundCode: string,
  fundName?: string,
  options: { limitPerKind?: number; skipDividends?: boolean } = {},
): Promise<NewsFetchResult> {
  const { limitPerKind = 30, skipDividends = true } = options
  const errors: string[] = []
  const fetchedAt = _nowStr()
  const finalFundName = fundName || (await _lookupFundName(db, fundCode)) || fundCode

  let announceCount = 0
  let stockNewsCount = 0

  // ① 基金公告（人事 + 分红）
  try {
    const personnel = await _fetchRemote('fund_announcement_personnel_em', { symbol: fundCode }, limitPerKind)
    const dividends = skipDividends
      ? []
      : await _fetchRemote('fund_announcement_dividend_em', { symbol: fundCode }, limitPerKind)
    const announces = [
      ...personnel.map(r => _rowToAnnounce(r, 'personnel')),
      ...dividends.map(r => _rowToAnnounce(r, 'dividend')),
    ]
    announceCount = announces.length
    for (const a of announces) {
      await _insertNews(db, { ...a, fund_code: fundCode, fund_name: finalFundName, kind: 'fund_announce', fetched_at: fetchedAt })
    }
  } catch (e) {
    errors.push(`fund_announce: ${(e as Error)?.message || e}`)
  }

  // ② 重仓股新闻：先查重仓股，再循环抓股票新闻
  try {
    const holdings = await _fetchRemote('fund_portfolio_hold_em', { symbol: fundCode }, 10)
    // 重仓股代码：列名可能是「股票代码」/「stock_code」/「symbol」等，这里容错处理
    const stockCodes = holdings
      .map(h => _s(h['股票代码'] || h['stock_code'] || h['symbol'] || h['code']).trim())
      .filter(c => /^\d{6}$/.test(c))
      .slice(0, 10) // 最多取前 10 只重仓股
    const allStockNews: NewsFeedRow[] = []
    for (const sc of stockCodes) {
      try {
        const rows = await _fetchRemote('stock_news_em', { symbol: sc }, Math.min(10, limitPerKind))
        for (const r of rows) {
          const row = _rowToStockNews(r, sc)
          if (row) allStockNews.push(row)
        }
      } catch (e) {
        // 单只股票失败不影响其他股票
        errors.push(`stock_news ${sc}: ${(e as Error)?.message || e}`)
      }
    }
    stockNewsCount = allStockNews.length
    for (const n of allStockNews) {
      await _insertNews(db, { ...n, fund_code: fundCode, fund_name: finalFundName, fetched_at: fetchedAt })
    }
  } catch (e) {
    errors.push(`portfolio_hold: ${(e as Error)?.message || e}`)
  }

  // 统计 inserted（去重后实际新增）
  const inserted = await db.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM news_feed WHERE fund_code=? AND fetched_at=?',
    [fundCode, fetchedAt],
  )
  const insertedCount = (inserted[0]?.c as number) ?? 0

  const note =
    errors.length === 0
      ? `抓取完成：公告 ${announceCount} 条 / 股票新闻 ${stockNewsCount} 条`
      : `部分失败：公告 ${announceCount} / 股票 ${stockNewsCount}；错误 ${errors.length} 项`

  return {
    fund_code: fundCode,
    announce_count: announceCount,
    stock_news_count: stockNewsCount,
    inserted_count: insertedCount,
    errors,
    note,
  }
}

/** 全市场分红公告（循环外只抓一次） */
let _globalDividendsCache: { rows: NewsFeedRow[]; fetched_at: string } | null = null

export async function fetchGlobalDividends(
  db: LedgerDb,
  options: { limit?: number; maxAgeMin?: number } = {},
): Promise<{ fetched: number; inserted: number; from_cache: boolean; errors: string[] }> {
  const { limit = 200, maxAgeMin = 60 } = options
  const errors: string[] = []

  // 60 分钟内缓存命中
  if (_globalDividendsCache) {
    const age = (Date.now() - Date.parse(_globalDividendsCache.fetched_at.replace(' ', 'T'))) / 60_000
    if (age < maxAgeMin) {
      let inserted = 0
      for (const r of _globalDividendsCache.rows) {
        const ch = await db.run(
          `INSERT OR IGNORE INTO news_feed
           (fund_code, fund_name, kind, title, content, source, pub_time, url, related_stock, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.fund_code, r.fund_name || null, r.kind, r.title, r.content || null,
           r.source || null, r.pub_time || null, r.url || null,
           r.related_stock || null, r.fetched_at],
        )
        if (ch.changes) inserted++
      }
      return { fetched: _globalDividendsCache.rows.length, inserted, from_cache: true, errors: [] }
    }
  }

  // 实时抓
  let rows: Record<string, unknown>[] = []
  try {
    rows = await _fetchRemote('fund_announcement_dividend_em', {}, limit)
  } catch (e) {
    errors.push(`global_dividends: ${(e as Error)?.message || e}`)
    return { fetched: 0, inserted: 0, from_cache: false, errors }
  }

  const fetchedAt = _nowStr()
  const feedRows: NewsFeedRow[] = []
  for (const r of rows) {
    const code = _s(r['基金代码'] || r['symbol'] || r['fund_code']).trim()
    if (!/^\d{6}$/.test(code)) continue
    feedRows.push({
      fund_code: code,
      fund_name: _s(r['基金简称'] || r['fund_name']).trim() || undefined,
      kind: 'fund_announce',
      title: _s(r['公告标题'] || r['title'] || r['分红方案']).trim(),
      content: _s(r['公告内容'] || r['content']) || undefined,
      source: 'em_dividends',
      pub_time: _safeDate(r['公告日期'] || r['pub_time']),
      url: _s(r['url'] || r['公告链接']) || undefined,
      related_stock: undefined,
      fetched_at: fetchedAt,
    })
  }
  _globalDividendsCache = { rows: feedRows, fetched_at: fetchedAt }

  let inserted = 0
  for (const r of feedRows) {
    const ch = await db.run(
      `INSERT OR IGNORE INTO news_feed
       (fund_code, fund_name, kind, title, content, source, pub_time, url, related_stock, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.fund_code, r.fund_name || null, r.kind, r.title, r.content || null,
       r.source || null, r.pub_time || null, r.url || null,
       r.related_stock || null, r.fetched_at],
    )
    if (ch.changes) inserted++
  }
  return { fetched: feedRows.length, inserted, from_cache: false, errors }
}

// ─── 查询 ────────────────────────────────────────────────────────

/** 单只基金的新闻流（按时间倒序） */
export async function listFundNews(
  db: LedgerDb,
  fundCode: string,
  limit = 50,
): Promise<NewsFeedRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM news_feed WHERE fund_code=? ORDER BY pub_time DESC, id DESC LIMIT ?',
    [fundCode, limit],
  )
  return rows.map(_rowToFeed)
}

/** 全市场新闻流（最新 N 条） */
export async function listLatestNews(db: LedgerDb, limit = 100): Promise<NewsFeedRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM news_feed ORDER BY pub_time DESC, id DESC LIMIT ?',
    [limit],
  )
  return rows.map(_rowToFeed)
}

// ─── 内部 helper ─────────────────────────────────────────────────

async function _fetchRemote(apiName: string, params: Record<string, string | number>, _limit?: number): Promise<Record<string, unknown>[]> {
  if (!_newsFetcher) throw new Error(`news_fetcher_not_injected:${apiName}`)
  return _newsFetcher(apiName, params) as unknown as Record<string, unknown>[]
}

async function _lookupFundName(db: LedgerDb, code: string): Promise<string | null> {
  const rows = await db.query<{ fund_name: string }>(
    'SELECT fund_name FROM funds WHERE fund_code=? LIMIT 1',
    [code],
  )
  return rows[0]?.fund_name ?? null
}

function _rowToAnnounce(r: Record<string, unknown>, subKind: 'personnel' | 'dividend'): Omit<NewsFeedRow, 'fetched_at' | 'fund_code' | 'fund_name' | 'kind'> {
  return {
    title: _s(r['公告标题'] || r['title'] || r['公告内容']).trim(),
    content: _s(r['公告内容'] || r['content']) || undefined,
    source: subKind === 'personnel' ? 'em_personnel' : 'em_dividends',
    pub_time: _safeDate(r['公告日期'] || r['pub_time'] || r['date']),
    url: _s(r['url'] || r['公告链接']) || undefined,
  }
}

function _rowToStockNews(r: Record<string, unknown>, stockCode: string): NewsFeedRow | null {
  const title = _s(r['标题'] || r['title'] || r['新闻标题']).trim()
  if (!title) return null
  return {
    fund_code: '',  // 由外层补
    kind: 'stock_news',
    title,
    content: _s(r['内容'] || r['content']) || undefined,
    source: _s(r['来源'] || r['source']) || undefined,
    pub_time: _safeDate(r['发布时间'] || r['pub_time'] || r['date']),
    url: _s(r['url'] || r['新闻链接']) || undefined,
    related_stock: stockCode,
    fetched_at: '',  // 由外层补
  }
}

async function _insertNews(db: LedgerDb, row: NewsFeedRow): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO news_feed
     (fund_code, fund_name, kind, title, content, source, pub_time, url, related_stock, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.fund_code, row.fund_name || null, row.kind, row.title, row.content || null,
     row.source || null, row.pub_time || null, row.url || null,
     row.related_stock || null, row.fetched_at],
  )
}

function _rowToFeed(r: Record<string, unknown>): NewsFeedRow {
  return {
    fund_code: _s(r.fund_code),
    fund_name: r.fund_name ? _s(r.fund_name) : undefined,
    kind: r.kind === 'stock_news' ? 'stock_news' : 'fund_announce',
    title: _s(r.title),
    content: r.content ? _s(r.content) : undefined,
    source: r.source ? _s(r.source) : undefined,
    pub_time: r.pub_time ? _s(r.pub_time) : undefined,
    url: r.url ? _s(r.url) : undefined,
    related_stock: r.related_stock ? _s(r.related_stock) : undefined,
    fetched_at: _s(r.fetched_at),
  }
}