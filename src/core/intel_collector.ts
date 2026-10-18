// ─────────────────────────────────────────────
// intel_collector.ts · 从 market_news 自动提取六类情报
//
//
// 口径（必须严格遵守）：
//   宁可漏报不谎报：
//     - 关键词不够强 → 不归类、不入库
//     - 影响方向正负计数，冲突取中性
//     - 状态统一 disclosed（RSS 新闻 ≠ 政策落地）
//     - title + event_date 去重
//   六类：policy / geo / military / conference / macro / company
//   ⚠️ 这是规则级初筛，质量不如 AI 判断 → 分析页保留手动补录入口
//
// 数据流：market_news → 关键词匹配 → intel_events
// ─────────────────────────────────────────────

import type { LedgerDb } from './budget.ts'
import { listMarketNews } from './rss_news.ts'

// ─── 类型 ────────────────────────────────────────────────────────

export type IntelCategory = 'policy' | 'geo' | 'military' | 'conference' | 'macro' | 'company'
export type IntelDirection = 'positive' | 'negative' | 'neutral'

export interface IntelEventRow {
  event_date: string       // 'YYYY-MM-DD'
  category: IntelCategory
  title: string
  detail?: string
  status: 'disclosed'      // 永远是 disclosed；落地状态由人工/AI 后续标注
  impact_boards?: string   // 受影响板块（逗号分隔）
  impact_dir: IntelDirection
  source?: string
  cross_verified: 0 | 1
  created_by: 'auto_rule' | 'manual'
  created_at: string
}

export interface IntelCollectResult {
  scanned: number            // 扫描的 market_news 条数
  matched: number            // 关键词命中数
  inserted: number           // 实际入库数（去重后）
  by_category: Record<IntelCategory, number>
  note: string
}

// ─── 关键词字典（六类） ─────────────────────────────────────────

interface CategoryPattern {
  positive: RegExp[]
  negative: RegExp[]
  /** 影响板块（仅做初筛标注，AI 重新判断更准） */
  boards?: Record<string, RegExp[]>
}

const KEYWORDS: Record<IntelCategory, CategoryPattern> = {
  // 政策类：中央/部委/监管文件
  policy: {
    positive: [
      /(央行|财政部|发改委|证监会|银保监|国务院|工信部|国资委).{0,15}(降准|降息|减税|补贴|扶持|鼓励|支持|放宽|纾困|稳增长|刺激)/,
      /(出台|发布|印发).{0,15}(政策|意见|规划|方案|指引|措施|细则|办法)/,
      /(全面|有序|正式).{0,8}(放开|启动|落地|实施|推行)/,
    ],
    negative: [
      /(央行|财政部|证监会|银保监).{0,15}(收紧|严控|限制|暂停|查处|处罚|罚款)/,
      /(提高|上调).{0,8}(存款准备金率|利率|税率|门槛)/,
      /(整治|清理|严打|叫停).{0,15}(乱象|违规|资金|杠杆|套利)/,
    ],
    boards: {
      '银行': [/银行|存款准备|信贷|社融/],
      '房地产': [/房地产|楼市|限购|限贷|住房/],
      '新能源': [/光伏|风电|储能|新能源车|锂电池/],
      '半导体': [/芯片|半导体|集成电路/],
    },
  },
  // 地缘政治
  geo: {
    positive: [
      /(签署|达成|共识|联合声明|恢复).{0,15}(协议|合作|外交|贸易|通关|通航)/,
      /(重启|恢复).{0,8}(谈判|对话|航班|贸易)/,
    ],
    negative: [
      /(制裁|加征|反制|禁运|限制|封锁).{0,15}(实体|清单|出口|进口|技术)/,
      /(升级|恶化|紧张|冲突|对峙|交火|召回).{0,15}(边境|海域|争端|危机)/,
      /(断交|驱逐|撤回|抗议).{0,8}(大使|外交官|领事)/,
    ],
    boards: {
      '半导体': [/芯片|半导体|集成电路|EDA/],
      '原油': [/石油|原油|油价|OPEC/],
      '黄金': [/黄金|避险|美元|美债/],
    },
  },
  // 军事
  military: {
    positive: [
      /(停火|签署|达成).{0,8}(协议|停战|和平|撤军)/,
    ],
    negative: [
      /(开战|空袭|导弹|袭击|入侵|占领|轰炸|核试)/,
      /(军事演习|军演|部署|增兵|动员|戒严)/,
      /(军舰|军机|航母|核潜艇).{0,10}(穿越|进入|逼近|对峙)/,
    ],
    boards: {
      '原油': [/石油|原油|油价/],
      '黄金': [/黄金|避险/],
      '军工': [/军工|国防|武器|导弹/],
    },
  },
  // 会议/事件
  conference: {
    positive: [
      /(开幕|召开|举办|启动).{0,15}(峰会|论坛|大会|博览会|交易会|推介会)/,
      /(签约|达成|合作).{0,15}(项目|协议|订单)/,
    ],
    negative: [],
    boards: {},
  },
  // 宏观数据
  macro: {
    positive: [
      /(GDP|CPI|PPI|PMI|社融|M2|进出口).{0,15}(超预期|好于预期|回升|改善|加快|提速|提速增长|提速回升)/,
      /(失业率|通胀).{0,8}(下降|走低|回落|缓解)/,
    ],
    negative: [
      /(GDP|CPI|PPI|PMI|社融|M2|进出口).{0,15}(不及预期|低于预期|回落|放缓|下滑|走弱|承压)/,
      /(失业率|通胀).{0,8}(上升|走高|回升|超预期|上行)/,
    ],
    boards: {},
  },
  // 公司事件
  company: {
    positive: [
      /(回购|增持|中标|签约|中标|获批|过会|上市|发布新品|订单饱和)/,
      /(业绩|净利润|营收).{0,8}(超预期|大增|翻倍|创新高|增长)/,
    ],
    negative: [
      /(减持|套现|清仓|质押).{0,8}(股票|股份|股权)/,
      /(业绩|净利润|营收).{0,8}(下滑|亏损|不及预期|暴雷|腰斩|降薪|裁员)/,
      /(停牌|退市|被查|处罚|诉讼|违规|造假|财务造假)/,
    ],
    boards: {},
  },
}

// ─── 工具 ────────────────────────────────────────────────────────

function _nowStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function _eventDateFromPubTime(pubTime: string | undefined): string {
  if (!pubTime) return _nowStr().slice(0, 10)
  return pubTime.slice(0, 10)
}

function _scorePatterns(text: string, patterns: RegExp[]): number {
  let hits = 0
  for (const re of patterns) {
    if (re.test(text)) hits++
  }
  return hits
}

function _detectBoards(text: string, category: IntelCategory): string[] {
  const boards = KEYWORDS[category].boards
  if (!boards) return []
  const found: string[] = []
  for (const [board, patterns] of Object.entries(boards)) {
    for (const re of patterns) {
      if (re.test(text)) {
        found.push(board)
        break
      }
    }
  }
  return found
}

// ─── 单条分类 ────────────────────────────────────────────────────

function classifyNews(title: string, summary: string): {
  category: IntelCategory
  direction: IntelDirection
  boards: string[]
} | null {
  const text = `${title} ${summary}`.trim()
  if (!text) return null

  let bestCategory: IntelCategory | null = null
  let bestScore = 0
  let bestDir: IntelDirection = 'neutral'
  let bestBoards: string[] = []

  for (const [cat, pat] of Object.entries(KEYWORDS) as [IntelCategory, CategoryPattern][]) {
    const pos = _scorePatterns(text, pat.positive)
    const neg = _scorePatterns(text, pat.negative)
    // 关键词不够强 → 不归类（最低命中 1 才纳入）
    const score = pos + neg
    if (score === 0) continue
    // 冲突取中性
    const dir: IntelDirection = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral'
    if (score > bestScore) {
      bestCategory = cat
      bestScore = score
      bestDir = dir
      bestBoards = _detectBoards(text, cat)
    }
  }

  if (!bestCategory || bestScore === 0) return null
  return { category: bestCategory, direction: bestDir, boards: bestBoards }
}

// ─── 抓取入口 ────────────────────────────────────────────────────

export async function collectIntelEvents(
  db: LedgerDb,
  options: { scanLimit?: number; sinceDate?: string } = {},
): Promise<IntelCollectResult> {
  const { scanLimit = 500, sinceDate } = options

  const news = sinceDate
    ? await (await import('./rss_news.ts')).marketNewsSince(db, sinceDate, scanLimit)
    : await listMarketNews(db, scanLimit)

  let matched = 0
  let inserted = 0
  const byCategory: Record<IntelCategory, number> = {
    policy: 0, geo: 0, military: 0, conference: 0, macro: 0, company: 0,
  }
  const createdAt = _nowStr()

  for (const n of news) {
    const cls = classifyNews(n.title, n.summary || '')
    if (!cls) continue
    matched++
    byCategory[cls.category]++

    const eventDate = _eventDateFromPubTime(n.pub_time)
    const title = n.title.slice(0, 200)

    // UNIQUE(title, event_date) → 自动去重
    const ch = await db.run(
      `INSERT OR IGNORE INTO intel_events
       (event_date, category, title, detail, status, impact_boards, impact_dir,
        source, cross_verified, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventDate, cls.category, title, n.summary || null, 'disclosed',
       cls.boards.length ? cls.boards.join(',') : null,
       cls.direction, n.source || null, 0, 'auto_rule', createdAt],
    )
    if (ch.changes) inserted++
  }

  const note = `扫描 ${news.length} 条 → 命中 ${matched} → 入库 ${inserted}（去重后）；` +
    `policy=${byCategory.policy} geo=${byCategory.geo} military=${byCategory.military} ` +
    `conference=${byCategory.conference} macro=${byCategory.macro} company=${byCategory.company}`

  return {
    scanned: news.length,
    matched,
    inserted,
    by_category: byCategory,
    note,
  }
}

/** 手动补录 */
export async function appendManualIntel(
  db: LedgerDb,
  event: {
    event_date: string
    category: IntelCategory
    title: string
    detail?: string
    impact_boards?: string[]
    impact_dir: IntelDirection
    source?: string
    cross_verified?: boolean
  },
): Promise<{ ok: boolean; inserted: boolean; reason?: string }> {
  if (!event.title.trim()) return { ok: false, inserted: false, reason: 'title_empty' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.event_date)) return { ok: false, inserted: false, reason: 'date_invalid' }
  const ch = await db.run(
    `INSERT OR IGNORE INTO intel_events
     (event_date, category, title, detail, status, impact_boards, impact_dir,
      source, cross_verified, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [event.event_date, event.category, event.title, event.detail || null,
     'disclosed', event.impact_boards?.length ? event.impact_boards.join(',') : null,
     event.impact_dir, event.source || null,
     event.cross_verified ? 1 : 0, 'manual', _nowStr()],
  )
  return { ok: true, inserted: !!ch.changes }
}

// ─── 查询 ────────────────────────────────────────────────────────

export async function listIntelEvents(
  db: LedgerDb,
  options: { limit?: number; category?: IntelCategory; sinceDate?: string } = {},
): Promise<IntelEventRow[]> {
  const { limit = 50, category, sinceDate } = options
  const where: string[] = []
  const params: unknown[] = []
  if (category) { where.push('category=?'); params.push(category) }
  if (sinceDate) { where.push('event_date>=?'); params.push(sinceDate) }
  const sql = `SELECT * FROM intel_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY event_date DESC, id DESC LIMIT ?`
  params.push(limit)
  const rows = await db.query<Record<string, unknown>>(sql, params)
  return rows.map(r => ({
    event_date: String(r.event_date ?? ''),
    category: String(r.category ?? '') as IntelCategory,
    title: String(r.title ?? ''),
    detail: r.detail ? String(r.detail) : undefined,
    status: String(r.status ?? 'disclosed') as 'disclosed',
    impact_boards: r.impact_boards ? String(r.impact_boards) : undefined,
    impact_dir: (r.impact_dir as IntelDirection) || 'neutral',
    source: r.source ? String(r.source) : undefined,
    cross_verified: r.cross_verified ? 1 : 0,
    created_by: (String(r.created_by ?? 'auto_rule') === 'manual' ? 'manual' : 'auto_rule') as 'auto_rule' | 'manual',
    created_at: String(r.created_at ?? ''),
  }))
}

/** 自动事件统计摘要（用于分析页头部展示） */
export async function intelSummary(
  db: LedgerDb,
  sinceDays = 7,
): Promise<{
  total: number
  by_category: Record<IntelCategory, number>
  by_direction: Record<IntelDirection, number>
  note: string
}> {
  const since = new Date()
  since.setDate(since.getDate() - sinceDays)
  const sinceStr = since.toISOString().slice(0, 10)
  const rows = await db.query<{ category: string; impact_dir: string }>(
    'SELECT category, impact_dir FROM intel_events WHERE event_date>=?',
    [sinceStr],
  )
  const byCat: Record<IntelCategory, number> = { policy: 0, geo: 0, military: 0, conference: 0, macro: 0, company: 0 }
  const byDir: Record<IntelDirection, number> = { positive: 0, negative: 0, neutral: 0 }
  for (const r of rows) {
    const c = r.category as IntelCategory
    if (c in byCat) byCat[c]++
    const d = r.impact_dir as IntelDirection
    if (d in byDir) byDir[d]++
  }
  return {
    total: rows.length,
    by_category: byCat,
    by_direction: byDir,
    note: `近 ${sinceDays} 天自动提取 ${rows.length} 条情报；放风不代表落地，据此下单需等待细则`,
  }
}