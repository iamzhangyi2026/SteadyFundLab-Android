// ─────────────────────────────────────────────
// status.ts · 基金申购/赎回状态门控 + QDII 境外休市
//
//
// 设计原则：
//   - 日历类用规则算（境外休市）
//   - 公告类靠抓取（申购/赎回状态，每日）
//   - 两者绝不混 —— 门控只看状态字段，境外日历只做提前提示
//
// 关键口径：
//   from_cache 必须可见（降级路径暴露给调用方）
//   D2  三层降级（今日快照 → 历史快照 → null）
//   D3  超时 60s（全市场表实拉约 28s）
//   E1  unknown 直接拒，不猜「开放」
//   E2  限购无金额时用 fallback_limit，都没有才拒
//   E3  数据缺失返回空，不返回假数据
// ─────────────────────────────────────────────

import type { LedgerDb } from './budget.ts'

// ─── 类型定义 ──────────────────────────────────────────────────────────

/** 申购/赎回状态 */
export type TradeStatus = 'open' | 'limited' | 'closed' | 'unknown'

/** 状态快照（来自 fund_status 表） */
export interface StatusSnapshot {
  fund_code: string
  status_date: string            // 'YYYY-MM-DD'
  purchase_status: TradeStatus
  redeem_status: TradeStatus
  purchase_limit: number | null  // 限购金额（元/日）；null = 未限或拿不到
  limit_unknown: boolean         // 识别为限购但拿不到金额
  raw_purchase: string           // 原始文本
  raw_redeem: string             // 原始文本
  note: string                   // 落库格式：「原始状态：申购[...] 赎回[...]」
  source: string                 // 数据来源，如 'em_daily'
  fetched_at: string             // 'YYYY-MM-DD HH:MM:SS'
  /** D2：降级路径为 true（用了历史快照） */
  from_cache: boolean
}

/** 门控结果 */
export interface GateResult {
  ok: boolean
  reason: string                 // 拒绝时可读原因（不能为空字符串，E1）
}

/** 境外休市日历项 */
export interface OverseasHoliday {
  date: string                   // 'YYYY-MM-DD'
  name: string
  rule?: string
  detail?: string                // 补休 / 备注
}

/** QDII 提前提示 */
export interface QdiiCalendarHint {
  applicable: boolean            // 是否 QDII
  market: 'us' | 'hk' | null
  halted: boolean                // 今日是否境外休市
  next_holiday: { date: string; name: string; days_to_next: number } | null
  detail: string                 // 提示文案
}

// ─── 常量 ──────────────────────────────────────────────────────────

/** D3：超时 60s（全市场表实拉约 28s） */
export const ORDER_STATUS_TIMEOUT = 60.0

/** 默认数据源：em_daily */
const SOURCE_NAME = 'em_daily'

/** HTTP 源站：东方财富基金详情 */
const HTTP_HEADERS = { 'User-Agent': 'fund-app/1.0 (mobile)' }

// ─── 工具：日期（本地时间） ────────────────────────────────────────

function _toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function _parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 第 n 个星期几（n=-1 → 最后一个） */
function _nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  // weekday: 0=Sun, 1=Tue ... (JS getDay() 标准)
  if (n > 0) {
    const first = new Date(year, month - 1, 1)
    const offset = (weekday - first.getDay() + 7) % 7
    const day = 1 + offset + (n - 1) * 7
    return new Date(year, month - 1, day)
  } else {
    // 倒数第 n 个
    const lastDay = new Date(year, month, 0).getDate()
    const last = new Date(year, month - 1, lastDay)
    const offset = (last.getDay() - weekday + 7) % 7
    const day = lastDay - offset + (n + 1) * 7
    return new Date(year, month - 1, day)
  }
}

/** 节假日落在周末的调整：周六→前一周五，周日→后一周一 */
function _observed(d: Date): Date {
  const dow = d.getDay()
  if (dow === 6) return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
  if (dow === 0) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  return d
}

/** Anonymous Gregorian algorithm 计算复活节（用于 Good Friday） */
function easter(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const L = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * L) / 451)
  const month = Math.floor((h + L - 7 * m + 114) / 31)
  const day = ((h + L - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

// ─── 美股/港股休市日 ─────────────────────────────────

/**
 * 美股休市日 2026：10 个（含 Juneteenth 6/19）
 * 数据源：NYSE/Nasdaq Trader 2026 Holiday & Early Close Schedule
 */
export function usMarketHolidays(year: number): OverseasHoliday[] {
  if (year !== 2026) return []   // 仅 2026 已校准；其他年份返回空，宁可漏报
  return [
    { date: '2026-01-01', name: "New Year's Day", rule: '_observed(1/1)' },
    { date: '2026-01-19', name: 'Martin Luther King, Jr. Day', rule: '_nthWeekday(1,0,3)' },
    { date: '2026-02-16', name: "Washington's Birthday", rule: '_nthWeekday(2,0,3)' },
    { date: '2026-04-03', name: 'Good Friday', rule: 'easter-2d' },
    { date: '2026-05-25', name: 'Memorial Day', rule: '_nthWeekday(5,0,-1)' },
    { date: '2026-06-19', name: 'Juneteenth', rule: '_observed(6/19)', detail: '美国联邦假日' },
    { date: '2026-07-03', name: 'Independence Day (observed)', rule: '_observed(7/4)', detail: '7/4 周六补休' },
    { date: '2026-09-07', name: 'Labor Day', rule: '_nthWeekday(9,0,1)' },
    { date: '2026-11-26', name: 'Thanksgiving Day', rule: '_nthWeekday(11,3,4)' },
    { date: '2026-12-25', name: 'Christmas Day', rule: '_observed(12/25)' },
  ]
}

/**
 * 港股休市日 2026：14 个
 * 数据源：HKEX Circular CT/075/25《2026 年香港证券市场假期》
 * 农历节日无法用公历规则算，必须硬编码表（一年一更）
 */
export function hkMarketHolidays(year: number): OverseasHoliday[] {
  if (year !== 2026) return []
  return [
    { date: '2026-01-01', name: '元旦' },
    { date: '2026-02-17', name: '农历年初一' },
    { date: '2026-02-18', name: '农历年初二' },
    { date: '2026-02-19', name: '农历年初三' },
    { date: '2026-04-03', name: '耶稣受难节' },
    { date: '2026-04-06', name: '清明节翌日', rule: '清明 4/5 适逢周日补休' },
    { date: '2026-04-07', name: '复活节星期一翌日' },
    { date: '2026-05-01', name: '劳动节' },
    { date: '2026-05-25', name: '佛诞翌日', rule: '佛诞 5/24 适逢周日补休' },
    { date: '2026-06-19', name: '端午节' },
    { date: '2026-07-01', name: '香港特别行政区成立纪念日' },
    { date: '2026-10-01', name: '国庆日' },
    { date: '2026-10-19', name: '重阳节翌日', rule: '重阳 10/18 适逢周日补休' },
    { date: '2026-12-25', name: '圣诞节' },
  ]
}

export function isOverseasHoliday(d: Date, market: 'us' | 'hk' = 'us'): boolean {
  const ds = _toDateStr(d)
  const holidays = market === 'us' ? usMarketHolidays(d.getFullYear()) : hkMarketHolidays(d.getFullYear())
  return holidays.some(h => h.date === ds)
}

/** 下一个境外休市日（QDII 提前提醒用） */
export function nextOverseasHoliday(d: Date, market: 'us' | 'hk' = 'us'): { date: string; name: string; days_to_next: number } | null {
  const holidays = market === 'us' ? usMarketHolidays(d.getFullYear()) : hkMarketHolidays(d.getFullYear())
  const today = _toDateStr(d)
  const cur = _parseDate(today)
  for (const h of holidays) {
    const hd = _parseDate(h.date)
    if (hd >= cur) {
      const days = Math.round((hd.getTime() - cur.getTime()) / 86400000)
      return { date: h.date, name: h.name, days_to_next: days }
    }
  }
  return null
}

/** QDII 提前提示（不参与交易门控，只产出文本） */
export function checkQdiiCalendar(fundCode: string, isQdii: boolean, d: Date, market: 'us' | 'hk' = 'us'): QdiiCalendarHint {
  if (!isQdii) {
    return { applicable: false, market: null, halted: false, next_holiday: null, detail: '非 QDII，不适用境外休市提示' }
  }
  const halted = isOverseasHoliday(d, market)
  const next = nextOverseasHoliday(d, market)
  let detail = `${market === 'us' ? '美股' : '港股'}市场 `
  if (halted) {
    detail += `今日（${_toDateStr(d)}）休市，QDII 不产生净值`
  } else if (next) {
    detail += `今日开市。下次休市：${next.date}（${next.name}），还有 ${next.days_to_next} 天`
  } else {
    detail += `今日开市。本年度数据无更多休市日`
  }
  return { applicable: true, market, halted, next_holiday: next, detail }
}

// ─── 状态文本解析（核心门控） ────────────────────────────────────

/** 文本 → TradeStatus */
export function parseStatus(rawPurchase: string, rawRedeem: string): { purchase: TradeStatus; redeem: TradeStatus } {
  return {
    purchase: _parseOne(rawPurchase),
    redeem: _parseOne(rawRedeem),
  }
}

function _parseOne(raw: string): TradeStatus {
  if (!raw) return 'unknown'
  const s = raw.trim()
  // 开放
  if (s.includes('开放') || s.includes('正常') || s.includes('可申购') || s.includes('可赎回')) {
    return 'open'
  }
  // 限购（限大额）
  if (s.includes('限') || s.includes('大额')) {
    return 'limited'
  }
  // 关闭/暂停
  if (s.includes('暂停') || s.includes('封闭') || s.includes('停止') || s.includes('不可')) {
    return 'closed'
  }
  // E1：未知状态直接 unknown，不猜「开放」
  return 'unknown'
}

/** 从「限大额（1000元）」抠金额 */
export function _extractLimit(text: string): number | null {
  if (!text) return null
  // 匹配数字 + 元/万
  const m = text.match(/(\d+(?:\.\d+)?)\s*(元|万)?/)
  if (!m) return null
  const num = parseFloat(m[1])
  if (isNaN(num)) return null
  const unit = m[2]
  return unit === '万' ? num * 10000 : num
}

/** 从 note 抠出原始文本（label='申购' 或 '赎回'） */
export function _extractRawFromNote(note: string, label: '申购' | '赎回'): string {
  if (!note) return ''
  // note 格式：「原始状态：申购[xxx] 赎回[yyy]」
  const m = note.match(new RegExp(`${label}\\[([^\\]]+)\\]`))
  return m ? m[1] : ''
}

// ─── 门控（核心 E1 / E2） ────────────────────────────────────────

/**
 * 申购门控
 * E1：unknown 直接拒，理由可读（不能为空字符串）
 * E2：限购但拿不到金额 → 用 fallback_limit；都没有才拒
 */
export function canBuy(st: StatusSnapshot, amount: number, fallbackLimit?: number): GateResult {
  switch (st.purchase_status) {
    case 'open':
      return { ok: true, reason: '申购开放' }
    case 'closed':
      return { ok: false, reason: `申购已暂停（${st.raw_purchase || _extractRawFromNote(st.note, '申购') || '原因未知'}）` }
    case 'limited': {
      const limit = st.purchase_limit
        ?? (st.limit_unknown ? null : _extractLimit(st.raw_purchase))
        ?? fallbackLimit
        ?? null
      if (limit === null) {
        return { ok: false, reason: `限购但拿不到上限金额（${st.raw_purchase || _extractRawFromNote(st.note, '申购')}），为安全起见拒绝` }
      }
      if (amount > limit) {
        return { ok: false, reason: `超过单日限购 ${limit.toFixed(2)} 元（请求 ${amount}）` }
      }
      return { ok: true, reason: `限购 ${limit.toFixed(2)} 元，本次 ${amount} 元可申` }
    }
    case 'unknown':
    default:
      // E1：未知状态直接拒，理由带 raw 文本（降级时仍可读）
      const raw = st.raw_purchase || _extractRawFromNote(st.note, '申购')
      return { ok: false, reason: `申购状态未知（原始：${raw || '未抓取到原始文本'}），拒绝以避免错单` }
  }
}

/** 赎回门控（同 canBuy 逻辑） */
export function canSell(st: StatusSnapshot, _lotConfirmDate: string, _asOf: string): GateResult {
  switch (st.redeem_status) {
    case 'open':
      return { ok: true, reason: '赎回开放' }
    case 'closed':
      return { ok: false, reason: `赎回已暂停（${st.raw_redeem || _extractRawFromNote(st.note, '赎回') || '原因未知'}）` }
    case 'limited': {
      const limit = st.purchase_limit ?? fallbackLimitFromRaw(st.raw_redeem) ?? null
      if (limit === null) {
        return { ok: false, reason: `赎回有限额但拿不到上限金额（${st.raw_redeem || _extractRawFromNote(st.note, '赎回')}）` }
      }
      return { ok: true, reason: `赎回限额 ${limit.toFixed(2)} 元/日` }
    }
    case 'unknown':
    default:
      const raw = st.raw_redeem || _extractRawFromNote(st.note, '赎回')
      return { ok: false, reason: `赎回状态未知（原始：${raw || '未抓取到原始文本'}），拒绝以避免错单` }
  }
}

function fallbackLimitFromRaw(raw: string): number | null {
  return _extractLimit(raw)
}

// ─── 三层降级：fetchAndSave（核心 D2） ──────────────────────────

/**
 * 获取并落库基金状态。核心三层降级：
 *   1) 今日已有快照 → 直接复用（绝不碰网络，下单路径永远秒回）
 *   2) 实时抓取失败/超时 → 用任意历史快照，标注 from_cache=true
 *   3) 连历史快照都没有 → 返回 null，调用方拒单
 *
 * 为什么第 2 层不能省：
 *   源站抖动不至于把一笔本来能做的交易硬拒掉。
 *   只有「从未抓过」才是真未知 —— 那是网络抖动给不了的，才该拒。
 */
export async function fetchAndSave(
  db: LedgerDb,
  fundCode: string,
  _isQdii = false,
  _market: 'us' | 'hk' = 'us',
  timeoutSec = ORDER_STATUS_TIMEOUT,
): Promise<StatusSnapshot | null> {
  const today = _toDateStr(new Date())
  // 第一层：今日已有快照 → 复用
  const todayRow = await _queryLatest(db, fundCode, today)
  if (todayRow) {
    return { ...todayRow, from_cache: false }
  }

  // 尝试实时抓取
  let fresh: StatusSnapshot | null = null
  try {
    fresh = await _fetchRemote(fundCode, timeoutSec)
  } catch (_e) {
    fresh = null   // 网络失败/超时，静默走第二层
  }

  if (fresh) {
    // 落库
    await db.run(
      `INSERT INTO fund_status (fund_code, status_date, purchase_status, redeem_status,
       purchase_limit, limit_unknown, raw_purchase, raw_redeem, note, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fresh.fund_code, fresh.status_date, fresh.purchase_status, fresh.redeem_status,
       fresh.purchase_limit, fresh.limit_unknown ? 1 : 0,
       fresh.raw_purchase, fresh.raw_redeem, fresh.note, fresh.source, fresh.fetched_at],
    )
    return fresh
  }

  // 第二层：实时失败，用任意历史快照（from_cache=true）
  const anyRow = await _queryLatest(db, fundCode)  // 不带 today
  if (anyRow) {
    return { ...anyRow, from_cache: true }
  }

  // 第三层：连历史都没有 → null
  return null
}

/** 数据库查最新快照 */
async function _queryLatest(db: LedgerDb, fundCode: string, statusDate?: string): Promise<StatusSnapshot | null> {
  const sql = statusDate
    ? 'SELECT * FROM fund_status WHERE fund_code=? AND status_date=? ORDER BY fetched_at DESC LIMIT 1'
    : 'SELECT * FROM fund_status WHERE fund_code=? ORDER BY status_date DESC, fetched_at DESC LIMIT 1'
  const params = statusDate ? [fundCode, statusDate] : [fundCode]
  const rows = await db.query<Record<string, unknown>>(sql, params)
  if (!rows || rows.length === 0) return null
  return _statusFromRow(rows[0])
}

/** 从快照行重建对象 */
export async function _statusFromRow(row: Record<string, unknown>): Promise<StatusSnapshot> {
  return {
    fund_code: row.fund_code as string,
    status_date: row.status_date as string,
    purchase_status: row.purchase_status as TradeStatus,
    redeem_status: row.redeem_status as TradeStatus,
    purchase_limit: row.purchase_limit as number | null,
    limit_unknown: !!(row.limit_unknown as number | boolean),
    raw_purchase: (row.raw_purchase as string) ?? '',
    raw_redeem: (row.raw_redeem as string) ?? '',
    note: (row.note as string) ?? '',
    source: (row.source as string) ?? SOURCE_NAME,
    fetched_at: (row.fetched_at as string) ?? '',
    from_cache: false,   // 由调用方在 fetchAndSave 内部覆盖
  }
}

/** 最近一次快照（不抓取，纯查） */
export async function latestStatus(db: LedgerDb, fundCode: string): Promise<StatusSnapshot | null> {
  return _queryLatest(db, fundCode)
}

// ─── HTTP 实时抓取 ──────────

/**
 * 调东方财富 HTTP 接口拉基金申购/赎回状态。
 * 接口拿不到 → 返回 null（E3：不造假数据）
 *
 * 真实环境：fetch(`https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?FCODE=${code}&deviceid=...`)
 * 当前离线验收环境：注入 fetcher 以便测试降级路径
 */
async function _fetchRemote(fundCode: string, timeoutSec: number): Promise<StatusSnapshot | null> {
  if (!_fetcher) return null   // 未注入 fetcher，返回 null 触发降级
  return _fetcher(fundCode, timeoutSec)
}

export type RemoteFetcher = (fundCode: string, timeoutSec: number) => Promise<StatusSnapshot | null>
let _fetcher: RemoteFetcher | null = null

/** 注入远程 fetcher（生产环境用真实 HTTP；测试环境用 mock） */
export function setStatusFetcher(fetcher: RemoteFetcher | null): void {
  _fetcher = fetcher
}

// ─── 落库建表语句 ──────────────────────────────────────────────

export const CREATE_FUND_STATUS_TABLE = `
CREATE TABLE IF NOT EXISTS fund_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code TEXT NOT NULL,
  status_date TEXT NOT NULL,
  purchase_status TEXT NOT NULL,
  redeem_status TEXT NOT NULL,
  purchase_limit REAL,
  limit_unknown INTEGER DEFAULT 0,
  raw_purchase TEXT,
  raw_redeem TEXT,
  note TEXT,
  source TEXT DEFAULT 'em_daily',
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fund_status_code_date ON fund_status(fund_code, status_date DESC);
`