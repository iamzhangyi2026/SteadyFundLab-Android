/**
 * 份额批次（lot）管理与 FIFO 赎回 · src/core/ledger.ts
 *
 *
 * ─── 为什么必须用批次 ───────────────────────────────────────────────────────
 * 公募基金赎回按先进先出（FIFO）消耗份额。同一只基金分批买入，各批次持有天数
 * 不同，适用不同档位的赎回费。如果持仓只存「总份额 + 平均成本」，持有天数
 * 会被摊薄：
 *
 *   1 号买 1 万、10 号买 1 万、15 号赎回 1 万：
 *     正确（FIFO）：消耗 1 号批次，持有 14 天，费率 0.5%
 *     错误（平均成本）：天数被摊成 7 天，费率跳到 1.5%
 *
 * 费用差 3 倍，回测结果完全不可信。
 *
 * 持有天数按自然日算（证监会口径），不是交易日。
 *
 * 赎回时绝不能用「汇总值算费率」—— 必须逐批按各自持有天数单独计算。
 * 本模块存在的理由就在于此。
 *
 * ─── 实现要点 ───────────────────────────────────────────────────────
 * ① 异步抽象接口 LedgerDb（可独立验收）
 * ② round(x, n) 自己实现（JS toFixed 返回字符串）
 * ③ 惩罚免期门槛用 penaltyFreeDays()，禁止硬编码 7
 * ④ 日期本地构造，不用 new Date("2026-07-20")（UTC 解析会偏一天）
 * ─────────────────────────────────────────────────────────────────────────
 */

import { holdingDays, calcRedeem, redeemFeeRate, penaltyFreeDays } from './fees.js'
import { pathToFileURL } from 'node:url'

// ─────────────────────────────────────────────
// 导出接口
// ─────────────────────────────────────────────

/**
 * ledger 所需的最小数据库接口（手机端用 Promise API）。
 *
 * 真实 SQLite（Capacitor 插件）实现由数据层接入。
 * 验收时传一个内存实现即可。
 */
export interface LedgerDb {
  /** 写操作（INSERT / UPDATE），返回自增主键（可选带影响行数） */
  run(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; changes?: number }>
  /** 查多行 */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** 事务：fn 内所有操作原子提交，抛错则回滚。tx 为事务上下文（实现可传自身） */
  transaction<T>(fn: (tx: LedgerDb) => Promise<T>): Promise<T>
  /** 标记位：真机 SQLite 适配器带此字段，内存 mock 无（init_app.ts 用 `'_sqliteBackend' in db` 区分） */
  _sqliteBackend?: boolean
}

/** activeLots 返回的单条记录 */
export interface LotRow {
  lot_id: number
  fund_code: string
  order_id: number
  confirm_date: string  // "YYYY-MM-DD"
  shares: number
  remaining_shares: number
  cost_amount: number
  status: string
  created_at?: string
}

/** consumeLots 返回的单条消耗记录 */
export interface ConsumeRecord {
  lot_id: number
  confirm_date: string
  shares: number         // 本批消耗份额
  holding_days: number
  amount: number         // 赎回金额（shares × nav）
  fee_rate: number
  fee: number
  is_penalty: boolean
  net_amount: number
}

/** holdingReport 返回的单条报告 */
export interface HoldingReportItem {
  lot_id: number
  confirm_date: string
  shares: number
  holding_days: number
  confirmed: boolean     // 确认日是否已到
  fee_rate: number
  is_penalty: boolean
  days_to_penalty_free: number
}

/** positionSummary 返回值 */
export interface PositionSummary {
  fund_code: string
  lot_count: number
  total_shares: number
  total_cost: number
  market_value: number
  profit: number
  profit_pct: number
  current_nav: number
}

// ─────────────────────────────────────────────
// 常量 & 工具
// ─────────────────────────────────────────────

const EPS = 1e-9  // 浮点容差

/** 数值四舍五入到 n 位小数（与 fees.ts 风格一致）。 */
function round(x: number, n: number): number {
  const factor = 10 ** n
  return Math.round(x * factor) / factor
}

/**
 * 本地时间构造 Date。
 * 禁止使用 new Date("2026-07-20") —— 它按 UTC 午夜解析，
 * 在 UTC+8 下会变成前一天。
 */
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 把 Date 格式化为 "YYYY-MM-DD"（本地时间）。 */
function toDateStr(d: Date): string {
  const y  = d.getFullYear()
  const m  = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ─────────────────────────────────────────────
// 函数定义
// ─────────────────────────────────────────────

/**
 * 申购确认后建立一个份额批次。
 *
 * ⚠️ 只 INSERT，不 commit（事务边界由调用方控制）。
 * 这样 confirm_order 才能把「扣款 + 建批次 + 改订单状态」做成原子操作。
 *
 * @param db           数据库抽象
 * @param fundCode     基金代码
 * @param orderId      关联订单 id
 * @param confirmDate  份额确认日（T+1），格式 "YYYY-MM-DD"
 * @param shares       该批次份额
 * @param costNav      成交净值
 * @param costAmount   该批次成本金额（含申购费，即实际扣款额）
 * @returns 新 lot 的 id
 */
export async function createLot(
  db: LedgerDb,
  fundCode: string,
  orderId: number,
  confirmDate: string,
  shares: number,
  costNav: number,
  costAmount: number,
): Promise<number> {
  const now = new Date()
  const ts  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T` +
              `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  const r = await db.run(
    // 结构隔离：createLot 只服务「交易买入」路径 → source 固定 'trade'
    `INSERT INTO lots
       (fund_code, buy_order_id, confirm_date, shares, remaining_shares,
        cost_amount, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'trade', ?)`,
    [fundCode, orderId, confirmDate, shares, shares, costAmount, ts],
  )
  return r.lastInsertId ?? 0
}

/**
 * 取该基金所有还有剩余份额的活跃批次，按 FIFO 顺序。
 *
 * ORDER BY confirm_date ASC, lot_id ASC —— 先确认的先卖，同天按创建顺序。
 */
export async function activeLots(
  db: LedgerDb,
  fundCode: string,
  source: 'real' | 'trade' = 'trade',
): Promise<LotRow[]> {
  // 结构隔离：FIFO 消耗只发生在交易盘（真实持仓只读，不参与卖出）
  return db.query<LotRow>(
    `SELECT * FROM lots
     WHERE fund_code = ? AND status = 'active' AND remaining_shares > 0 AND source = ?
     ORDER BY confirm_date ASC, lot_id ASC`,
    [fundCode, source],
  )
}

/**
 * 按 FIFO 消耗份额，逐批计算持有天数与赎回费。
 *
 * 包在事务里，保证 lots 更新与记录一致，避免「份额扣了但记录没落」对不上账。
 *
 * @param db             数据库抽象
 * @param fundCode       基金代码
 * @param redeemShares   要赎回的份额
 * @param redeemNavDate  赎回成交净值日（用于算持有天数），格式 "YYYY-MM-DD"
 * @param nav            赎回成交净值（用于算赎回金额）
 * @returns 每批消耗记录数组
 */
export async function consumeLots(
  db: LedgerDb,
  fundCode: string,
  redeemShares: number,
  redeemNavDate: string,
  nav: number,
): Promise<ConsumeRecord[]> {
  return db.transaction(async () => {
    const lots = await activeLots(db, fundCode)
    let remaining = redeemShares
    const consumed: ConsumeRecord[] = []

    for (const lot of lots) {
      if (remaining <= EPS) break

      const take = Math.min(lot.remaining_shares, remaining)
      const days  = holdingDays(parseLocalDate(lot.confirm_date), parseLocalDate(redeemNavDate))
      const amount = take * nav
      const [fee, rate, isPenalty] = calcRedeem(amount, days)

      consumed.push({
        lot_id: lot.lot_id,
        confirm_date: lot.confirm_date,
        shares: round(take, 4),
        holding_days: days,
        amount: round(amount, 2),
        fee_rate: rate,
        fee: round(fee, 2),
        is_penalty: isPenalty,
        net_amount: round(amount - fee, 2),
      })

      const newRemaining = lot.remaining_shares - take
      if (newRemaining <= EPS) {
        await db.run(
          "UPDATE lots SET remaining_shares = 0, status = 'exhausted' WHERE lot_id = ?",
          [lot.lot_id],
        )
      } else {
        await db.run(
          "UPDATE lots SET remaining_shares = ? WHERE lot_id = ?",
          [newRemaining, lot.lot_id],
        )
      }
      remaining -= take
    }

    return consumed
  })
}

/**
 * 各批次持有情况报告（含免罚倒计时）。
 *
 * 注意：倒计时是「每个批次一个」，不是每只基金一个。
 * 同一只基金可能同时存在「已免罚」和「还需 2 天」的批次。
 *
 * @param db    数据库抽象
 * @param fundCode 基金代码
 * @param asOf  报告截止日期，格式 "YYYY-MM-DD"
 */
export async function holdingReport(
  db: LedgerDb,
  fundCode: string,
  asOf: string,
): Promise<HoldingReportItem[]> {
  const lots = await activeLots(db, fundCode)
  const out: HoldingReportItem[] = []

  for (const lot of lots) {
    const rawDays = holdingDays(parseLocalDate(lot.confirm_date), parseLocalDate(asOf))
    // 确认日可能还没到（已下单、T+1 确认前查看），此时差值为负。
    // 按 0 处理并标记未确认，避免界面出现「持有 -1 天」这种怪异读数。
    const days = Math.max(0, rawDays)
    const [rate, isPenalty] = redeemFeeRate(days)

    out.push({
      lot_id: lot.lot_id,
      confirm_date: lot.confirm_date,
      shares: round(lot.remaining_shares, 4),
      holding_days: days,
      confirmed: rawDays >= 0,
      fee_rate: rate,
      is_penalty: isPenalty,
      // 未确认时还要多等确认日到来，所以按真实差值（raw_days）算
      days_to_penalty_free: Math.max(0, penaltyFreeDays() - rawDays),
    })
  }

  return out
}

/**
 * 持仓汇总（只用于展示，赎回时绝不能拿汇总值算费率）。
 *
 * @param fundCode   基金代码
 * @param currentNav 当前最新净值（用于估算市值）
 */
export async function positionSummary(
  db: LedgerDb,
  fundCode: string,
  currentNav: number,
): Promise<PositionSummary> {
  const lots = await activeLots(db, fundCode)
  const totalShares = lots.reduce((s, l) => s + l.remaining_shares, 0)
  const totalCost = lots.reduce((s, l) => {
    // 按比例分摊成本（剩余份额 / 原始份额 × 原始成本）
    return s + l.cost_amount * (l.remaining_shares / l.shares)
  }, 0)
  const marketValue = totalShares * currentNav
  const profit      = marketValue - totalCost

  return {
    fund_code: fundCode,
    lot_count: lots.length,
    total_shares: round(totalShares, 4),
    total_cost: round(totalCost, 2),
    market_value: round(marketValue, 2),
    profit: round(profit, 2),
    profit_pct: totalCost ? round(profit / totalCost * 100, 2) : 0,
    current_nav: currentNav,
  }
}

// ─────────────────────────────────────────────
// 演示入口：内存版 LedgerDb + 5 组验收用例
// ─────────────────────────────────────────────
if (import.meta.url && new URL(import.meta.url).pathname.endsWith('/ledger.ts')) {

  // ── 内存版 LedgerDb（验收专用，不依赖真实 SQLite）──
  class MemoryLedgerDb implements LedgerDb {
    private _id = 0
    private _lots: LotRow[] = []

    get lots() { return this._lots }

    async run(sql: string, params?: unknown[]): Promise<{ lastInsertId: number }> {
      const s = sql.trim()
      if (s.startsWith('INSERT')) {
        // 解析 VALUES 中最后一个占位符（created_at）以外的字段
        this._id++
        const f = params!
        this._lots.push({
          lot_id: this._id,
          fund_code: f[0] as string,
          order_id: f[1] as number,
          confirm_date: f[2] as string,
          shares: f[3] as number,
          remaining_shares: f[4] as number,
          cost_amount: f[5] as number,
          status: 'active',
          created_at: f[6] as string,
        })
        return { lastInsertId: this._id }
      }
      if (s.startsWith('UPDATE')) {
        // 按 params.length 区分两条分支：
        //   exhausted: params = [lot_id]       → remaining=0, status='exhausted'
        //   else:      params = [newRem, lot_id] → remaining=newRem（status 不变）
        let newRem: number
        let lid: number
        if (params!.length === 1) {
          lid    = params![0] as number
          newRem = 0
        } else {
          newRem = params![0] as number
          lid    = params![1] as number
        }
        const lot = this._lots.find(l => l.lot_id === lid)
        if (lot) {
          lot.remaining_shares = newRem
          if (params!.length === 1) lot.status = 'exhausted'
        }
        return { lastInsertId: 0 }
      }
      return { lastInsertId: 0 }
    }

    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      let rows = this._lots
      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/is)
      const whereClause = whereMatch ? whereMatch[1].trim() : ''
      if (params?.[0]) {
        rows = rows.filter((l: LotRow) => l.fund_code === params[0])
      }
      if (whereClause.includes("status = 'active'")) {
        rows = rows.filter((l: LotRow) => l.status === 'active')
      }
      if (whereClause.includes('remaining_shares > 0')) {
        rows = rows.filter((l: LotRow) => l.remaining_shares > 0)
      }
      // ORDER BY confirm_date ASC, lot_id ASC（FIFO 关键）
      if (/ORDER\s+BY\s+confirm_date/i.test(sql)) {
        rows = [...rows].sort(
          (a: LotRow, b: LotRow) =>
            a.confirm_date.localeCompare(b.confirm_date) || a.lot_id - b.lot_id,
        )
      }
      return rows as unknown as T[]
    }

    async transaction<T>(fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
      // 内存版无真实事务，直接执行
      return fn(this)
    }

    /** 重置所有数据（用于跨用例独立验证） */
    reset() {
      this._id = 0
      this._lots = []
    }
  }

  // ── 辅助输出 ──
  const fmt = (n: number) => n.toFixed(4)
  const fmtC = (n: number) => n.toFixed(2)
  const fmtPct = (r: number) => (r * 100).toFixed(2)

  async function run() {
    const db = new MemoryLedgerDb()
    const NAV = 1.5000

    console.log('═'.repeat(78))
    console.log('FIFO 赎回演示（净值按 1.5000 计）')
    console.log('═'.repeat(78))
    console.log(`\n[全局常量] penaltyFreeDays()=${penaltyFreeDays()}  EPS=${EPS}`)

    // ── 建立三个批次 ──
    console.log('\n建立三个批次：')
    const lots_data = [
      { confirmDate: '2026-07-20', shares: 2000 },
      { confirmDate: '2026-08-20', shares: 2000 },
      { confirmDate: '2026-08-26', shares: 2000 },
    ]
    for (let i = 0; i < lots_data.length; i++) {
      const d  = lots_data[i].confirmDate
      const sh = lots_data[i].shares
      await createLot(db, 'TEST001', i + 1, d, sh, NAV, sh * NAV)
      console.log(`  批次${i + 1}  确认日 ${d}  ${sh} 份  成本 ${fmtC(sh * NAV)} 元`)
    }

    const asOf = '2026-08-28'

    // ═══════════════════════════════════════
    // 用例 1 · 持有报告
    // ═══════════════════════════════════════
    console.log(`\n【用例 1】持有报告  as_of=${asOf}`)
    const report = await holdingReport(db, 'TEST001', asOf)
    for (const r of report) {
      const free = r.days_to_penalty_free === 0 ? '已免罚' : `还需 ${r.days_to_penalty_free} 天免罚`
      const flag = r.is_penalty ? '  ← 惩罚性 1.5%' : ''
      console.log(
        `  批次${r.lot_id}  ${r.confirm_date}  持有 ${r.holding_days} 天  ` +
        `费率 ${fmtPct(r.fee_rate)}%  ${free}${flag}`,
      )
    }
    // 期望：
    //   批次1  2026-07-20  持有 39 天  费率 0.50%  已免罚
    //   批次2  2026-08-20  持有  8 天  费率 0.75%  已免罚
    //   批次3  2026-08-26  持有  2 天  费率 1.50%  还需 5 天免罚  ← 惩罚性 1.5%

    // ═══════════════════════════════════════
    // 用例 2 · 赎回 2000 份
    // ═══════════════════════════════════════
    console.log('\n【用例 2】赎回 2000 份（FIFO 应消耗 07-20 那批，持有 39 天，费率 0.5%）')
    const used1 = await consumeLots(db, 'TEST001', 2000, asOf, NAV)
    for (const u of used1) {
      console.log(
        `  消耗批次${u.lot_id} ${u.confirm_date}  ${fmt(u.shares)} 份  ` +
        `持有 ${u.holding_days} 天  费率 ${fmtPct(u.fee_rate)}%  ` +
        `amount=${fmtC(u.amount)}  fee=${fmtC(u.fee)}  net=${fmtC(u.net_amount)}`,
      )
    }
    // 期望：批次1 2000份 39天 0.50%  amount=3000.00 fee=15.00 net=2985.00
    // 剩余：批次2（2000份）、批次3（2000份）

    // ═══════════════════════════════════════
    // 用例 3 · 再赎回 2000 份
    // ═══════════════════════════════════════
    console.log('\n【用例 3】再赎回 2000 份（消耗 08-20 那批，持有 8 天，费率 0.75%）')
    const used2 = await consumeLots(db, 'TEST001', 2000, asOf, NAV)
    for (const u of used2) {
      console.log(
        `  消耗批次${u.lot_id} ${u.confirm_date}  ${fmt(u.shares)} 份  ` +
        `持有 ${u.holding_days} 天  费率 ${fmtPct(u.fee_rate)}%  ` +
        `amount=${fmtC(u.amount)}  fee=${fmtC(u.fee)}  net=${fmtC(u.net_amount)}`,
      )
    }
    // 期望：批次2 2000份 8天 0.75%  amount=3000.00 fee=22.50 net=2977.50
    // 剩余：批次3（2000份）

    // ═══════════════════════════════════════
    // 用例 4 · 跨批次消耗（重置后赎回 2400 份）
    // ═══════════════════════════════════════
    db.reset()
    console.log('\n【用例 4】跨批次消耗（重置数据，赎回 2400 份）')
    for (const d of ['2026-07-20', '2026-08-20', '2026-08-26']) {
      await createLot(db, 'TEST001', 1, d, 2000, NAV, 2000 * NAV)
    }
    const used3 = await consumeLots(db, 'TEST001', 2400, asOf, NAV)
    for (let i = 0; i < used3.length; i++) {
      const u = used3[i]
      console.log(
        `  记录${i + 1}：批次${u.lot_id}  ${fmt(u.shares)} 份  ${u.holding_days} 天  ${fmtPct(u.fee_rate)}%  ` +
        `amount ${fmtC(u.amount)}  fee ${fmtC(u.fee)}  net ${fmtC(u.net_amount)}`,
      )
    }
    // 期望：
    //   记录1：批次1  2000 份  39 天  0.50%  amount 3000.00  fee 15.00  net 2985.00
    //   记录2：批次2   400 份   8 天  0.75%  amount  600.00  fee  4.50  net  595.50
    // 批次1 → exhausted；批次2 remaining = 1600

    // ═══════════════════════════════════════
    // 用例 5 · 持仓汇总（三批完整，current_nav=1.8000）
    // ═══════════════════════════════════════
    const summary = await positionSummary(db, 'TEST001', 1.8000)
    console.log('\n【用例 5】持仓汇总  current_nav=1.8000')
    console.log(`  lot_count   = ${summary.lot_count}`)
    console.log(`  total_shares = ${fmt(summary.total_shares)}`)
    console.log(`  total_cost   = ${fmtC(summary.total_cost)}`)
    console.log(`  market_value = ${fmtC(summary.market_value)}`)
    console.log(`  profit       = ${fmtC(summary.profit)}`)
    console.log(`  profit_pct   = ${fmtC(summary.profit_pct)}%`)
    // 期望：lot_count=3  total_shares=6000  total_cost=9000  market_value=10800  profit=1800  profit_pct=20.00

    // ═══════════════════════════════════════
    // 附加用例 · 确认日未到（防负数）
    // ═══════════════════════════════════════
    const futureAsOf = '2026-08-28'
    const futureLotDate = '2026-09-01'
    db.reset()
    await createLot(db, 'TEST001', 1, futureLotDate, 2000, NAV, 2000 * NAV)
    const futureReport = await holdingReport(db, 'TEST001', futureAsOf)
    const fr = futureReport[0]
    const rawDays = holdingDays(parseLocalDate(futureLotDate), parseLocalDate(futureAsOf))
    console.log('\n【附加用例】确认日未到（防负数）')
    console.log(`  批次确认日 ${futureLotDate}，as_of=${futureAsOf}`)
    console.log(`  raw_days  = ${rawDays}         ← 应 < 0`)
    console.log(`  holding_days = ${fr.holding_days}    ← 展示用，不能出现负数`)
    console.log(`  confirmed = ${fr.confirmed}       ← 应为 false`)
    console.log(`  days_to_penalty_free = ${fr.days_to_penalty_free}  ← 应 = ${Math.max(0, penaltyFreeDays() - rawDays)}`)
    // 期望：raw_days=-4  holding_days=0  confirmed=false  days_to_penalty_free=11

    // ═══════════════════════════════════════
    // 用例 6 · 乱序插入验证 FIFO 排序
    // ═══════════════════════════════════════
    db.reset()
    console.log('\n【用例 6】乱序插入 → FIFO 必须按 confirm_date 排序，与插入顺序无关')
    // 刻意打乱插入顺序：08-20 → 07-20 → 08-26
    await createLot(db, 'TEST001', 1, '2026-08-20', 2000, NAV, 2000 * NAV)
    await createLot(db, 'TEST001', 2, '2026-07-20', 2000, NAV, 2000 * NAV)
    await createLot(db, 'TEST001', 3, '2026-08-26', 2000, NAV, 2000 * NAV)
    const active6 = await activeLots(db, 'TEST001')
    console.log(`  activeLots 返回 ${active6.length} 批，顺序：`)
    for (const a of active6) {
      console.log(`    lot_id=${a.lot_id}  confirm_date=${a.confirm_date}  remaining=${a.remaining_shares}`)
    }
    // 期望顺序：lot_id=2（07-20）→ lot_id=1（08-20）→ lot_id=3（08-26）
    const used6 = await consumeLots(db, 'TEST001', 2000, asOf, NAV)
    for (const u of used6) {
      console.log(
        `  消耗批次${u.lot_id} ${u.confirm_date}  ${fmt(u.shares)} 份  ` +
        `持有 ${u.holding_days} 天  费率 ${fmtPct(u.fee_rate)}%  ` +
        `fee=${fmtC(u.fee)}  net=${fmtC(u.net_amount)}`,
      )
    }
    // 期望：消耗 lot_id=2（07-20，39天，0.50%，fee=15.00）
  }

  // 仅当直接运行才触发（避免被 import 时跑测试，污染模块级状态）
  if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch(console.error)
  }
}
