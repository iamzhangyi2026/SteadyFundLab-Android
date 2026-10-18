// ─────────────────────────────────────────────
// analysis.ts · 分析板块（板块信号 + 持仓穿透 + 净值统计 + 叙述）
//
//
// 口径约束（必须严格执行）：
//   portfolio_exposure 用 COALESCE(acc_nav, nav) → 改为只用 nav
//   （nav_stats 用 acc_nav 算收益/回撤/波动，保持不变）
//   板块：只给资金流方向与幅度，【不判断便宜/昂贵】
//        同一板块多条 → 保留金额最大的一条
//        热门(流入前N) + 危险(流出前N)，流出榜跳过已进流入榜的
//   穿透：单基金缓存 24h；组合按持仓市值加权合并
//   统计：用 acc_nav 算 ret_1m/3m/6m/1y、最大回撤、年化波动(252)
//   叙述：集中度警告 / 风格漂移 / 同涨同跌
//        情报统计要写「放风不代表落地，据此下单需等待细则」
//   禁止：抓不到就编 / 关键词弱也入库 / 市值用 acc_nav / 下买卖结论
// ─────────────────────────────────────────────

import type { LedgerDb } from './budget.ts'
import { WINDOW_DAYS } from './screen_rules'

// ─── 板块资金流 ─────

export interface SectorFlowRow {
  board_name: string
  change_pct: number        // 涨跌幅（%）
  /** 主力净流入（元，正=流入 / 负=流出）。
   *  注：主源（新浪行业板块）**不提供资金流**，此时该字段为 0，
   *  排序与展示自动退化为 change_pct（见 _buildSectorReport / 板块信号卡）。 */
  net_inflow: number
  /** 成交额（元）—— 新浪源提供，作为板块活跃度参考；东财源无此字段 */
  amount?: number
  change_pct_rank?: number
  net_inflow_rank?: number
  fetch_date: string
}

export interface SectorSignalReport {
  fetch_date: string
  /** 流入榜前 N（默认 5） */
  hot: SectorFlowRow[]
  /** 流出榜前 N（已剔除已在 hot 中的板块） */
  danger: SectorFlowRow[]
  /** 数据缺失提示 */
  source: 'live' | 'stale' | 'empty'
  note: string
}

// ─── 持仓穿透 ───────────────────────────────────────────────────

export interface FundPortfolioRow {
  fund_code: string
  stock_code: string
  stock_name: string
  /** 持仓占比 %（来自 fund_portfolio_hold_em 「持仓占比」/「占净值比例」） */
  weight_pct: number
  /** 报告期 */
  report_date?: string
  fetched_at: string
}

export interface PenetrationRow {
  stock_code: string
  stock_name: string
  /** 组合总市值加权后的累计占比 */
  composite_weight: number
  /** 贡献的基金清单 */
  contributors: { fund_code: string; weight_pct: number }[]
}

export interface PenetrationReport {
  /** 全组合穿透明细（按权重降序） */
  rows: PenetrationRow[]
  /** 集中度风险（任一股票占比 > 15% 警告，> 25% 严重） */
  concentration_warning: { level: 'ok' | 'warn' | 'severe'; max_weight: number; detail: string }
  /** 穿透覆盖率（按持仓市值加权） */
  coverage_pct: number
  note: string
  source: 'live' | 'stale' | 'partial' | 'empty'
}

// ─── 净值统计 ──────────────────────

export interface NavPoint {
  nav_date: string           // 'YYYY-MM-DD'
  nav: number                // 单位净值
  acc_nav: number           // 累计净值
}

export interface NavStatsReport {
  fund_code: string
  ret_1m: number | null       // 月度收益 %
  ret_3m: number | null       // 季度收益 %
  ret_6m: number | null       // 半年收益 %
  ret_1y: number | null       // 年度收益 %
  max_drawdown_pct: number | null     // 最大回撤 %
  annual_volatility_pct: number | null // 年化波动 %
  samples: number             // 样本数
  note: string
}

// ─── 叙述 ───────────────────────────────────────────────────────

export interface PortfolioNarrative {
  /** 集中度警告 */
  concentration: string
  /** 风格漂移（持仓主题偏离基金分类） */
  style_drift: string
  /** 同涨同跌（多只持仓高相关性） */
  co_movement: string
  /** 情报提示（必须包含「放风不代表落地」措辞） */
  intel_warning: string
}

// ─── HTTP fetcher 注入 ─────────────────────────────────────────

export type SectorFlowFetcher = () => Promise<SectorFlowRow[]>
export type PenetrationFetcher = (fundCode: string) => Promise<FundPortfolioRow[]>
export type NavFetcher = (fundCode: string) => Promise<NavPoint[]>

let _sectorFetcher: SectorFlowFetcher | null = null
let _penetrationFetcher: PenetrationFetcher | null = null
let _navFetcher: NavFetcher | null = null

export function setAnalysisFetchers(f: {
  sector?: SectorFlowFetcher | null
  penetration?: PenetrationFetcher | null
  nav?: NavFetcher | null
}): void {
  if (f.sector !== undefined) _sectorFetcher = f.sector
  if (f.penetration !== undefined) _penetrationFetcher = f.penetration
  if (f.nav !== undefined) _navFetcher = f.nav
}

// ─── 工具 ────────────────────────────────────────────────────────

function _nowStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function _dateOnly(s: string): string { return s.slice(0, 10) }

function _addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return _dateOnly(d.toISOString())
}

// ─── 1. 板块信号 ─────────────────────────────────────────────────

export async function sectorSignals(
  db: LedgerDb,
  options: { topN?: number; maxAgeMin?: number } = {},
): Promise<SectorSignalReport> {
  const { topN = 5, maxAgeMin = 60 } = options

  // 60 分钟内缓存（落库在 sector_signals_cache 表 or 在内存）
  if (_sectorCache && (Date.now() - _sectorCache.fetched_at_ms) < maxAgeMin * 60_000) {
    return _buildSectorReport(_sectorCache.rows, topN, 'stale', '使用缓存（< 60min）')
  }

  if (!_sectorFetcher) {
    return { fetch_date: _dateOnly(_nowStr()), hot: [], danger: [], source: 'empty', note: '板块 fetcher 未注入，无法获取' }
  }

  let rows: SectorFlowRow[] = []
  try {
    rows = await _sectorFetcher()
  } catch {
    return { fetch_date: _dateOnly(_nowStr()), hot: [], danger: [], source: 'empty', note: '板块行情暂时取不到（稍后自动重试）' }
  }

  _sectorCache = { rows, fetched_at_ms: Date.now() }
  return _buildSectorReport(rows, topN, 'live', `实时抓取 ${rows.length} 条`)
}

let _sectorCache: { rows: SectorFlowRow[]; fetched_at_ms: number } | null = null

function _buildSectorReport(
  rows: SectorFlowRow[],
  topN: number,
  source: 'live' | 'stale' | 'empty',
  note: string,
): SectorSignalReport {
  // 同一板块多条 → 保留金额最大的一条
  // 源无资金流（net_inflow 全 0）时退化为按成交额比大小
  const magnitude = (r: SectorFlowRow) => (r.net_inflow !== 0 ? Math.abs(r.net_inflow) : (r.amount ?? 0))
  const dedup = new Map<string, SectorFlowRow>()
  for (const r of rows) {
    const prev = dedup.get(r.board_name)
    if (!prev || magnitude(r) > magnitude(prev)) {
      dedup.set(r.board_name, r)
    }
  }
  const all = Array.from(dedup.values())

  // 有资金流 → 按资金流排序；无资金流（新浪源）→ 按涨跌幅排序
  const hasFlow = all.some(r => r.net_inflow !== 0)
  const sortKey = (r: SectorFlowRow) => (hasFlow ? r.net_inflow : r.change_pct)

  // 流入榜
  const hot = [...all].sort((a, b) => sortKey(b) - sortKey(a)).slice(0, topN)
  const hotSet = new Set(hot.map(h => h.board_name))

  // 流出榜：跳过已在 hot 的板块
  const danger = all
    .filter(r => !hotSet.has(r.board_name))
    .sort((a, b) => sortKey(a) - sortKey(b))
    .slice(0, topN)

  return {
    fetch_date: _dateOnly(_nowStr()),
    hot,
    danger,
    source,
    note,
  }
}

// ─── 2. 持仓穿透 ─────────────────────────────────────────────────

const PENETRATION_CACHE_TTL = 24 * 3600 * 1000   // 24h
let _penetrationCache = new Map<string, { rows: FundPortfolioRow[]; fetched_at_ms: number }>()

export async function portfolioPenetration(
  db: LedgerDb,
  holdings: { fund_code: string; market_value: number }[],
  options: { topN?: number } = {},
): Promise<PenetrationReport> {
  const { topN = 30 } = options

  if (!holdings.length) {
    return {
      rows: [],
      concentration_warning: { level: 'ok', max_weight: 0, detail: '当前无持仓' },
      coverage_pct: 0,
      note: '当前组合无持仓，无穿透数据',
      source: 'empty',
    }
  }

  // 计算组合总市值
  const totalMv = holdings.reduce((s, h) => s + h.market_value, 0)
  if (totalMv <= 0) {
    return {
      rows: [],
      concentration_warning: { level: 'ok', max_weight: 0, detail: '持仓市值为 0' },
      coverage_pct: 0,
      note: '组合市值 0，无法穿透',
      source: 'empty',
    }
  }

  // 按基金抓穿透（24h 缓存）
  const agg = new Map<string, PenetrationRow>()
  let liveSources = 0
  let staleSources = 0
  let totalCoverageMv = 0  // 有穿透数据的市值

  for (const h of holdings) {
    let rows: FundPortfolioRow[] | null = null
    const cached = _penetrationCache.get(h.fund_code)
    if (cached && (Date.now() - cached.fetched_at_ms) < PENETRATION_CACHE_TTL) {
      rows = cached.rows
      staleSources++
    } else if (_penetrationFetcher) {
      try {
        rows = await _penetrationFetcher(h.fund_code)
        _penetrationCache.set(h.fund_code, { rows, fetched_at_ms: Date.now() })
        liveSources++
      } catch {
        rows = null
      }
    }
    if (!rows || rows.length === 0) continue
    totalCoverageMv += h.market_value

    // 组合市值只用 nav 算
    // 每只持仓股的「组合占比」= fund_weight × (fund_mv / total_mv)
    const fundShare = h.market_value / totalMv
    for (const r of rows) {
      const weightInFund = r.weight_pct / 100          // 60% → 0.6
      const composite = weightInFund * fundShare       // 0.6 × 0.3 = 0.18
      if (!agg.has(r.stock_code)) {
        agg.set(r.stock_code, {
          stock_code: r.stock_code,
          stock_name: r.stock_name,
          composite_weight: 0,
          contributors: [],
        })
      }
      const cur = agg.get(r.stock_code)!
      cur.composite_weight += composite
      cur.contributors.push({ fund_code: r.fund_code, weight_pct: r.weight_pct })
    }
  }

  const rows = Array.from(agg.values()).sort((a, b) => b.composite_weight - a.composite_weight).slice(0, topN)
  const maxW = rows[0]?.composite_weight ?? 0

  // 集中度风险等级
  let level: 'ok' | 'warn' | 'severe' = 'ok'
  let detail = '持仓分散'
  if (maxW >= 0.25) {
    level = 'severe'
    detail = `${rows[0]?.stock_name} 单只占比 ${(maxW * 100).toFixed(1)}%，高度集中`
  } else if (maxW >= 0.15) {
    level = 'warn'
    detail = `${rows[0]?.stock_name} 单只占比 ${(maxW * 100).toFixed(1)}%，注意分散`
  }

  // 覆盖率
  const coverage = totalMv > 0 ? totalCoverageMv / totalMv : 0

  let source: PenetrationReport['source'] = 'empty'
  if (liveSources > 0 && staleSources === 0) source = 'live'
  else if (liveSources > 0 && staleSources > 0) source = 'partial'
  else if (staleSources > 0) source = 'stale'

  const note = source === 'empty'
    ? '暂时拿不到持仓明细（稍后自动重试）'
    : `穿透 ${holdings.length} 只基金（实时 ${liveSources} / 缓存 ${staleSources}），覆盖组合 ${(coverage * 100).toFixed(0)}%`

  return {
    rows,
    concentration_warning: { level, max_weight: maxW, detail },
    coverage_pct: coverage,
    note,
    source,
  }
}

// ─── 3. 净值统计（用 acc_nav 算收益 / 回撤 / 波动） ──────

export async function navStats(
  db: LedgerDb,
  fundCode: string,
  options: { viaFetcher?: boolean } = {},
): Promise<NavStatsReport> {
  // 优先用 fetcher 实时拉；否则从 DB 读 nav_daily
  let points: NavPoint[] = []

  if (options.viaFetcher && _navFetcher) {
    try {
      points = await _navFetcher(fundCode)
    } catch {
      points = []
    }
  }

  if (points.length === 0) {
    const rows = await db.query<{ nav_date: string; nav: number; acc_nav: number | null }>(
      'SELECT nav_date, nav, acc_nav FROM nav_daily WHERE fund_code=? ORDER BY nav_date ASC',
      [fundCode],
    )
    points = rows
      .filter(r => r.acc_nav != null)
      .map(r => ({ nav_date: r.nav_date, nav: r.nav, acc_nav: r.acc_nav as number }))
  }

  if (points.length < 30) {
    return {
      fund_code: fundCode,
      ret_1m: null, ret_3m: null, ret_6m: null, ret_1y: null,
      max_drawdown_pct: null, annual_volatility_pct: null,
      samples: points.length,
      note: points.length === 0 ? '还没有净值数据' : `样本还不够（已 ${points.length} 天，至少需 30 天）`,
    }
  }

  // 口径：用 acc_nav
  const last = points[points.length - 1].acc_nav
  const lastDate = points[points.length - 1].nav_date

  // 口径：评估窗口 = 最近 WINDOW_DAYS(250) 个交易日，与 screen_rules 一致。
  // ret_1y / 最大回撤 / 年化波动 必须在同一窗口内计算，否则与筛选结论（估值洼地逻辑）矛盾。
  const win = points.length > WINDOW_DAYS ? points.slice(points.length - WINDOW_DAYS) : points

  function _findAccNear(daysAgo: number): number | null {
    const target = _addDays(lastDate, -daysAgo)
    // 找 ≤ target 的最近一个
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].nav_date <= target) return points[i].acc_nav
    }
    return null
  }

  const m1 = _findAccNear(30)
  const m3 = _findAccNear(90)
  const m6 = _findAccNear(180)
  // ret_1y 用 250 交易日窗口首值（与 screen_rules 一致），不再用 365 自然日倒推
  const m12 = win.length > 1 ? win[0].acc_nav : null

  const ret = (base: number | null) => base == null ? null : ((last / base) - 1) * 100

  // 最大回撤（用 acc_nav，限 250 交易日窗口，与 screen_rules 一致）
  let peak = win[0].acc_nav
  let maxDd = 0
  for (const p of win) {
    if (p.acc_nav > peak) peak = p.acc_nav
    const dd = (peak - p.acc_nav) / peak
    if (dd > maxDd) maxDd = dd
  }
  const maxDdPct = maxDd * 100

  // 年化波动（用 acc_nav 日收益率 std * sqrt(250)，与 screen_rules 一致）
  const retsArr: number[] = []
  for (let i = 1; i < win.length; i++) {
    retsArr.push((win[i].acc_nav - win[i - 1].acc_nav) / win[i - 1].acc_nav)
  }
  const mean = retsArr.reduce((s, r) => s + r, 0) / retsArr.length
  const variance = retsArr.reduce((s, r) => s + (r - mean) ** 2, 0) / retsArr.length
  const std = Math.sqrt(variance)
  const annualVol = std * Math.sqrt(250) * 100

  return {
    fund_code: fundCode,
    ret_1m: ret(m1),
    ret_3m: ret(m3),
    ret_6m: ret(m6),
    ret_1y: ret(m12),
    max_drawdown_pct: maxDdPct,
    annual_volatility_pct: annualVol,
    samples: points.length,
    note: `样本 ${points.length} 天（评估窗口 ${win.length} 交易日）；ret_1y/回撤/波动按 250 交易日口径，与筛选逻辑一致`,
  }
}

// ─── 4. 组合叙述 ─────────────────────────────────────────────────

export interface PortfolioNarrativeInput {
  penetration: PenetrationReport
  holdings: { fund_code: string; market_value: number; category?: string; fund_name?: string }[]
  fundCategorySummary?: Record<string, number>  // {category: 占比}
  navStatsByFund?: Record<string, NavStatsReport>
  intelWarning?: string
}

export function buildNarrative(input: PortfolioNarrativeInput): PortfolioNarrative {
  const { penetration, holdings, fundCategorySummary, navStatsByFund, intelWarning } = input

  // 集中度（来自 penetration.concentration_warning）
  const concentration = penetration.concentration_warning.level === 'severe'
    ? `⚠️ 集中度告警：${penetration.concentration_warning.detail}`
    : penetration.concentration_warning.level === 'warn'
      ? `⚠️ 集中度提示：${penetration.concentration_warning.detail}`
      : '组合分散度良好，单只股票占比未触及警戒线'

  // 风格漂移：用 fund 分类 vs 重仓股行业对比（简化版：只给一句话）
  const categories = fundCategorySummary
    ? Object.entries(fundCategorySummary).sort((a, b) => b[1] - a[1]).slice(0, 3)
    : []
  let styleDrift = ''
  if (categories.length === 0 || penetration.rows.length === 0) {
    styleDrift = '持仓样本不足，暂不评估风格漂移'
  } else {
    const topStock = penetration.rows[0]
    const topCat = categories[0]
    styleDrift = `组合以「${topCat[0]}」基金为主（${(topCat[1] * 100).toFixed(0)}%），但重仓股「${topStock.stock_name}」未必属于该类型 — 若持仓风格与基金分类长期偏离，需关注风格漂移`
  }

  // 同涨同跌：用 navStatsByFund 多只基金的月度收益相近度
  let coMovement = '样本不足，暂不评估相关性'
  if (navStatsByFund && Object.keys(navStatsByFund).length >= 2) {
    const rets = Object.values(navStatsByFund).map(s => s.ret_1m).filter((r): r is number => r != null)
    if (rets.length >= 2) {
      const max = Math.max(...rets)
      const min = Math.min(...rets)
      const spread = max - min
      if (spread < 3) {
        coMovement = `多只基金月收益差距仅 ${spread.toFixed(1)}%，存在同涨同跌现象 — 表面分散，实则同押`
      } else {
        coMovement = `基金月收益分化正常（最大差 ${spread.toFixed(1)}%）`
      }
    }
  }

  // 情报提示（必须包含「放风不代表落地」措辞）
  const intel = intelWarning || '放风不代表落地，据此下单需等待细则'

  return {
    concentration,
    style_drift: styleDrift,
    co_movement: coMovement,
    intel_warning: intel,
  }
}

// ─── 6. 新闻情报（共享表直读：持仓基金新闻 + 自动情报事件）────────────
// 新闻 / 情报表（news_feed / intel_events）是全局共享的，按 fund_code / event_date 去重落库，
// 真实持仓 / 沙盒交易 / 关注共用同一份缓存。本函数只读缓存、不发起网络请求 ——
// 把已抓到的共享资料提供给分析：进组合叙述（情报提示）与「持仓体检」页面展示。

export interface NewsItem {
  fund_code: string
  fund_name: string | null
  kind: string          // 'fund_announce' | 'stock_news'
  title: string
  pub_time: string | null
  source: string | null
}

export interface IntelEventItem {
  event_date: string
  category: string
  title: string
  impact_boards: string | null
  impact_dir: string | null
}

export interface NewsSignalReport {
  /** 持仓基金近 N 天公告 / 重仓股新闻（每只基金最多 perFundLimit 条，按时间倒序） */
  by_fund: Record<string, NewsItem[]>
  /** 近 N 天自动提取的情报事件（放风态，RSS 新闻≠政策落地） */
  intel_events: IntelEventItem[]
  count: number
  source: 'live' | 'empty'
  note: string
}

const NEWS_DAYS_DEFAULT = 7
const NEWS_PER_FUND_LIMIT = 5
const NEWS_INTEL_LIMIT = 5

export async function newsSignals(
  db: LedgerDb,
  fundCodes: string[],
  options: { days?: number } = {},
): Promise<NewsSignalReport> {
  const days = options.days ?? NEWS_DAYS_DEFAULT
  const codes = Array.from(new Set(fundCodes.map(c => String(c || '').trim()).filter(Boolean)))
  const cutoff = _addDays(_dateOnly(_nowStr()), -days)

  const report: NewsSignalReport = {
    by_fund: {},
    intel_events: [],
    count: 0,
    source: 'empty',
    note: '',
  }

  // 1. 持仓基金新闻（news_feed 按 fund_code 取，窗口内、每只截前 N 条）
  if (codes.length > 0) {
    try {
      const placeholders = codes.map(() => '?').join(',')
      const rows = await db.query<NewsItem>(
        'SELECT fund_code, fund_name, kind, title, pub_time, source FROM news_feed '
        + `WHERE fund_code IN (${placeholders}) AND (pub_time >= ? OR pub_time IS NULL) `
        + 'ORDER BY pub_time DESC, id DESC LIMIT ?',
        [...codes, cutoff, codes.length * NEWS_PER_FUND_LIMIT],
      )
      const seen = new Map<string, number>()
      for (const r of rows) {
        const n = seen.get(r.fund_code) ?? 0
        if (n >= NEWS_PER_FUND_LIMIT) continue
        seen.set(r.fund_code, n + 1)
        if (!report.by_fund[r.fund_code]) report.by_fund[r.fund_code] = []
        report.by_fund[r.fund_code].push(r)
        report.count++
      }
    } catch {
      // news_feed 可能未建 —— 不连累分析
    }
  }

  // 2. 自动情报事件（intel_events 放风态，窗口内取前 N 条）
  try {
    const events = await db.query<IntelEventItem>(
      'SELECT event_date, category, title, impact_boards, impact_dir FROM intel_events '
      + 'WHERE event_date >= ? ORDER BY event_date DESC, id DESC LIMIT ?',
      [cutoff, NEWS_INTEL_LIMIT],
    )
    report.intel_events = events
    report.count += events.length
  } catch {
    // intel_events 可能未建 —— 不连累分析
  }

  report.source = report.count > 0 ? 'live' : 'empty'
  report.note = report.count > 0
    ? `近 ${days} 天：${Object.keys(report.by_fund).length} 只持仓基金有新闻、${report.intel_events.length} 条情报事件`
    : `近 ${days} 天暂无新闻与情报`
  return report
}

// ─── 5. 一站式汇总（给 Analysis.jsx 用） ─────────────────────────

export interface AnalysisBundle {
  fetch_at: string
  sector: SectorSignalReport
  penetration: PenetrationReport
  nav_stats: Record<string, NavStatsReport>
  narrative: PortfolioNarrative
  /** 共享新闻情报（持仓基金新闻 + 自动情报事件，只读缓存） */
  news: NewsSignalReport
  note: string
}

export async function buildAnalysisBundle(
  db: LedgerDb,
  options: {
    holdings: { fund_code: string; fund_name?: string; market_value: number; category?: string }[]
    fundCategorySummary?: Record<string, number>
    intelWarning?: string
  },
): Promise<AnalysisBundle> {
  // 1. 板块
  const sector = await sectorSignals(db)

  // 2. 持仓穿透
  const penetration = await portfolioPenetration(
    db,
    options.holdings.map(h => ({ fund_code: h.fund_code, market_value: h.market_value })),
  )

  // 3. 单基金净值统计
  const navStatsByFund: Record<string, NavStatsReport> = {}
  for (const h of options.holdings) {
    navStatsByFund[h.fund_code] = await navStats(db, h.fund_code)
  }

  // 4. 叙述（intelWarning 未显式给定时，用新闻情报兜底 —— 保证「放风不代表落地」措辞不丢）
  const news = await newsSignals(db, options.holdings.map(h => h.fund_code))
  const intelFallback = news.intel_events.length > 0
    ? `近期情报 ${news.intel_events.length} 条（如「${news.intel_events[0].title}」）；放风不代表落地，据此下单需等待细则`
    : undefined
  const narrative = buildNarrative({
    penetration,
    holdings: options.holdings,
    fundCategorySummary: options.fundCategorySummary,
    navStatsByFund,
    intelWarning: options.intelWarning || intelFallback,
  })

  return {
    fetch_at: _nowStr(),
    sector,
    penetration,
    nav_stats: navStatsByFund,
    narrative,
    news,
    note: `板块信号(${sector.source}) + 持仓穿透(${penetration.source} / 覆盖 ${(penetration.coverage_pct * 100).toFixed(0)}%) + ${Object.keys(navStatsByFund).length} 只基金净值统计 + 新闻情报(${news.source})`,
  }
}