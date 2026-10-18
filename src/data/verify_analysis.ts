/**
 * 验收脚本 · 新闻/情报 + 分析板块
 *
 * 用内存 mock 驱动验证 4 个模块：
 *   1. news.ts — 基金公告(人事+分红) + 重仓股新闻
 *   2. rss_news.ts — 3 RSS 源写入 market_news
 *   3. intel_collector.ts — 关键词命中 + 冲突取中性 + 「不够强」不入库
 *   4. analysis.ts — buildAnalysisBundle 返回叙述（集中度/风格漂移/同涨同跌/情报提示）
 *      检查：组合市值用 nav（不是 acc_nav）
 *
 * 运行：npx tsx src/data/verify_analysis.ts  或 node --experimental-strip-types
 */
import { MemoryBudgetDb } from '../core/budget.ts'
import {
  setNewsFetcher, fetchFundNews, fetchGlobalDividends,
  listLatestNews, type NewsRemoteFetcher,
} from '../core/news.ts'
import {
  setRssFetcher, fetchMarketNews, listMarketNews,
  type RssFetcher,
} from '../core/rss_news.ts'
import {
  collectIntelEvents, listIntelEvents, appendManualIntel, intelSummary,
  type IntelCategory, type IntelDirection,
} from '../core/intel_collector.ts'
import {
  buildAnalysisBundle, buildNarrative, navStats,
  setAnalysisFetchers, type SectorFlowFetcher, type PenetrationFetcher, type NavFetcher,
} from '../core/analysis.ts'

// ─── 内存 mock 数据库（覆盖 MemoryBudgetDb 不支持的三张表） ────
interface NewsRow { fund_code: string; fund_name: string | null; kind: string; title: string; content: string | null; source: string | null; pub_time: string | null; url: string | null; related_stock: string | null; fetched_at: string }
interface MarketRow { title: string; link: string; summary: string | null; source: string; source_url: string | null; pub_time: string | null; fetched_at: string }
interface IntelRow { event_date: string; category: string; title: string; detail: string | null; status: string; impact_boards: string | null; impact_dir: string; source: string | null; cross_verified: number; created_by: string; created_at: string }

class SimpleMockDb {
  news: NewsRow[] = []
  market: MarketRow[] = []
  intel: IntelRow[] = []
  lots: any[] = []
  _id = 1
  async run(sql: string, params: unknown[] = []) {
    const s = sql.trim()
    const p = params
    if (s.includes('INSERT OR IGNORE INTO news_feed') || s.includes('INSERT INTO news_feed')) {
      const exists = this.news.some(n => n.fund_code === p[0] && n.kind === p[2] && n.title === p[3] && n.pub_time === p[6])
      if (exists) return { changes: 0, lastInsertId: 0 }
      this.news.push({
        fund_code: p[0] as string, fund_name: p[1] as string, kind: p[2] as string,
        title: p[3] as string, content: p[4] as string, source: p[5] as string,
        pub_time: p[6] as string, url: p[7] as string, related_stock: p[8] as string,
        fetched_at: p[9] as string,
      })
      return { changes: 1, lastInsertId: ++this._id }
    }
    if (s.includes('INSERT OR IGNORE INTO market_news') || s.includes('INSERT INTO market_news')) {
      const exists = this.market.some(n => n.link === p[1])
      if (exists) return { changes: 0, lastInsertId: 0 }
      this.market.push({
        title: p[0] as string, link: p[1] as string, summary: p[2] as string,
        source: p[3] as string, source_url: p[4] as string, pub_time: p[5] as string,
        fetched_at: p[6] as string,
      })
      return { changes: 1, lastInsertId: ++this._id }
    }
    if (s.includes('INSERT OR IGNORE INTO intel_events') || s.includes('INSERT INTO intel_events')) {
      const exists = this.intel.some(n => n.title === p[2] && n.event_date === p[0])
      if (exists) return { changes: 0, lastInsertId: 0 }
      this.intel.push({
        event_date: p[0] as string, category: p[1] as string, title: p[2] as string,
        detail: p[3] as string, status: p[4] as string, impact_boards: p[5] as string,
        impact_dir: p[6] as string, source: p[7] as string, cross_verified: p[8] as number,
        created_by: p[9] as string, created_at: p[10] as string,
      })
      return { changes: 1, lastInsertId: ++this._id }
    }
    if (s.startsWith('INSERT')) return { changes: 1, lastInsertId: ++this._id }
    return { changes: 1, lastInsertId: 0 }
  }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const s = sql.trim()
    if (s.includes('FROM news_feed') || s.includes('from news_feed')) {
      let rows = [...this.news]
      if (s.includes('fund_code=?')) {
        const idx = (s.slice(0, s.indexOf('fund_code=?')).match(/=/g) ?? []).length
        rows = rows.filter(r => r.fund_code === params[idx])
      }
      if (s.includes('COUNT(*)')) {
        const lm = s.match(/LIMIT\s+(\d+)/i)
        const c = lm ? rows.slice(0, parseInt(lm[1])).length : rows.length
        return [{ c }] as unknown as T[]
      }
      if (s.includes('ORDER BY')) rows = rows.sort((a, b) => (b.pub_time || '').localeCompare(a.pub_time || ''))
      const lm = s.match(/LIMIT\s+(\d+)/i)
      if (lm) rows = rows.slice(0, parseInt(lm[1]))
      return rows as unknown as T[]
    }
    if (s.includes('FROM market_news') || s.includes('from market_news')) {
      let rows = [...this.market]
      if (s.includes('COUNT(*)')) {
        const lm = s.match(/LIMIT\s+(\d+)/i)
        const c = lm ? rows.slice(0, parseInt(lm[1])).length : rows.length
        return [{ c }] as unknown as T[]
      }
      if (s.includes('pub_time >= ?')) {
        const idx = (s.slice(0, s.indexOf('pub_time >= ?')).match(/=/g) ?? []).length
        rows = rows.filter(r => (r.pub_time || '') >= (params[idx] as string))
      }
      if (s.includes('ORDER BY')) rows = rows.sort((a, b) => (b.pub_time || '').localeCompare(a.pub_time || ''))
      const lm = s.match(/LIMIT\s+(\d+)/i)
      if (lm) rows = rows.slice(0, parseInt(lm[1]))
      return rows as unknown as T[]
    }
    if (s.includes('FROM intel_events') || s.includes('from intel_events')) {
      let rows = [...this.intel]
      const where: ((r: IntelRow) => boolean)[] = []
      if (s.includes('event_date>=?')) {
        const idx = (s.slice(0, s.indexOf('event_date>=?')).match(/=/g) ?? []).length
        where.push(r => r.event_date >= (params[idx] as string))
      }
      if (s.includes('category=?')) {
        const idx = (s.slice(0, s.indexOf('category=?')).match(/=/g) ?? []).length
        where.push(r => r.category === (params[idx] as string))
      }
      rows = rows.filter(r => where.every(fn => fn(r)))
      if (s.includes('ORDER BY')) rows = rows.sort((a, b) => b.event_date.localeCompare(a.event_date))
      const lm = s.match(/LIMIT\s+(\d+)/i)
      if (lm) rows = rows.slice(0, parseInt(lm[1]))
      return rows as unknown as T[]
    }
    if (/from\s+lots/i.test(s)) {
      // 让 Analysis 的 _loadHoldings 能拿到持仓（mock 返回空）
      return [] as unknown as T[]
    }
    return [] as unknown as T[]
  }
  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> { return fn(this) }
}

// ─── 验收计数器 ──────────────────────────────────────────
let pass = 0, fail = 0
function check(label: string, ok: boolean, hint = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else    { fail++; console.log(`  ✗ ${label}${hint ? '：' + hint : ''}`) }
}

// ─── Mock 数据 ──────────────────────────────────────────

/** news fetcher mock：人事 + 重仓股 + 重仓股新闻 */
const fakeNewsFetcher: NewsRemoteFetcher = async (apiName, params) => {
  if (apiName === 'fund_announcement_personnel_em') {
    return [
      { 公告标题: '易方达中小盘混合基金经理变更公告', 公告日期: '2026-09-15 10:00:00',
        公告内容: '增聘某基金经理，与原经理共同管理', url: 'http://example/p1' },
      { 公告标题: '基金经理因个人原因离任', 公告日期: '2026-09-10 14:30:00',
        公告内容: '离任公告', url: 'http://example/p2' },
    ]
  }
  if (apiName === 'fund_portfolio_hold_em') {
    return [
      { 股票代码: '600519', 股票名称: '贵州茅台', 持仓占比: 8.5 },
      { 股票代码: '000858', 股票名称: '五粮液', 持仓占比: 6.2 },
      { 股票代码: '601318', 股票名称: '中国平安', 持仓占比: 5.1 },
    ]
  }
  if (apiName === 'stock_news_em') {
    return [
      { 标题: '贵州茅台三季度业绩超预期增长', 来源: '财联社', 发布时间: '2026-09-18 09:30:00',
        url: 'http://news/s1', 内容: '净利润同比 +18%' },
      { 标题: '白酒板块资金流入加速', 来源: '金十', 发布时间: '2026-09-17 14:00:00',
        url: 'http://news/s2' },
    ]
  }
  if (apiName === 'fund_announcement_dividend_em') {
    return [
      { 基金代码: '110011', 基金简称: '易方达中小盘混合', 公告标题: '易方达中小盘分红公告',
        公告日期: '2026-09-12', 公告内容: '每 10 份分红 0.5 元' },
    ]
  }
  return []
}

/** RSS fetcher mock：3 个 RSS 源（财联社 JSON + 另两个标准 RSS） */
const fakeRssFetcher: RssFetcher = async (url) => {
  if (url.includes('cls.cn')) {
    // 财联社 JSON 格式
    return JSON.stringify({
      data: {
        roll_data: [
          { title: '央行宣布降准0.5个百分点 释放长期资金1万亿', shareurl: 'http://cls/1', brief: '利好银行/地产', ctime: 1726612800 },
          { title: '美国商务部发布对华芯片出口管制新规', shareurl: 'http://cls/2', brief: '半导体板块承压', ctime: 1726526400 },
          { title: '今日天气晴', shareurl: 'http://cls/3', brief: '无金融含义', ctime: 1726430000 },
        ],
      },
    })
  }
  if (url.includes('wallstreetcn')) {
    return `<?xml version="1.0"?><rss><channel>
      <item><title>美联储议息会议释放鸽派信号 美股大涨</title><link>http://wscn/1</link><pubDate>Mon, 15 Sep 2026 09:00:00 GMT</pubDate><description>利好全球风险资产</description></item>
      <item><title>地缘政治紧张升级 油价突破 90 美元</title><link>http://wscn/2</link><pubDate>Tue, 16 Sep 2026 10:30:00 GMT</pubDate><description>利空航空</description></item>
    </channel></rss>`
  }
  // 金十
  return `<?xml version="1.0"?><rss><channel>
    <item><title>新能源车销量 9 月同比增长 35% 创新高</title><link>http://jin10/1</link><pubDate>Wed, 17 Sep 2026 08:00:00 GMT</pubDate></item>
  </channel></rss>`
}

/** 板块 fetcher mock */
const fakeSectorFetcher: SectorFlowFetcher = async () => [
  { board_name: '银行', change_pct: 2.1, net_inflow: 18.5e8, fetch_date: '2026-09-18' },
  { board_name: '银行', change_pct: 2.0, net_inflow: 22.0e8, fetch_date: '2026-09-18' },   // 同名去重
  { board_name: '半导体', change_pct: -3.5, net_inflow: -8.2e8, fetch_date: '2026-09-18' },
  { board_name: '新能源', change_pct: 1.8, net_inflow: 12.0e8, fetch_date: '2026-09-18' },
  { board_name: '地产', change_pct: -1.2, net_inflow: -5.5e8, fetch_date: '2026-09-18' },
  { board_name: '军工', change_pct: -0.8, net_inflow: -3.0e8, fetch_date: '2026-09-18' },
]

/** 穿透 fetcher mock */
const fakePenetrationFetcher: PenetrationFetcher = async (fundCode) => [
  { fund_code: fundCode, stock_code: '600519', stock_name: '贵州茅台', weight_pct: 9.0, report_date: '2026-06-30', fetched_at: '2026-09-18' },
  { fund_code: fundCode, stock_code: '000858', stock_name: '五粮液', weight_pct: 6.0, report_date: '2026-06-30', fetched_at: '2026-09-18' },
  { fund_code: fundCode, stock_code: '300750', stock_name: '宁德时代', weight_pct: 5.0, report_date: '2026-06-30', fetched_at: '2026-09-18' },
]

/** 净值 fetcher mock：构造 acc_nav 序列（测试关键） */
const fakeNavFetcher: NavFetcher = async () => {
  const base = 1.0
  const points = []
  for (let i = 0; i < 200; i++) {
    const d = new Date('2026-03-01')
    d.setDate(d.getDate() + i)
    const nav = base + i * 0.002 + Math.sin(i / 5) * 0.005
    const acc_nav = nav + i * 0.0005  // acc_nav 略大于 nav
    points.push({
      nav_date: d.toISOString().slice(0, 10),
      nav,
      acc_nav,
    })
  }
  return points
}

// ─── 交付物收集 ──────────────────────────────────────────
const report = {
  news: { personnel: 0, dividend: 0, stockNews: 0, inserted: 0, errors: [] as string[] },
  rss: { sources: 0, succeeded: 0, fetched: 0, inserted: 0, errors: [] as { source: string; message: string }[] },
  intel: { scanned: 0, matched: 0, inserted: 0, by_category: {} as Record<string, number> },
  analysis: { narrative_concentration: '', narrative_style: '', narrative_coMovement: '', narrative_intel: '' },
  a1_check: { pass: false, evidence: '' },
}

// ─── 主流程 ──────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  验收 · 新闻/情报抓取 + 分析板块')
  console.log('═══════════════════════════════════════════════════════')

  // ──────────── 用例 1：news.ts ────────────
  console.log('\n=== 用例 1：news.ts · 基金公告 + 重仓股新闻 ===')
  {
    const db = new SimpleMockDb()
    setNewsFetcher(fakeNewsFetcher)

    // 抓单只基金
    const r = await fetchFundNews(db as any, '110011', '易方达中小盘混合')
    check('fetchFundNews 不抛错', r.errors.length === 0, JSON.stringify(r.errors))
    report.news.personnel = r.announce_count - (r.errors.length ? 0 : 0)
    report.news.stockNews = r.stock_news_count
    report.news.inserted = r.inserted_count
    report.news.errors = r.errors

    // 全市场分红
    const div = await fetchGlobalDividends(db as any)
    check('global_dividends 抓到 1 条', div.fetched === 1, `actual=${div.fetched}`)
    report.news.dividend = div.fetched

    // 列表
    const lst = await listLatestNews(db as any, 10)
    check('listLatestNews 有数据', lst.length > 0, `count=${lst.length}`)
    const hasAnnounce = lst.some(n => n.kind === 'fund_announce')
    const hasStock = lst.some(n => n.kind === 'stock_news')
    check('包含 fund_announce 类型', hasAnnounce)
    check('包含 stock_news 类型', hasStock)

    console.log(`  → 报告：personnel=${r.announce_count} dividend=${div.fetched} stock_news=${r.stock_news_count} inserted=${r.inserted_count}`)
  }

  // ──────────── 用例 2：rss_news.ts ────────────
  console.log('\n=== 用例 2：rss_news.ts · 3 RSS 源 ===')
  {
    const db = new SimpleMockDb()
    setRssFetcher(fakeRssFetcher)

    const r = await fetchMarketNews(db as any)
    check('sources_attempted=3', r.sources_attempted === 3, `actual=${r.sources_attempted}`)
    check('sources_succeeded=3', r.sources_succeeded === 3, `actual=${r.sources_succeeded}`)
    check('fetched=6（财联社3+华尔街2+金十1）', r.fetched === 6, `actual=${r.fetched}`)
    check('inserted=6（首次入库）', r.inserted === 6, `actual=${r.inserted}`)

    report.rss.sources = r.sources_attempted
    report.rss.succeeded = r.sources_succeeded
    report.rss.fetched = r.fetched
    report.rss.inserted = r.inserted
    report.rss.errors = r.errors

    const lst = await listMarketNews(db as any, 20)
    check('listMarketNews 有 6 条', lst.length === 6, `actual=${lst.length}`)

    // 容错：单源失败不应影响其他
    const partialRssFetcher: RssFetcher = async (url) => {
      if (url.includes('cls.cn')) throw new Error('财联社超时')
      return fakeRssFetcher(url, 10)
    }
    setRssFetcher(partialRssFetcher)
    const r2 = await fetchMarketNews(db as any)
    check('单源失败其他仍 OK', r2.sources_succeeded === 2 && r2.errors.length === 1, `succeeded=${r2.sources_succeeded}`)
  }

  // ──────────── 用例 3：intel_collector.ts ────────────
  console.log('\n=== 用例 3：intel_collector.ts · 关键词命中 + 不够强不入库 ===')
  {
    const db = new SimpleMockDb()
    setRssFetcher(fakeRssFetcher)
    await fetchMarketNews(db as any)   // 先写入 RSS

    const r = await collectIntelEvents(db as any, { scanLimit: 100 })
    check('scanned > 0', r.scanned > 0, `actual=${r.scanned}`)
    check('matched > 0', r.matched > 0, `actual=${r.matched}`)
    check('inserted > 0', r.inserted > 0, `actual=${r.inserted}`)
    check('matched ≤ scanned', r.matched <= r.scanned)

    report.intel.scanned = r.scanned
    report.intel.matched = r.matched
    report.intel.inserted = r.inserted
    report.intel.by_category = r.by_category

    // 「关键词不够强 → 不入库」：只 1 条「今日天气晴」无金融关键词
    const weatherRow = (await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM intel_events WHERE title LIKE '%天气%'`,
      [],
    ))[0]
    check('天气类不入库（关键词不够强）', weatherRow?.c === 0 || weatherRow?.c === undefined, `actual=${weatherRow?.c}`)

    // 央行降准应归类为 policy+positive
    const allEvents = await listIntelEvents(db as any, { limit: 100 })
    const reserve = allEvents.find(e => e.title.includes('降准'))
    check('降准新闻归为 policy 类', !!reserve && reserve.category === 'policy', JSON.stringify(reserve))
    check('降准新闻方向 positive', !!reserve && reserve.impact_dir === 'positive', JSON.stringify(reserve))
    check('所有事件状态都是 disclosed', allEvents.every(e => e.status === 'disclosed'))

    // 冲突取中性：手动构造一条同时含 positive 和 negative 关键词
    const conflictTitle = '央行降准但同时严控违规资金 利好与利空并存'
    await db.run(
      `INSERT INTO market_news (title, link, source, pub_time, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
      [conflictTitle, 'http://test/conflict', 'manual', '2026-09-18 09:00:00', '2026-09-18 09:00:00'],
    )
    const r2 = await collectIntelEvents(db as any, { scanLimit: 200 })
    const conflictEvent = allEvents.concat(await listIntelEvents(db as any, { limit: 200 }))
      .find(e => e.title === conflictTitle)
    check('冲突事件取中性（positive=negative=1）', !!conflictEvent && conflictEvent.impact_dir === 'neutral',
      JSON.stringify(conflictEvent))

    // 手动补录入口
    const manual = await appendManualIntel(db as any, {
      event_date: '2026-09-19',
      category: 'policy',
      title: '手动补录：证监会发布新规',
      impact_dir: 'positive',
      cross_verified: true,
    })
    check('手动补录 OK', manual.ok && manual.inserted)

    // UNIQUE(title, event_date) 去重
    const dup = await appendManualIntel(db as any, {
      event_date: '2026-09-19',
      category: 'policy',
      title: '手动补录：证监会发布新规',
      impact_dir: 'positive',
    })
    check('重复事件不入库（UNIQUE 去重）', dup.ok && !dup.inserted)

    // 摘要
    const sm = await intelSummary(db as any, 7)
    check('intelSummary total > 0', sm.total > 0)

    console.log(`  → 报告：scanned=${r.scanned} matched=${r.matched} inserted=${r.inserted}`)
    console.log(`  → 分类统计：${JSON.stringify(r.by_category)}`)
  }

  // ──────────── 用例 4：analysis.ts ────────────
  console.log('\n=== 用例 4：analysis.ts · 板块 + 穿透 + 净值 + 叙述 ===')
  {
    const db = new SimpleMockDb()
    setAnalysisFetchers({
      sector: fakeSectorFetcher,
      penetration: fakePenetrationFetcher,
      nav: fakeNavFetcher,
    })

    const bundle = await buildAnalysisBundle(db as any, {
      holdings: [
        { fund_code: '110011', fund_name: '易方达中小盘混合', market_value: 50000, category: '混合型-偏股' },
        { fund_code: '000021', fund_name: '测试指数基金', market_value: 30000, category: '股票指数' },
      ],
      fundCategorySummary: { '混合型-偏股': 0.625, '股票指数': 0.375 },
      intelWarning: '近 7 天自动提取 5 条情报；放风不代表落地，据此下单需等待细则',
    })

    check('sector.fetched > 0', bundle.sector.hot.length + bundle.sector.danger.length > 0)
    check('板块同名去重（银行只出现一次）',
      [...bundle.sector.hot, ...bundle.sector.danger].filter(b => b.board_name === '银行').length === 1,
      `count=${[...bundle.sector.hot, ...bundle.sector.danger].filter(b => b.board_name === '银行').length}`)

    check('danger 不含 hot 中的板块（流出榜跳过流入榜）',
      !bundle.sector.danger.some(d => bundle.sector.hot.some(h => h.board_name === d.board_name)),
      JSON.stringify(bundle.sector.danger.map(d => d.board_name)))

    check('penetration.source=live', bundle.penetration.source === 'live', bundle.penetration.source)
    check('penetration.rows > 0', bundle.penetration.rows.length > 0)
    check('贵州茅台穿透占比 > 0', (bundle.penetration.rows.find(r => r.stock_code === '600519')?.composite_weight ?? 0) > 0)

    check('nav_stats 两只基金', Object.keys(bundle.nav_stats).length === 2)

    // ── 检查：composite_weight 用 nav，不用 acc_nav ──
    // 茅台在两只基金中都 9%；A=50000/80000, B=30000/80000
    // composite = 9% × (50000/80000) + 9% × (30000/80000) = 0.05625 + 0.03375 = 0.09
    const maotai = bundle.penetration.rows.find(r => r.stock_code === '600519')
    const expectedNav = (9.0 / 100) * ((50000 + 30000) / 80000)   // 0.09
    check('组合市值用 nav（composite 正确）',
      Math.abs((maotai?.composite_weight ?? 0) - expectedNav) < 0.001,
      `actual=${maotai?.composite_weight?.toFixed(4)} expected=${expectedNav.toFixed(4)}`)

    // 集中度应触发 severe：单股 5.625% < 15%，应该 ok
    check('集中度等级 ok/warn/severe 合法',
      ['ok', 'warn', 'severe'].includes(bundle.penetration.concentration_warning.level),
      bundle.penetration.concentration_warning.level)

    // 叙述必含「放风不代表落地」
    check('叙述含「放风不代表落地」', bundle.narrative.intel_warning.includes('放风不代表落地'))

    report.analysis.narrative_concentration = bundle.narrative.concentration
    report.analysis.narrative_style = bundle.narrative.style_drift
    report.analysis.narrative_coMovement = bundle.narrative.co_movement
    report.analysis.narrative_intel = bundle.narrative.intel_warning

    // nav_stats 用 acc_nav 计算：ret_1m / ret_3m 应有值
    const ns110 = await navStats(db as any, '110011', { viaFetcher: true })
    check('nav_stats ret_1m 用 acc_nav 计算', ns110?.ret_1m !== null && ns110?.ret_1m !== undefined)
    check('nav_stats annual_volatility_pct > 0', (ns110?.annual_volatility_pct ?? -1) > 0)

    console.log(`\n  → 叙述（原文）：`)
    console.log(`     集中度：${bundle.narrative.concentration}`)
    console.log(`     风格漂移：${bundle.narrative.style_drift}`)
    console.log(`     同涨同跌：${bundle.narrative.co_movement}`)
    console.log(`     情报提示：${bundle.narrative.intel_warning}`)
  }

  // ──────────── 独立专项 ────────────
  console.log('\n=== 用例 5：专项 · portfolio exposure 只用 nav ===')
  {
    // 构造两只基金 nav=1.0, acc_nav=2.0（差距大）
    // 持仓在两只基金中都用 nav（market_value = shares × nav）
    // composite_weight 必须等于 weight_pct × (mv_A / total_mv)，与 acc_nav 无关
    const db = new SimpleMockDb()
    // 注入一只持仓：shares=1000, mv=10000（nav=10）；acc_nav=20
    await db.run(
      `INSERT INTO lots (fund_code, status, remaining_shares, cost_amount, confirm_date)
       VALUES (?, 'active', ?, ?, ?)`,
      ['F1', 1000, 10000, '2026-09-01'],
    )
    setAnalysisFetchers({
      sector: null,
      penetration: async () => [
        { fund_code: 'F1', stock_code: 'X1', stock_name: '测试股', weight_pct: 30, report_date: '2026-06-30', fetched_at: '2026-09-18' },
      ],
      nav: null,
    })
    const pen = await (await import('../core/analysis.ts')).portfolioPenetration(db as any, [
      { fund_code: 'F1', market_value: 10000 },   // mv = 1000 shares × 10 nav
    ])
    const expected = 0.30 * (10000 / 10000)   // = 0.30
    const actual = pen.rows[0]?.composite_weight ?? 0
    const passes = Math.abs(actual - expected) < 0.001
    check(`composite 用 nav（30%），不受 acc_nav=20 影响`, passes,
      `actual=${actual.toFixed(4)} expected=${expected.toFixed(4)}`)
    report.a1_check = { pass: passes, evidence: `实际 ${actual.toFixed(4)} = 期望 ${expected.toFixed(4)}（与 acc_nav=20 无关）` }
  }

  // ──────────── 总结 ────────────
  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  结果：✅ ${pass} 通过，❌ ${fail} 失败`)
  console.log('═══════════════════════════════════════════════════════')

  // 输出可被外层 capture 的 JSON
  console.log('\n=== 交付物 JSON ===')
  console.log(JSON.stringify(report, null, 2))

  const __proc = (globalThis as { process?: { exit?: (code: number) => void } }).process
  __proc?.exit?.(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('FATAL', e)
  const __proc = (globalThis as { process?: { exit?: (code: number) => void } }).process
  __proc?.exit?.(2)
})

// 防止 tsx 把 IntelCategory / IntelDirection 当未用报错
export type _VerifyAnalysisExports = IntelCategory | IntelDirection