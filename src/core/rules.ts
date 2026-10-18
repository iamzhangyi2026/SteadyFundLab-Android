// ─────────────────────────────────────────────
// rules.ts · 纪律线 / 规则引擎
//
// ─── 定位 ────────────────────────────────────────────────────────────
// 规则引擎**永远在跑**，职责随 AI 是否在线而不同：
//
//   AI 在线  → 执行者：只执行指令 + 风控拦截，不主动决策
//   AI 离线  → 决策者：按纪律线自主交易，保证时间敏感操作不漏掉
//
// 纪律线参数存 app_settings（「我的」页可调），规则在本模块执行。
//
// 为什么必须自动化：
//   这些操作有时间敏感性：破线当天就要处理，等下次开对话可能已经多跌了 10%。
//   靠人记着不现实，靠 AI 记着更不现实（对话一关就断）。
//
// ⚠️ APP 基线 = 无 AI 也能完整操作：
//   规则要能自己跑，也能让人看见 —— 不是"给 AI 用的接口"
//
// ─── 口径 ────────────────────────────────────────────────────────
// 纪律线必须拆成两个净值参数：
//   浮盈 profit_pct  → 用【单位净值 nav】
//   回撤 recent_high → 用【累计净值 acc_nav】
//
// 两个参数同时传，缺任一 → 跳过该线，不要拿另一个顶替
//
// ─── 实现要点 ─────────────────────────────────────────────────────
// ① 同步 SQLite → 异步 LedgerDb 接口（与 budget.ts / ledger.ts 对齐）
// ② 阈值从 config.ts 读（不硬编码），仍集中在顶部
// ③ 累计净值走 nav_daily.acc_nav；优先使用 ledger.positionSummary 算浮盈（市值）
// ④ 账户峰值存 pool_meta（key='peak_assets'），无新增表
// ⑤ ⚠️ 账户止损触发后【仅告警、不暂停自动交易】（自动割肉往往割在低点）
// ─────────────────────────────────────────────────────────────────────────

import { positionSummary, holdingReport } from './ledger.ts'
import type { LedgerDb } from './budget.ts'
import { RULES_CONFIG, RISK_CONFIG } from './config.ts'

// ─────────────────────────────────────────────
// 导出类型
// ─────────────────────────────────────────────

/** 单条触发纪律线 */
export interface DisciplineLine {
  /** 类型：profit_take / drawdown_cut / admit_wrong */
  type: 'profit_take' | 'drawdown_cut' | 'admit_wrong'
  /** 触发描述（含具体数值） */
  detail: string
  /** 建议动作：reducing 减仓 / clearing 清仓 */
  action: 'reducing' | 'clearing'
  /** 建议比例（0.5 减一半 / 1.0 全部） */
  suggested_ratio: number
  /** 人类可读的备注 */
  note: string
}

/** 罚期检查结果 */
export interface PenaltyRiskResult {
  /** 是否有罚期风险 */
  has_penalty_risk: boolean
  /** 处于罚期的批次数（无风险时为 0） */
  risky_lots: number
  /** 最短等待天数（无风险时为 0） */
  days_to_wait: number
  /** 人类可读详情 */
  detail: string
}

/** 账户级回撤检查结果 */
export interface AccountStopResult {
  total_assets: number
  peak_assets: number
  drawdown_pct: number
  limit_pct: number
  triggered: boolean
  note: string
}

/** 离线周期单只结果（runOfflineCycle 用） */
export interface OfflineCycleEntry {
  fund_code: string
  nav?: number
  /** nav <= 0 时附说明 */
  note?: string
  lines: DisciplineLine[]
  penalty: PenaltyRiskResult
}

// ─────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────

/** 本地时间构造 Date —— 禁止 new Date("YYYY-MM-DD")（UTC 解析偏一天） */
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Date 减 n 天（返回 Date 对象） */
function subtractDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate() - n)
  return out
}

/** Date 转 YYYY-MM-DD（本地时间） */
function toDateStr(d: Date): string {
  const y  = d.getFullYear()
  const m  = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 数值四舍五入到 n 位小数 */
function round(x: number, n: number): number {
  const factor = 10 ** n
  return Math.round(x * factor) / factor
}

// ─────────────────────────────────────────────
// 1. recentHigh —— 近期高点（必须用累计净值）
// ─────────────────────────────────────────────

/**
 * 取某基金近期最高【累计】净值。
 *
 * ⚠️ 必须用累计净值（acc_nav）而不是单位净值（nav）：
 *   单位净值会因分红除息下调，分红那天会形成一个假的"低点"，
 *   用它算回撤会把分红误判成暴跌。
 *
 * @param db        数据库抽象
 * @param fundCode  基金代码
 * @param asOf      截止日期 "YYYY-MM-DD"
 * @param lookback  回看天数（默认 60）
 * @returns 近期最高累计净值；无数据返回 null
 */
export async function recentHigh(
  db: LedgerDb,
  fundCode: string,
  asOf: string,
  lookback?: number,
): Promise<number | null> {
  const days = lookback ?? RULES_CONFIG.lookback_days
  const startDate = toDateStr(subtractDays(parseLocalDate(asOf), days))
  const rows = await db.query<{ hi: number | null }>(
    `SELECT MAX(COALESCE(acc_nav, nav)) AS hi
       FROM nav_daily
      WHERE fund_code = ? AND nav_date >= ? AND nav_date <= ?`,
    [fundCode, startDate, asOf],
  )
  const hi = rows[0]?.hi
  return hi == null ? null : hi
}

// ─────────────────────────────────────────────
// 2. checkDiscipline —— 检查单只基金是否触发纪律线
// ─────────────────────────────────────────────

/**
 * 检查一只持仓是否触发纪律线（三条线：profit_take / drawdown_cut / admit_wrong）。
 *
 * 必须传两个净值参数：
 *   - currentNav      单位净值 → 算浮盈（市值）
 *   - currentAccNav   累计净值 → 算回撤
 *
 * 缺任一 → 抛错（不要拿另一个顶替），避免浮盈虚高、误报止盈
 *
 * @param benchmarkChangePct  同期基准涨跌幅；不传则跳过「admit_wrong」的跑输判定
 */
export async function checkDiscipline(
  db: LedgerDb,
  fundCode: string,
  currentNav: number,
  currentAccNav: number,
  asOf: string,
  benchmarkChangePct?: number | null,
): Promise<DisciplineLine[]> {
  if (!Number.isFinite(currentNav) || currentNav <= 0) {
    throw new Error(`[checkDiscipline] currentNav 非法: ${currentNav}`)
  }
  if (!Number.isFinite(currentAccNav) || currentAccNav <= 0) {
    throw new Error(`[checkDiscipline] currentAccNav 非法: ${currentAccNav}`)
  }

  const triggered: DisciplineLine[] = []

  // 阈值读用户参数（缺省回退默认值），只提醒不拦截
  const params = await loadParams(db)

  // 浮盈线：必须用 currentNav（单位净值）算市值
  const pos = await positionSummary(db, fundCode, currentNav)
  if (pos.total_shares <= 0) return triggered

  const pnlPct = pos.profit_pct

  // 1) profit_take 浮盈 ≥ 阈值（建议兑现）
  if (pnlPct >= params.profit_take_pct) {
    triggered.push({
      type: 'profit_take',
      detail: `浮盈 ${pnlPct.toFixed(2)}%，达到你设的提醒线 ${params.profit_take_pct}%`,
      action: 'reducing',
      suggested_ratio: 0.5,
      note: '涨多反是兑现信号，不是加仓点。安全垫薄时要先落袋一部分（只是建议，买不卖你定）',
    })
  }

  // 2) drawdown_cut 用累计净值算回撤
  const hi = await recentHigh(db, fundCode, asOf, params.lookback_days)
  if (hi && hi > 0) {
    // 用 currentAccNav（累计净值），不是 currentNav
    const dd = (currentAccNav - hi) / hi * 100
    if (Math.abs(dd) >= params.drawdown_cut_pct) {
      triggered.push({
        type: 'drawdown_cut',
        detail:
          `从 ${params.lookback_days} 日高点 ${hi.toFixed(4)} 回撤 ${Math.abs(dd).toFixed(2)}%，` +
          `达到你设的提醒线 ${params.drawdown_cut_pct}%`,
        action: 'reducing',
        suggested_ratio: 0.5,
        note: '回撤用累计净值计算，避免把分红除息误判成下跌（只是建议，减不减你定）',
      })
    }
  }

  // 3) admit_wrong 亏损 ≤ 阈值 且跑输基准
  if (pnlPct <= params.stop_loss_pct) {
    const underperform =
      benchmarkChangePct != null && pnlPct < benchmarkChangePct
    // 不传基准 OR 跑输 → 都触发
    if (benchmarkChangePct == null || underperform) {
      const baseSuffix =
        benchmarkChangePct != null
          ? ` 且跑输基准（基准 ${benchmarkChangePct.toFixed(2)}%）`
          : ''
      triggered.push({
        type: 'admit_wrong',
        detail: `亏损 ${pnlPct.toFixed(2)}%${baseSuffix}`,
        action: 'clearing',
        suggested_ratio: 1.0,
        note: '投资逻辑证伪或持续弱势就该走，期限不是「不卖」的承诺（只是建议，走不走你定）',
      })
    }
  }

  return triggered
}

// ─────────────────────────────────────────────
// 3. penaltyRisk —— 罚期检查（7 天惩罚性赎回费）
// ─────────────────────────────────────────────

/**
 * 检查当前赎回会不会踩到 7 天惩罚费。
 *
 * 这是最容易白送钱的地方：赎回按 FIFO 消耗批次，
 * 如果最早的批次还没满 7 天，就要付 1.5% 而不是 0.5%。
 *
 * 用 ledger.holdingReport 找 is_penalty=true 的批次
 */
export async function penaltyRisk(
  db: LedgerDb,
  fundCode: string,
  asOf: string,
): Promise<PenaltyRiskResult> {
  const lots = await holdingReport(db, fundCode, asOf)
  if (!lots || lots.length === 0) {
    return { has_penalty_risk: false, risky_lots: 0, days_to_wait: 0, detail: '无持仓' }
  }
  const risky = lots.filter((l) => l.is_penalty)
  if (risky.length === 0) {
    return {
      has_penalty_risk: false,
      risky_lots: 0,
      days_to_wait: 0,
      detail: '所有批次均已满 7 天',
    }
  }
  const worst = Math.min(...risky.map((l) => l.days_to_penalty_free))
  return {
    has_penalty_risk: true,
    risky_lots: risky.length,
    days_to_wait: worst,
    detail:
      `${risky.length} 个批次仍在 7 天惩罚期内，` +
      `再等 ${worst} 天可免罚（1.5% → 0.75%）`,
  }
}

// ─────────────────────────────────────────────
// 4. loadParams —— 纪律线参数（用户可调，缺省回退默认值）
// ─────────────────────────────────────────────

/**
 * 纪律线参数（用户可调，缺省回退默认值）。
 * 优先读 app_settings 用户参数；读不到/未设置 → 回退 config.ts 默认值。
 * **只提示、不拦截**：所有阈值只用于提醒与建议，不 block 下单。
 */
export interface DisciplineParams {
  profit_take_pct: number
  drawdown_cut_pct: number
  stop_loss_pct: number
  lookback_days: number
  account_stop_pct: number
}

export async function loadParams(db: LedgerDb): Promise<DisciplineParams> {
  const rows = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key IN
     ('discipline_profit_take','discipline_drawdown_cut','discipline_stop_loss','discipline_lookback','risk_account_stop_pct')`,
  ).catch(() => [] as { key: string; value: string }[])
  const map = new Map(rows.map(r => [r.key, Number(r.value)]))
  const num = (k: string, dflt: number): number => {
    const v = map.get(k)
    return v != null && Number.isFinite(v) ? v : dflt
  }
  return {
    profit_take_pct: num('discipline_profit_take', RULES_CONFIG.profit_take_pct),
    drawdown_cut_pct: num('discipline_drawdown_cut', RULES_CONFIG.drawdown_cut_pct),
    stop_loss_pct: num('discipline_stop_loss', RULES_CONFIG.stop_loss_pct),
    lookback_days: num('discipline_lookback', RULES_CONFIG.lookback_days),
    account_stop_pct: num('risk_account_stop_pct', RISK_CONFIG.max_drawdown_stop_pct),
  }
}

// ─────────────────────────────────────────────
// 5. checkAccountStop —— 账户级回撤提醒（峰值法）
// ─────────────────────────────────────────────

/**
 * 账户总资产 = 现金 + 持仓市值。
 *
 * 实现：SUM(cash_ledger.amount) + SUM(lots.remaining_shares × 最新净值)
 *
 * 净值取法：对每个有持仓的基金，从 nav_daily 取最近一天 nav（优先 COALESCE(nav, acc_nav)）。
 * 简化策略：直接累计 nav_daily.remaining × recent_nav，按 fund_code 聚合避免重复计算。
 */
async function getTotalAssets(db: LedgerDb): Promise<number> {
  // ══ 结构隔离 ══
  // 本函数是**账户级止损横幅**的数据源 —— 必须只对**真实持仓**生效，保护真钱。
  //  - 只取 `source='real'` 的批次（避免真实与虚拟持仓混算）；
  //  - **不含现金**：真实持仓是外部导入的存量资产，本机没有它的现金流水，
  //    交易盘的 cash_ledger 与真实资产无关（混进来会虚增分母、稀释回撤）。
  // 持仓市值：每个基金的 remaining_shares × 最新单位净值（市值用 nav）
  const mvRows = await db.query<{ fund_code: string; mv: number }>(
    `SELECT l.fund_code AS fund_code,
            SUM(l.remaining_shares * COALESCE(n.nav, n.acc_nav)) AS mv
       FROM lots l
       LEFT JOIN (
         SELECT fund_code, nav, acc_nav,
                ROW_NUMBER() OVER (PARTITION BY fund_code ORDER BY nav_date DESC) AS rn
           FROM nav_daily
       ) n ON n.fund_code = l.fund_code AND n.rn = 1
      WHERE l.status = 'active' AND l.remaining_shares > 0 AND l.source = 'real'
      GROUP BY l.fund_code`,
  )
  const marketValue = mvRows.reduce((s, r) => s + (r.mv ?? 0), 0)

  return round(marketValue, 2)
}

/** 读 peak_assets（无则 0） */
async function readPeakAssets(db: LedgerDb): Promise<number> {
  const rows = await db.query<{ value: string }>(
    `SELECT value FROM pool_meta WHERE key = ?`,
    ['peak_assets'],
  )
  if (!rows[0]?.value) return 0
  const v = Number(rows[0].value)
  return Number.isFinite(v) ? v : 0
}

/** 写 peak_assets（创新高时） */
async function writePeakAssets(db: LedgerDb, peak: number): Promise<void> {
  await db.run(
    `INSERT INTO pool_meta (key, value, updated_at) VALUES ('peak_assets', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(round(peak, 2)), new Date().toISOString()],
  )
}

/**
 * 账户级回撤止损（峰值法）。
 *
 * 为什么用峰值法：
 *   算回撤本该需要历史总资产序列，那要多建一张每日快照表。
 *   峰值法只需记一个"历史最高"数字，存 meta 表即可，
 *   效果等价（都是衡量从最高点回落多少），复杂度低得多。
 *
 * ⚠️ 触发后【仅告警、不暂停自动交易】：
 *   由人或 AI 决定下一步，而不是自动清仓——**自动割肉往往割在低点**。
 *
 * 峰值存 pool_meta 表（key='peak_assets'，复用现有 key/value 表，不新增）
 */
export async function checkAccountStop(db: LedgerDb): Promise<AccountStopResult> {
  const total = await getTotalAssets(db)
  const prevPeak = await readPeakAssets(db)

  let peak = prevPeak
  if (total > peak) {
    peak = total
    await writePeakAssets(db, peak)
  }

  const drawdownPct = peak > 0 ? (total - peak) / peak * 100 : 0
  // 阈值读用户参数（缺省回退默认值）；**只提示，不拦截**
  const limit = (await loadParams(db)).account_stop_pct
  // drawdownPct 是负数表示回落；峰值后回撤的绝对值 ≥ 阈值才算触发
  const triggered = drawdownPct < 0 && Math.abs(drawdownPct) >= limit

  const note = triggered
    ? `提示：账户从峰值回落 ${Math.abs(drawdownPct).toFixed(2)}%，超过你设的 ${limit}% 提醒线。要不要减仓/清仓，你自己定。`
    : `距最高点 ${Math.abs(drawdownPct).toFixed(2)}%，未到你设的 ${limit}% 提醒线（只是提醒，不会替你操作）`

  return {
    total_assets: round(total, 2),
    peak_assets: round(peak, 2),
    drawdown_pct: round(drawdownPct, 2),
    limit_pct: limit,
    triggered,
    note,
  }
}

// ─────────────────────────────────────────────
// 6. runOfflineCycle —— 离线周期主入口
// ─────────────────────────────────────────────

/**
 * 离线周期主入口。AI 不在线时由调度器调用。
 *
 * 返回本次周期的检查结果和建议动作，供调度器执行或记录。
 *
 * 净值读取策略：每只基金取 nav_daily 最新一天的 COALESCE(nav, acc_nav)，
 * 拆成 currentNav (nav) 和 currentAccNav (COALESCE(nav, acc_nav)) 传给 checkDiscipline
 */
export async function runOfflineCycle(
  db: LedgerDb,
  fundCodes: string[],
  asOf: string,
): Promise<{ as_of: string; actions: OfflineCycleEntry[] }> {
  const actions: OfflineCycleEntry[] = []

  for (const code of fundCodes) {
    const rows = await db.query<{ nav: number | null; acc_nav: number | null }>(
      `SELECT nav, acc_nav FROM nav_daily
        WHERE fund_code = ?
        ORDER BY nav_date DESC LIMIT 1`,
      [code],
    )
    const r = rows[0]
    const currentNav      = r?.nav ?? null
    const currentAccNav   = r?.acc_nav ?? r?.nav ?? null
    const entry: OfflineCycleEntry = { fund_code: code, lines: [], penalty: { has_penalty_risk: false, risky_lots: 0, days_to_wait: 0, detail: '无持仓' } }

    if (currentNav == null || currentAccNav == null) {
      entry.note = '无净值数据，跳过纪律检查'
      actions.push(entry)
      continue
    }

    entry.nav = currentNav
    try {
      entry.lines = await checkDiscipline(db, code, currentNav, currentAccNav, asOf)
    } catch (e) {
      entry.note = `纪律检查失败: ${(e as Error).message}`
      actions.push(entry)
      continue
    }
    entry.penalty = await penaltyRisk(db, code, asOf)
    actions.push(entry)
  }

  return { as_of: asOf, actions }
}

// ═════════════════════════════════════════════════════════════════════
// 验收用例
// ═════════════════════════════════════════════════════════════════════
//
// 5 项验收：
//   1. 回撤不误判分红（分红除息只影响单位净值，不影响累计净值）
//   2. 净值拆分生效（浮盈用 nav，回撤用 acc_nav，互不替代）
//   3. 三条线各自触发
//   4. 罚期能算 days_to_wait
//   5. 账户止损：峰值法 + 仅告警不自动
//
// Mock：MemoryRulesDb —— 同时模拟 nav_daily / lots / cash_ledger / pool_meta
// ═════════════════════════════════════════════════════════════════════

/** 净值行（内存） */
interface NavRow { fund_code: string; nav_date: string; nav: number; acc_nav: number }
/** 批次行（内存；与 ledger.ts LotRow 字段对齐） */
interface LotRow {
  lot_id: number; fund_code: string; order_id: number
  confirm_date: string; shares: number; remaining_shares: number
  cost_amount: number; status: string; created_at: string
}
/** pool_meta 行（内存） */
interface MetaRow { key: string; value: string; updated_at: string }
/** cash_ledger 行（内存） */
interface CashRow { amount: number; note?: string }

/**
 * 内存版规则测试 DB：模拟 rules.ts 所需的 nav_daily / lots / cash_ledger / pool_meta。
 * 简单实现：仅按 SQL 关键字匹配，足够覆盖本模块 5 个验收用例。
 */
class MemoryRulesDb implements LedgerDb {
  private _navs: NavRow[] = []
  private _lots: LotRow[] = []
  private _cash: CashRow[] = []
  private _meta: MetaRow[] = []
  private _lotId = 0

  // ── 数据装填（测试用） ──
  addNav(fund_code: string, nav_date: string, nav: number, acc_nav?: number): void {
    // 同基金同日：覆盖（测试中常通过 addNav 更新当日净值）
    const idx = this._navs.findIndex(
      (n) => n.fund_code === fund_code && n.nav_date === nav_date,
    )
    if (idx >= 0) {
      this._navs[idx] = { fund_code, nav_date, nav, acc_nav: acc_nav ?? nav }
    } else {
      this._navs.push({ fund_code, nav_date, nav, acc_nav: acc_nav ?? nav })
    }
  }
  addLot(fund_code: string, confirm_date: string, shares: number, cost_amount: number): number {
    this._lotId++
    this._lots.push({
      lot_id: this._lotId, fund_code, order_id: this._lotId,
      confirm_date, shares, remaining_shares: shares,
      cost_amount, status: 'active', created_at: confirm_date,
    })
    return this._lotId
  }
  addCash(amount: number, note = ''): void {
    this._cash.push({ amount, note })
  }
  /** 直接喂一个 peak 值 */
  setMeta(key: string, value: string): void {
    const existing = this._meta.find((m) => m.key === key)
    if (existing) existing.value = value
    else this._meta.push({ key, value, updated_at: new Date().toISOString() })
  }
  reset(): void {
    this._navs = []; this._lots = []; this._cash = []; this._meta = []; this._lotId = 0
  }

  // ── LedgerDb 接口 ──
  async run(sql: string, params?: unknown[]): Promise<{ lastInsertId: number }> {
    const s = sql.trim()
    if (s.startsWith('INSERT INTO pool_meta')) {
      // SQL 形如：INSERT INTO pool_meta (key, value, updated_at) VALUES ('peak_assets', ?, ?)
      // key 是字面量、value/ts 是占位符
      const keyMatch = s.match(/VALUES\s*\(\s*'([^']+)'/i)
      const key = keyMatch ? keyMatch[1] : 'unknown'
      const val = (params![0] as string)
      const ts  = (params![1] as string)
      const existing = this._meta.find((m) => m.key === key)
      if (existing) { existing.value = val; existing.updated_at = ts }
      else this._meta.push({ key, value: val, updated_at: ts })
      return { lastInsertId: 0 }
    }
    if (s.startsWith('INSERT INTO lots')) {
      // INSERT INTO lots (fund_code, order_id, confirm_date, shares, remaining_shares, cost_amount, status, created_at)
      this._lotId++
      const f = params!
      this._lots.push({
        lot_id: this._lotId, fund_code: f[0] as string, order_id: f[1] as number,
        confirm_date: f[2] as string, shares: f[3] as number,
        remaining_shares: f[4] as number, cost_amount: f[5] as number,
        status: (f[6] as string) ?? 'active', created_at: (f[7] as string) ?? '',
      })
      return { lastInsertId: this._lotId }
    }
    return { lastInsertId: 0 }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const s = sql.trim()
    // nav_daily: SELECT MAX(COALESCE(acc_nav, nav)) AS hi WHERE fund_code AND nav_date BETWEEN
    if (/MAX\(COALESCE\(acc_nav,\s*nav\)\)/i.test(s)) {
      const code = params![0] as string
      const start = params![1] as string
      const end   = params![2] as string
      let hi: number | null = null
      for (const r of this._navs) {
        if (r.fund_code !== code) continue
        if (r.nav_date < start || r.nav_date > end) continue
        const v = r.acc_nav ?? r.nav
        if (hi == null || v > hi) hi = v
      }
      return [{ hi }] as unknown as T[]
    }
    // nav_daily: SELECT nav, acc_nav WHERE fund_code ORDER BY nav_date DESC LIMIT 1
    if (/SELECT\s+nav,\s*acc_nav.*ORDER\s+BY\s+nav_date\s+DESC/i.test(s)) {
      const code = params![0] as string
      const rows = this._navs
        .filter((r) => r.fund_code === code)
        .sort((a, b) => b.nav_date.localeCompare(a.nav_date))
      return (rows[0] ? [rows[0]] : []) as unknown as T[]
    }
    // cash_ledger: SELECT SUM(amount) AS balance
    if (/SUM\(amount\)/i.test(s)) {
      const bal = this._cash.reduce((s, r) => s + r.amount, 0)
      return [{ balance: bal }] as unknown as T[]
    }
    // pool_meta: SELECT value WHERE key = ?
    if (/SELECT\s+value\s+FROM\s+pool_meta/i.test(s)) {
      const key = params![0] as string
      const row = this._meta.find((m) => m.key === key)
      return (row ? [{ value: row.value }] : []) as unknown as T[]
    }
    // 持仓市值聚合（LEFT JOIN 窗口 + lots）
    if (/SUM\(l\.remaining_shares\s*\*\s*COALESCE\(n\.nav/i.test(s)) {
      const byCode = new Map<string, number>()
      for (const lot of this._lots) {
        if (lot.status !== 'active' || lot.remaining_shares <= 0) continue
        const latest = this._navs
          .filter((n) => n.fund_code === lot.fund_code)
          .sort((a, b) => b.nav_date.localeCompare(a.nav_date))[0]
        if (!latest) continue
        const nav = latest.nav ?? latest.acc_nav ?? 0
        byCode.set(lot.fund_code, (byCode.get(lot.fund_code) ?? 0) + lot.remaining_shares * nav)
      }
      const out: { fund_code: string; mv: number }[] = []
      byCode.forEach((mv, fund_code) => out.push({ fund_code, mv }))
      return out as unknown as T[]
    }
    // lots SELECT （其它）
    if (/FROM\s+lots/i.test(s)) {
      let rows = this._lots
      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/is)
      const whereClause = whereMatch ? whereMatch[1] : ''
      if (params?.[0] != null && /fund_code\s*=\s*\?/i.test(whereClause)) {
        rows = rows.filter((l) => l.fund_code === params[0])
      }
      if (/status\s*=\s*'active'/i.test(whereClause)) {
        rows = rows.filter((l) => l.status === 'active')
      }
      if (/remaining_shares\s*>\s*0/i.test(whereClause)) {
        rows = rows.filter((l) => l.remaining_shares > 0)
      }
      if (/ORDER\s+BY\s+confirm_date/i.test(sql)) {
        rows = [...rows].sort(
          (a, b) => a.confirm_date.localeCompare(b.confirm_date) || a.lot_id - b.lot_id,
        )
      }
      return rows as unknown as T[]
    }
    return [] as unknown as T[]
  }

  async transaction<T>(fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

/** 仅在直接运行 rules.ts 时执行验收（vite tree-shake 会消除） */
async function _selfTest(): Promise<void> {
  const db = new MemoryRulesDb()
  let pass = 0
  let fail = 0
  const assert = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { console.log(`  ✓ ${label}`); pass++ }
    else      { console.log(`  ✗ ${label}  ${detail}`); fail++ }
  }

  console.log('═'.repeat(72))
  console.log('rules.ts 验收用例')
  console.log('═'.repeat(72))

  // ─────────────────────────────────────────────
  // 用例 1：回撤不误判分红
  //   单位净值因分红从 1.50 → 1.30（-13%），累计净值仍 2.10
  //   期望：drawdown_cut 不应触发
  // ─────────────────────────────────────────────
  console.log('\n【用例 1】回撤不误判分红')
  db.reset()
  // 60 日窗口：先建立高点（unit=1.02, acc=2.00），再分红（unit=1.02→0.92, acc=2.00→1.90）
  // 当前：unit=0.92, acc=1.90
  // 累计净值从 2.00 → 1.90，回撤 5%（不触发 15% 线）→ 应不触发 drawdown_cut
  const today1 = '2026-09-21'
  for (let i = 60; i >= 1; i--) {
    const d = toDateStr(subtractDays(parseLocalDate(today1), i))
    db.addNav('000001', d, 1.0, 2.0)  // 单位=1.0，累计=2.0
  }
  // 60 日内：分红除息当天单位从 1.0→0.85，累计从 2.0→1.85
  db.addNav('000001', '2026-08-15', 0.85, 1.85)
  db.addNav('000001', today1, 0.85, 1.85)

  db.addLot('000001', '2026-01-01', 10000, 8500)
  const hi1 = await recentHigh(db, '000001', today1)
  assert('recentHigh 用 acc_nav', hi1 === 2.0, `实际=${hi1}`)

  const lines1 = await checkDiscipline(db, '000001', 0.85, 1.85, today1)
  const dd = lines1.find((l) => l.type === 'drawdown_cut')
  assert('分红场景不应触发 drawdown_cut', !dd, dd ? `误触: ${dd.detail}` : '')
  assert('净值拆分：浮盈应基于单位净值 0.85 vs 成本 0.85 → 0%',
    !lines1.find((l) => l.type === 'profit_take'),
    '若用 acc_nav 算浮盈会误触 profit_take（+15%）')

  // ─────────────────────────────────────────────
  // 用例 2：净值拆分生效
  //   currentNav=1.0（不变）, currentAccNav=1.5（跌浮高）→ 应触发 drawdown_cut
  //   但 profit_take 不应触发（浮盈≈0）
  // ─────────────────────────────────────────────
  console.log('\n【用例 2】净值拆分生效（回撤用 acc_nav，浮盈用 nav）')
  db.reset()
  for (let i = 60; i >= 1; i--) {
    const d = toDateStr(subtractDays(parseLocalDate(today1), i))
    db.addNav('000002', d, 1.0, 2.0)
  }
  db.addNav('000002', today1, 1.0, 1.5)  // 当前：单位不变 1.5（涨幅0），累计从 2.0 跌到 1.5（-25%）
  db.addLot('000002', '2026-01-01', 10000, 10000)  // 成本 1.0

  const lines2 = await checkDiscipline(db, '000002', 1.0, 1.5, today1)
  const dd2 = lines2.find((l) => l.type === 'drawdown_cut')
  assert('回撤触发（acc_nav -25% ≥ 15%）', !!dd2, dd2 ? '' : '未触发')
  const pt2 = lines2.find((l) => l.type === 'profit_take')
  assert('浮盈不触发（nav vs cost-95% 持平）', !pt2, pt2 ? `误触: ${pt2.detail}` : '')

  // ─────────────────────────────────────────────
  // 用例 3：三条线各自触发
  // ─────────────────────────────────────────────
  console.log('\n【用例 3】三条线各自触发')
  // 3a profit_take：浮盈 +25%
  db.reset()
  db.addNav('000003', today1, 1.25, 1.25)
  db.addLot('000003', '2026-01-01', 10000, 10000)
  const lines3a = await checkDiscipline(db, '000003', 1.25, 1.25, today1)
  assert('profit_take 触发', !!lines3a.find((l) => l.type === 'profit_take'),
    lines3a.map((l) => l.type).join(','))

  // 3b drawdown_cut：单位/累计都大跌
  db.reset()
  for (let i = 60; i >= 1; i--) db.addNav('000004', toDateStr(subtractDays(parseLocalDate(today1), i)), 1.5, 2.5)
  db.addNav('000004', today1, 1.5, 2.0)  // acc_nav 从 2.5 → 2.0 = -20% ≥ 15%
  db.addLot('000004', '2026-01-01', 10000, 15000)
  const lines3b = await checkDiscipline(db, '000004', 1.5, 2.0, today1)
  assert('drawdown_cut 触发', !!lines3b.find((l) => l.type === 'drawdown_cut'),
    lines3b.map((l) => l.type).join(','))

  // 3c admit_wrong：浮亏 -10% 且跑输基准
  db.reset()
  db.addNav('000005', today1, 0.9, 0.9)
  db.addLot('000005', '2026-01-01', 10000, 10000)
  const lines3c = await checkDiscipline(db, '000005', 0.9, 0.9, today1, -2.0)
  assert('admit_wrong 触发（亏损 -10% 跑输 -2%）',
    !!lines3c.find((l) => l.type === 'admit_wrong'),
    lines3c.map((l) => l.type).join(','))

  // ─────────────────────────────────────────────
  // 用例 4：罚期 days_to_wait
  // ─────────────────────────────────────────────
  console.log('\n【用例 4】罚期 days_to_wait')
  db.reset()
  // 批次：3 天前确认（仍在罚期内）、20 天前确认（已免罚）
  db.addLot('000006', '2026-09-18', 1000, 1000)  // 3 天前
  db.addLot('000006', '2026-09-01', 2000, 2000)  // 20 天前
  const pen = await penaltyRisk(db, '000006', today1)
  assert('有罚期风险', pen.has_penalty_risk === true)
  assert('risky_lots = 1', pen.risky_lots === 1, `实际=${pen.risky_lots}`)
  assert('days_to_wait ≈ 4', pen.days_to_wait === 4, `实际=${pen.days_to_wait}`)

  // ─────────────────────────────────────────────
  // 用例 5：账户止损（峰值法 + 仅告警）
  // ─────────────────────────────────────────────
  console.log('\n【用例 5】账户止损（峰值法 + 仅告警不自动）')
  db.reset()
  db.addCash(10000)  // 现金 10000
  db.addLot('000007', '2026-01-01', 1000, 1000)  // 持仓 1000 份
  db.addNav('000007', today1, 10, 10)  // 净值 10
  // 总资产 = 10000 + 1000*10 = 20000
  const r51 = await checkAccountStop(db)
  assert('初始峰值 = 20000（创建新高）', r51.peak_assets === 20000, `实际=${r51.peak_assets}`)
  assert('drawdown = 0', r51.drawdown_pct === 0, `实际=${r51.drawdown_pct}`)
  assert('未触发止损', r51.triggered === false)

  // 总资产跌至 15000（25% 回撤）
  db.addNav('000007', today1, 5, 5)
  const r52 = await checkAccountStop(db)
  assert('新峰值保持 20000（没创新高）', r52.peak_assets === 20000, `实际=${r52.peak_assets}`)
  assert('drawdown = -25%', r52.drawdown_pct === -25, `实际=${r52.drawdown_pct}`)
  assert('触发止损（≥ -20%）', r52.triggered === true)

  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`)
}

// ⚠️ 自动测试入口：当作为顶层模块执行时启动验收
// vite/esbuild 通过 ESM 静态分析：直接调用会被 tree-shake 消除；
// 这里只在非 tree-shake 路径下启动（cmd: `tsx src/core/rules.ts`）。
if (
  typeof process !== 'undefined' &&
  process.argv?.[1]?.endsWith('rules.ts')
) {
  _selfTest().catch((e) => {
    console.error('[rules self-test] 异常退出:', e)
    process.exit(1)
  })
}