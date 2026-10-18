// ─────────────────────────────────────────────
// budget.ts · 现金账本 + 预算快照
//
//
// 约定：
//   净值口径：只用 nav（单位净值），不用 acc_nav（累计净值）
//   申购费不二次打折（由 orders.ts 处理）
//   赎回确认日不记账（由 orders.ts 处理，只存 arrivalDate）
//   赎回单 confirm_date 补写（由 orders.ts 处理）
//
// 与 orders.ts 循环依赖：ESM 活绑定，只在函数体内调用对方导出。
// ─────────────────────────────────────────────

import type { OrderDb, PendingBuy } from './orders.ts'

// ─── 配置 ────────────────────────────────────────────────────────────

// 本金由用户自设：默认 0、无自动注资。
// 用户在资金卡自输多少就是多少，无上限。此常量仅作 initCapital 的缺省参数（=0，即不注入）；
// orders.ts 既有测试用例走显式金额的「测试专用注入路径」，不对外暴露。
export const INITIAL_CAPITAL = 0.0

// ─── 接口 ────────────────────────────────────────────────────────────

/**
 * 现金账本数据库接口。
 * ⚠️ 唯一来源是 `ledger.ts` —— 此处只做 re-export，避免两份定义互不兼容
 *（两处签名不一致会导致 ledger.LedgerDb 无法传给 budget.LedgerDb 形参）。
 */
import type { LedgerDb } from './ledger.ts'
export type { LedgerDb }

/** 基金净值提供者（注入到 orders.ts） */
export interface NavInfo {
  fund_code: string
  nav_date: string
  nav: number
}

/**
 * 预算快照 —— 对外发布的"当前资金状态"。
 * 不变式：breakdown.consistent === true
 * 即：available === cash_balance - pending_committed
 *
 * pending_committed 为什么必须扣：
 *   场外基金 T+1 确认，pending 时还没记流水，但钱已承诺。
 *   不扣就能连下多笔 pending，单笔都过、累计爆掉 —— 这是隐蔽的坑。
 */
export interface Budget {
  initial_capital: number
  cumulative_added: number
  test_capital: number
  cash_balance: number
  used_in_positions: number
  realized_pnl: number
  pending_committed: number
  available: number
  consistent: boolean
}

export interface BudgetChange {
  delta: number
  memo: string
  after: number
  at: string
}

// ─── 状态 ────────────────────────────────────────────────────────────

let _db: LedgerDb | null = null
let _orderDb: OrderDb | null = null
let _initialCapital = INITIAL_CAPITAL
let _cumulativeAdded = 0.0
let _testCapital = 0.0

export function setLedgerDb(db: LedgerDb): void { _db = db }
export function setOrderDb(db: OrderDb): void { _orderDb = db }

// ─── 公共导出函数 ─────────────────────────────────────────────────────

/**
 * 注入初始资金（09 后仅两条路径）：
 *   - 测试专用：orders.ts 用例显式传 amount（如 100000）
 *   - 默认 amount=0：不注入任何默认本金（装新包可用现金 = 0）
 */
export async function initCapital(amount: number = INITIAL_CAPITAL): Promise<Budget> {
  if (amount > 0) {
    await appendLedger(amount, 'init', { action: 'initial', memo: '初始资金' })
    _initialCapital = amount
    _cumulativeAdded = amount
  }
  return getBudget()
}

/**
 * 用户追加资金（09：金额用户自定、无上限）。
 * source: 'manual'（用户手动输入）| 'monthly_auto'（用户签的定投式追加协议）| 'import'（导入）
 */
export async function appendCapital(amount: number, source: string, memo?: string): Promise<void> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  await appendLedger(amount, `cap-${source}`, { action: 'add', source, memo: memo ?? '' })
  _cumulativeAdded += amount
}

/** 注入测试资金（调试用，不写入月度预算表） */
export async function injectTestCapital(amount: number): Promise<void> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  await appendLedger(amount, `test-${Date.now()}`, { action: 'test_inject', memo: '' })
  _testCapital += amount
}

/**
 * 获取当前预算快照。
 * 不变式：available === cash_balance - pending_committed
 */
export async function getBudget(): Promise<Budget> {
  // pending 买入订单金额（已扣款，从可用中扣除）
  const pendingBuys = await queryPendingBuys()
  const pendingCommitted = pendingBuys.reduce((s, b) => s + b.amount, 0) + ((_db instanceof MemoryBudgetDb) ? (_db as unknown as { pendingCommittedOffset: number }).pendingCommittedOffset : 0)

  // 累计新增（含初始 + 月度 + 手动）
  // 修：原实现只读内存变量 `_cumulativeAdded`，冷启动（WebView 重载）后归零 →
  // 页面「累计投入」显示 ¥0.00，与实际现金账本不一致。改为与 DB 汇总取较大值
  // （现金账本才是事实来源，内存变量只反映本次会话的增量）。
  const addRows = await _db!.query<{ added: number }>(
    `SELECT COALESCE(SUM(amount),0) AS added FROM cash_ledger
     WHERE action IN ('initial','add','test_inject')`,
  )
  const ledgerAdded = addRows[0]?.added ?? 0
  const cumulativeAdded = Math.max(_cumulativeAdded, ledgerAdded)

  // 现金流水最新余额
  const balanceRows = await _db!.query<{ balance: number }>(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM cash_ledger',
  )
  const cashBalance = balanceRows[0]?.balance ?? 0

  // 持仓占用：Σ(cost_amount × remaining / shares)
  // ⚠️ 隔离：**只算交易买入的批次**，排除截图导入的真实持仓
  //    （buy_order_id = 'ocr-import-*'）—— 真实持仓是用户存量资产，不是用自设本金买的，
  //    算进来会让「本金/持仓/可用」对不上账。
  const positionRows = await _db!.query<{ cost: number; remaining: number; shares: number }>(
    `SELECT SUM(cost_amount) as cost, SUM(remaining_shares) as remaining, SUM(shares) as shares
     FROM lots WHERE status='active' AND source='trade'`,
  )
  const usedInPositions = positionRows[0]
    ? positionRows[0].shares > 0
      ? positionRows[0].cost * positionRows[0].remaining / positionRows[0].shares
      : 0
    : 0

  // 已实现盈亏：累计赎回金额 − 已赎回成本
  // ⚠ redeemedCost 从 lots 表算（不从 cash_ledger 取 fee/cost_amount）
  //    公式：Σ cost_amount * (shares - remaining_shares) / shares   WHERE shares > 0
  //    cash_ledger 表无 fee 列、无 redeem 流水（redeem 不写 cash_ledger），
  //    所有数据应在 lots 表体现。
  const redeemRows = await _db!.query<{ gross: number }>(
    `SELECT COALESCE(SUM(amount),0) as gross
     FROM cash_ledger WHERE action='redeem'`,
  )
  const cumulativeRedeem = redeemRows[0]?.gross ?? 0
  const costRows = await _db!.query<{ redeemed_cost: number }>(
    `SELECT COALESCE(SUM(
        CASE WHEN shares > 0
          THEN cost_amount * ((shares - remaining_shares) / shares)
          ELSE 0
        END
     ), 0) AS redeemed_cost
     FROM lots WHERE shares > 0 AND source='trade'`,
  )
  const redeemedCost = costRows[0]?.redeemed_cost ?? 0
  // 累计赎回费：cash_ledger 无 fee 列 → 暂按 0（赎回费可后续从订单记录侧汇总）
  const cumulativeFee = 0
  const realizedPnl = cumulativeRedeem - cumulativeFee - redeemedCost

  // 不变式：available = cash_balance - pending_committed
  const available = cashBalance - pendingCommitted
  const consistent = Math.abs(available - (cashBalance - pendingCommitted)) < 0.01

  return {
    initial_capital: _initialCapital,
    cumulative_added: cumulativeAdded,
    test_capital: _testCapital,
    cash_balance: cashBalance,
    used_in_positions: usedInPositions,
    realized_pnl: realizedPnl,
    pending_committed: pendingCommitted,
    available,
    consistent,
  }
}

/**
 * 追加现金流水（被 orders.ts 调用）。
 * @param amount  正数=收入，负数=支出
 * @param memo    备注
 * @param extra   扩展字段（action/fund_code/order_id/shares/cost_amount 等）
 */
export async function appendLedger(
  amount: number,
  memo: string,
  extra?: Record<string, unknown>,
): Promise<{ lastId: number; after: number }> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const insertSql = `INSERT INTO cash_ledger
    (amount, memo, action, fund_code, order_id, shares, cost_amount, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  const params = [
    amount, memo,
    extra?.action ?? '',
    extra?.fund_code ?? '',
    extra?.order_id ?? '',
    extra?.shares ?? 0,
    extra?.cost_amount ?? 0,
    now,
  ]
  const { lastInsertId } = await _db!.run(insertSql, params)

  // 更新余额
  const afterRows = await _db!.query<{ balance: number }>(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM cash_ledger',
  )
  return { lastId: lastInsertId ?? 0, after: afterRows[0]?.balance ?? 0 }
}

/**
 * 查询 pending 买入订单（仅买，不含卖）。
 * 用于计算 pending_committed。
 */
export async function queryPendingBuys(): Promise<PendingBuy[]> {
  // category 不在 orders 表上，从 funds 表 LEFT JOIN 取
  return _orderDb!.query<PendingBuy>(
    "SELECT o.id, o.order_id, o.amount, o.fund_code, f.category, o.reason " +
    "FROM orders o LEFT JOIN funds f ON f.fund_code = o.fund_code " +
    "WHERE o.status = 'pending' AND o.type = 'buy'",
  )
}

/** 清空所有数据（测试用） */
export async function resetAll(): Promise<void> {
  await _db!.run('DELETE FROM cash_ledger')
  // 显式声明清两套（测试语义 = 清空全部）；生产路径请用 resetBudgetLedger（只动交易盘）
  await _db!.run("DELETE FROM lots WHERE source IN ('real','trade')")
  await _db!.run('DELETE FROM monthly_budget')
  _initialCapital = INITIAL_CAPITAL
  _cumulativeAdded = 0
  _testCapital = 0
}

/**
 * 一键清零重设（保留流水历史，只清余额）。
 * 保留流水历史（不清历史，只清余额）：
 *   - cash_ledger 插入 action='reset' 的负向对冲流水 → 现金余额归 0
 *   - lots 全部关闭（remaining_shares=0, status='closed'）→ 持仓市值归 0
 *   - pending 订单全部撤单（status='cancelled'）→ 冻结归 0
 */
export async function resetBudget(): Promise<void> {
  const balanceRows = await _db!.query<{ balance: number }>(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM cash_ledger',
  )
  const balance = balanceRows[0]?.balance ?? 0
  if (Math.abs(balance) > 0.005) {
    await appendLedger(-balance, '一键清零重设', { action: 'reset', memo: '清零重设对冲流水' })
  }
  // 结构隔离：只关**交易盘**持仓（source='trade'）→ 虚拟持仓市值归 0；
  //   真实持仓（source='real'，OCR 导入的存量资产）绝不触碰 —— 重置模拟盘不能动真钱持仓。
  await _db!.run(`UPDATE lots SET remaining_shares = 0, status = 'closed' WHERE status = 'active' AND source = 'trade'`)
  await _db!.run(`UPDATE orders SET status = 'cancelled' WHERE status = 'pending'`)
  _cumulativeAdded = 0
  _testCapital = 0
}

// ─── MemoryBudgetDb（测试用） ─────────────────────────────────────────

export class MemoryBudgetDb implements LedgerDb, OrderDb {
  /** pending_committed 的手动调整偏移（confirmOrder 确认后清零 pending 金额） */
  pendingCommittedOffset: number = 0

  private _cash: { amount: number; memo: string; action: string; fund_code: string; order_id: string; shares: number; cost_amount: number; created_at: string }[] = []
  private _lots: { lot_id: number; fund_code: string; buy_order_id: string; buy_date: string; confirm_date: string; shares: number; remaining_shares: number; cost_amount: number; status: string; created_at: string }[] = []
  private _orders: { id: number; order_id: string; type: string; fund_code: string; amount: number; nav_date: string | null; status: string; decision_source: string; reason: string; created_at: string; fee_rate: number | null; fee_purchase: number | null; net_amount: number | null; confirm_date: string | null; filled_nav: number | null; filled_shares: number | null; filled_net_amount: number | null; expected_arrival_date: string | null; updated_at: string }[] = []
  private _funds: { fund_code: string; name: string; category: string; purchase_fee_rate: number | null; min_purchase: number | null; is_qdii: number; status: string; added_at: string | null; note: string | null }[] = []
  private _navDaily: { fund_code: string; nav_date: string; nav: number; acc_nav: number | null }[] = []
  private _monthlyBudget: { id: number; ym: string; quota: number }[] = []
  private _fundStatus: { id: number; fund_code: string; status_date: string; purchase_status: string; redeem_status: string; purchase_limit: number | null; limit_unknown: number; raw_purchase: string; raw_redeem: string; note: string; source: string; fetched_at: string }[] = []
  private _id: number = 1

  async run(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; changes?: number }> {
    const s = sql.trim()
    const p = params ?? []
    if (s.startsWith('INSERT')) {
      const table = s.match(/INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+(\w+)/i)?.[1]
      if (table === 'cash_ledger') {
        this._cash.push({ amount: p[0] as number, memo: p[1] as string, action: p[2] as string, fund_code: p[3] as string, order_id: p[4] as string, shares: p[5] as number, cost_amount: p[6] as number, created_at: p[7] as string })
        return { lastInsertId: ++this._id, changes: 1 }
      }
      if (table === 'lots') {
        this._lots.push({ lot_id: p[0] as number, fund_code: p[1] as string, buy_order_id: p[2] as string, buy_date: p[3] as string, confirm_date: p[4] as string, shares: p[5] as number, remaining_shares: p[6] as number, cost_amount: p[7] as number, status: 'active', created_at: p[8] as string })
        return { lastInsertId: ++this._id, changes: 1 }
      }
      if (table === 'orders') {
        const id = ++this._id
        this._orders.push({ id, order_id: p[0] as string, type: p[1] as string, fund_code: p[2] as string, amount: p[3] as number, nav_date: p[4] as string | null, status: 'pending', decision_source: p[5] as string, reason: p[6] as string, created_at: p[7] as string, fee_rate: p[8] as number | null, fee_purchase: p[9] as number | null, net_amount: p[10] as number | null, confirm_date: null, filled_nav: null, filled_shares: null, filled_net_amount: null, expected_arrival_date: null, updated_at: p[7] as string })
        return { lastInsertId: id, changes: 1 }
      }
      if (table === 'funds') {
        // SQL 模板中 'status' 通常是字面量 'active'，不在 params 中。
        // 兼容三种调用形态：
        //   旧 5 参：fund_code, name, category, fee, status
        //   7 参：fund_code, name, category, fee, is_qdii, added_at, note
        //   8 参（带起购线）：fund_code, name, category, fee, min_purchase, is_qdii, added_at, note
        if (p.length >= 8) {
          this._funds.push({
            fund_code: p[0] as string,
            name: p[1] as string,
            category: p[2] as string,
            purchase_fee_rate: p[3] as number | null,
            min_purchase: p[4] as number | null,
            is_qdii: p[5] as number,
            status: 'active',   // SQL 字面量
            added_at: p[6] as string,
            note: p[7] as string | null,
          })
        } else if (p.length >= 7) {
          this._funds.push({
            fund_code: p[0] as string,
            name: p[1] as string,
            category: p[2] as string,
            purchase_fee_rate: p[3] as number | null,
            min_purchase: null,
            is_qdii: p[4] as number,
            status: 'active',
            added_at: p[5] as string,
            note: p[6] as string | null,
          })
        } else {
          this._funds.push({
            fund_code: p[0] as string,
            name: p[1] as string,
            category: p[2] as string,
            purchase_fee_rate: p[3] as number | null,
            min_purchase: null,
            is_qdii: 0,
            status: (p[4] as string) ?? 'active',
            added_at: null,
            note: null,
          })
        }
        return { lastInsertId: ++this._id, changes: 1 }
      }
      if (table === 'nav_daily') {
        this._navDaily.push({ fund_code: p[0] as string, nav_date: p[1] as string, nav: p[2] as number, acc_nav: p[3] as number | null })
        return { lastInsertId: ++this._id, changes: 1 }
      }
      if (table === 'monthly_budget') {
        this._monthlyBudget.push({ id: ++this._id, ym: p[0] as string, quota: p[1] as number })
        return { lastInsertId: this._id, changes: 1 }
      }
      if (table === 'fund_status') {
        this._fundStatus.push({
          id: ++this._id,
          fund_code: p[0] as string,
          status_date: p[1] as string,
          purchase_status: p[2] as string,
          redeem_status: p[3] as string,
          purchase_limit: p[4] as number | null,
          limit_unknown: (p[5] as number | boolean) ? 1 : 0,
          raw_purchase: (p[6] as string) ?? '',
          raw_redeem: (p[7] as string) ?? '',
          note: (p[8] as string) ?? '',
          source: (p[9] as string) ?? 'em_daily',
          fetched_at: (p[10] as string) ?? '',
        })
        return { lastInsertId: this._id, changes: 1 }
      }
      if (table === 'pool_meta') {
        // 简化：直接吃掉，不存（验收不需要池子元数据）
        return {}
      }
      return { lastInsertId: ++this._id, changes: 1 }
    }
    if (s.startsWith('UPDATE')) {
      const setMatch = s.match(/SET\s+(.+?)\s+WHERE/i)
      const whereMatch = s.match(/WHERE\s+(.+)$/i)
      if (setMatch && whereMatch) {
        const setClause = setMatch[1]
        const whereClause = whereMatch[1].trim()
        if (whereClause.includes('order_id')) {
          const oid = params![params!.length - 1] as string
          const order = this._orders.find(o => o.order_id === oid)
          if (order) {
            // 处理字面量 status='X'
            const literalStatus = setClause.match(/status\s*=\s*'(\w+)'/i)?.[1]
            if (literalStatus) { order.status = literalStatus }
            // 处理参数化 status=?（参数索引 0）
            if (setClause.includes('status = ?') || setClause.match(/status\s*=\s*\?\s*[,)]/i)) {
              // 找 status=? 在 setClause 中的位置，取对应参数
              const m = setClause.match(/status\s*=\s*\?/i)
              if (m) {
                const beforeStatus = setClause.slice(0, m.index)
                const idx = (beforeStatus.match(/=/g) ?? []).length
                order.status = params![idx] as string
              }
            }
            if (setClause.includes('confirm_date')) { order.confirm_date = params![0] as string }
            if (setClause.includes('filled_nav')) { order.filled_nav = params![1] as number }
            if (setClause.includes('filled_shares')) { order.filled_shares = params![2] as number }
            if (setClause.includes('filled_net_amount')) { order.filled_net_amount = params![3] as number }
            if (setClause.includes('expected_arrival_date')) { order.expected_arrival_date = params![3] as string }
            // reason 索引：expected_arrival_date 存在 → params[4]，否则 params[3]
            order.reason = params![setClause.includes('expected_arrival_date') ? 4 : 3] as string
            order.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ')
          }
        }
        // 处理 funds 表 UPDATE（如 removeFund SET status='inactive' WHERE fund_code=?）
        if (whereClause.includes('fund_code')) {
          const fcM = whereClause.match(/fund_code\s*=\s*\?/i)
          const beforeFc = whereClause.slice(0, fcM?.index ?? 0)
          const fcIdx = (beforeFc.match(/=/g) ?? []).length
          const fc = params![fcIdx] as string
          const fund = this._funds.find(f => f.fund_code === fc)
          if (fund) {
            const literalStatus = setClause.match(/status\s*=\s*'(\w+)'/i)?.[1]
            if (literalStatus) { fund.status = literalStatus }
          }
        }
      }
      return { changes: 1 }
    }
    return { lastInsertId: 0, changes: 0 }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const s = sql.trim()
    if (s.includes('fund_status')) {
      const code = params?.[0] as string | undefined
      const date = params?.[1] as string | undefined
      let rows = this._fundStatus
      if (code) rows = rows.filter(r => r.fund_code === code)
      if (date) rows = rows.filter(r => r.status_date === date)
      // ORDER BY status_date DESC, fetched_at DESC
      rows = [...rows].sort((a, b) => {
        const d = b.status_date.localeCompare(a.status_date)
        if (d !== 0) return d
        return b.fetched_at.localeCompare(a.fetched_at)
      })
      // LIMIT N
      const lm = s.match(/LIMIT\s+(\d+)/i)
      if (lm) rows = rows.slice(0, parseInt(lm[1]))
      return rows as unknown as T[]
    }
    if (s.includes('cash_ledger') && s.includes('SUM(amount)')) {
      const total = this._cash.reduce((s, r) => s + r.amount, 0)
      return [{ balance: total }] as T[]
    }
    if (s.includes('lots')) {
      // 匹配 FROM lots / INSERT INTO lots ... 等所有 lot 表查询
      // 区分聚合（SUM/COUNT）与全字段（SELECT cost_amount, ...）两种查询
      const isAggregate = s.includes('SUM(') || s.includes('COUNT(')
      let rows = [...this._lots]
      // WHERE buy_order_id=? 过滤
      const oidM = s.match(/buy_order_id\s*=\s*\?/i)
      if (oidM && params) {
        const beforeOid = s.slice(0, oidM.index)
        const oidIdx = (beforeOid.match(/=/g) ?? []).length
        rows = rows.filter(l => l.buy_order_id === params[oidIdx])
      }
      // WHERE fund_code=? 过滤
      const fcM = s.match(/fund_code\s*=\s*\?/i)
      if (fcM && params) {
        const beforeFc = s.slice(0, fcM.index)
        const fcIdx = (beforeFc.match(/=/g) ?? []).length
        rows = rows.filter(l => l.fund_code === params[fcIdx])
      }
      // 默认只返回 active（多数查询场景），显式不过滤可用 status='active'/'closed'
      if (!/status\s*=\s*'(active|closed)'/i.test(s)) {
        rows = rows.filter(l => l.status === 'active')
      }
      if (!isAggregate) {
        // 全字段：按 SELECT 列裁剪 + LIMIT
        const lm = s.match(/LIMIT\s+(\d+)/i)
        const sliced = lm ? rows.slice(0, parseInt(lm[1])) : rows
        // 简单按 SELECT 后列名做字段裁剪
        const colM = s.match(/SELECT\s+(.+?)\s+FROM/i)
        if (colM && !colM[1].includes('*')) {
          const cols = colM[1].split(',').map(c => c.trim().replace(/\s+AS\s+\w+/i, '').split('.').pop()!)
          return sliced.map(l => {
            const out: Record<string, unknown> = {}
            for (const c of cols) out[c] = (l as Record<string, unknown>)[c]
            return out as T
          })
        }
        return sliced.map(l => ({ cost_amount: l.cost_amount, remaining_shares: l.remaining_shares, shares: l.shares, lot_id: l.lot_id, fund_code: l.fund_code })) as T[]
      }
      const cost = rows.reduce((s, l) => s + l.cost_amount, 0)
      const remaining = rows.reduce((s, l) => s + l.remaining_shares, 0)
      const shares = rows.reduce((s, l) => s + l.shares, 0)
      return [{ cost, remaining, shares }] as T[]
    }
    if (s.includes('cash_ledger') && s.includes('action')) {
      const redeem = this._cash.filter(r => r.action === 'redeem')
      const gross = redeem.reduce((s, r) => s + r.amount, 0)
      const fee = 0  // mock 无 fee 字段
      const cost_amount = redeem.reduce((s, r) => s + r.cost_amount, 0)
      return [{ gross, fee, cost_amount }] as T[]
    }
    if (s.includes('orders') && s.includes('pending') && s.includes('type')) {
      return this._orders.filter(o => o.status === 'pending' && o.type === 'buy') as T[]
    }
    if (s.includes('orders') && (s.includes('order_id') || s.includes('WHERE order_id'))) {
      const oid = params?.[0] as string | undefined
      return (oid ? this._orders.filter(o => o.order_id === oid) : this._orders) as T[]
    }
    if (s.includes('orders')) {
      // 通用 orders 查询（含 SELECT * FROM orders WHERE order_id=?、含 fund_code 等）
      let rows = this._orders
      // 提取 fund_code=? 过滤
      const fcM = s.match(/fund_code\s*=\s*\?/i)
      if (fcM && params) {
        const beforeFc = s.slice(0, fcM.index)
        const fcIdx = (beforeFc.match(/=/g) ?? []).length
        const code = params[fcIdx] as string
        rows = rows.filter(o => o.fund_code === code)
      }
      // 提取 order_id=? 过滤（在 WHERE 子句中最后一个参数通常是 order_id）
      const oidM = s.match(/order_id\s*=\s*\?/i)
      if (oidM && params) {
        const beforeOid = s.slice(0, oidM.index)
        const oidIdx = (beforeOid.match(/=/g) ?? []).length
        const oid = params[oidIdx] as string
        rows = rows.filter(o => o.order_id === oid)
      }
      return rows as T[]
    }
    if (s.includes('funds')) {
      // 支持 WHERE fund_code=? / status=? / LIKE 等过滤
      let rows = this._funds
      const fcM = s.match(/fund_code\s*=\s*\?/i)
      if (fcM && params) {
        const beforeFc = s.slice(0, fcM.index)
        const fcIdx = (beforeFc.match(/=/g) ?? []).length
        const code = params[fcIdx] as string
        rows = rows.filter(r => r.fund_code === code)
      }
      if (s.includes("status='active'")) {
        rows = rows.filter(r => r.status === 'active')
      }
      // LIKE 模糊匹配（fund_code LIKE ? OR fund_name LIKE ?）
      const likeM = s.match(/fund_code\s+LIKE\s+\?/i) || s.match(/fund_name\s+LIKE\s+\?/i)
      if (likeM && params) {
        const beforeLike = s.slice(0, likeM.index!)
        const likeIdx = (beforeLike.match(/\?/g) ?? []).length
        const pattern = String(params[likeIdx] ?? '').replace(/%/g, '')
        rows = rows.filter(r =>
          (r.fund_code as string).includes(pattern) ||
          (r.name as string).includes(pattern) ||
          (r.category as string).includes(pattern)
        )
      }
      // ORDER BY fund_code
      rows = [...rows].sort((a, b) => (a.fund_code as string).localeCompare(b.fund_code as string))
      // LIMIT
      const lm = s.match(/LIMIT\s+(\d+)/i)
      if (lm) rows = rows.slice(0, parseInt(lm[1]))
      // COUNT(*)
      if (s.includes('COUNT(*)')) {
        const groupBy = s.match(/GROUP BY (\w+)/i)?.[1]
        if (groupBy === 'category') {
          const by: Record<string, number> = {}
          for (const r of rows) {
            const k = (r.category as string) ?? '未知'
            by[k] = (by[k] ?? 0) + 1
          }
          return Object.entries(by).map(([category, c]) => ({ category, c })) as T[]
        }
        return [{ c: rows.length }] as T[]
      }
      return rows.map(r => ({
        fund_code: r.fund_code,
        fund_name: r.name,
        category: r.category,
        purchase_fee_rate: r.purchase_fee_rate,
        min_purchase: r.min_purchase,
        is_qdii: (r as { is_qdii?: number }).is_qdii ?? 0,
      })) as T[]
    }
    if (s.includes('nav_daily')) {
      // Support filtered nav_daily queries: WHERE fund_code = ? AND nav_date <= ? ORDER BY nav_date DESC LIMIT 1
      const fundCodeParam = params?.[0] as string | undefined
      const dateParam = params?.[1] as string | undefined
      let rows = this._navDaily
      if (fundCodeParam) rows = rows.filter(r => r.fund_code === fundCodeParam)
      if (dateParam) rows = rows.filter(r => r.nav_date <= dateParam)
      rows = rows.sort((a, b) => b.nav_date.localeCompare(a.nav_date))
      if (s.includes('LIMIT')) {
        const limitMatch = s.match(/LIMIT\s+(\d+)/i)
        const limit = limitMatch ? parseInt(limitMatch[1]) : 1
        return rows.slice(0, limit) as T[]
      }
      return rows as T[]
    }
    if (s.includes('monthly_budget')) {
      return this._monthlyBudget as T[]
    }
    return []
  }

  // Mock transaction: execute fn inline, passing self as the tx context
  async transaction<T>(fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

// 验收用例位于 orders.ts（避免循环导入问题）
