// ─────────────────────────────────────────────
// orders.ts · 订单生命周期管理
//
//
// 约定：
//   成交/市值净值口径：单位净值（nav）；无数据拒绝确认
//   申购费不二次打折（alreadyDiscounted=true，k 来自 _fundMeta）
//   赎回确认日只存 arrivalDate，不记账（赎回款到账日入账）
//   赎回单 confirm_date 补写（与买入同规则 nextTradingDay(navDate, 1/2)）
//
// 与 budget.ts 循环依赖：ESM 活绑定，只在函数体内调用对方导出。
// ─────────────────────────────────────────────

import { arrivalDateByCategory, describeOrderTiming, nextTradingDay, parseLocalDate } from './calendar.ts'
import { calcPurchase, calcRedeemFee } from './fees.ts'
import { appendLedger, getBudget, initCapital, MemoryBudgetDb, setLedgerDb, setOrderDb as _setBudgetOrderDb } from './budget.ts'
import type { Budget, BudgetChange } from './budget.ts'

// ─── 公共接口（订单层 DB） ───────────────────────────────────────────

export interface OrderDb {
  run(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; changes?: number }>
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** 透传回调 T 类型：允许返回任意值（ledger.ts / orders.ts 均用此接口） */
  transaction<T>(fn: (tx: OrderDb) => Promise<T>): Promise<T>
}

/** 基金净值提供者（注入到 orders.ts） */
export interface NavProvider {
  getNav(fundCode: string, asOf?: string): Promise<number | undefined>
}

// ─── 内部类型 ─────────────────────────────────────────────────────────

export interface FundMeta {
  fund_code: string
  purchase_fee_rate: number | null
  /** 起购金额（元）；null = 源里未知（与限购一样是真实约束，不可猜「不限」） */
  min_purchase: number | null
  category: string | null
  feeRateDiscounted: boolean  // true = 源数据已是折后费率
}

export interface NavInfo {
  fund_code: string
  nav_date: string
  nav: number
}

export interface Order {
  order_id: string
  type: 'buy' | 'sell'
  fund_code: string
  amount: number
  nav_date: string | null
  status: string
  decision_source: string
  reason: string
  created_at: string
  fee_rate: number | null
  fee_purchase: number | null
  net_amount: number | null
  confirm_date: string | null
  filled_nav: number | null
  filled_shares: number | null
  filled_net_amount: number | null
  expected_arrival_date: string | null
  updated_at: string
}

export interface PendingBuy {
  id: number
  order_id: string
  amount: number
  fund_code: string
  category: string
  reason: string
}

export interface ConfirmResult {
  orderId: string
  type: 'buy' | 'sell'
  lotId?: number
  shares?: number
  arrivalDate?: string
  nav: number
  message: string
  budget_after: Budget
}

// ─── 状态（MemoryOrderDb 持有） ──────────────────────────────────────

let _db: OrderDb | null = null
let _nav: NavProvider | null = null
const _metaCache = new Map<string, FundMeta>()

export function setOrderDb(db: OrderDb): void { _db = db }
export function setNavProvider(nav: NavProvider): void { _nav = nav }

// ─── 内部工具 ─────────────────────────────────────────────────────────

function makeId(): string {
  return `ORD${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

/** 获取基金元数据（含折后费率标记），带简单缓存 */
async function _fundMeta(code: string): Promise<FundMeta> {
  const cached = _metaCache.get(code)
  if (cached) return cached
  const rows = await _db!.query<FundMeta>(
    'SELECT fund_code, purchase_fee_rate, min_purchase, category FROM funds WHERE fund_code = ?', [code],
  )
  if (rows.length === 0) return null as unknown as FundMeta  // 基金未注入，fallback 到默认值
  const row = rows[0]
  if (!row) throw new Error(`fund_not_found: ${code}`)
  const meta: FundMeta = {
    ...row,
    feeRateDiscounted: true,  // 源数据已是折后，不再二次打折
  }
  _metaCache.set(code, meta)
  return meta
}

/**
 * 取某基金在指定日期之前的最新单位净值。
 * 只用 nav（单位净值），不用 acc_nav（累计净值）。
 * 无数据时返回 undefined（调用方据此拒绝确认）。
 */
async function _getNav(fundCode: string, asOf?: string): Promise<number | undefined> {
  if (_nav) {
    const v = await _nav.getNav(fundCode, asOf)
    if (v !== undefined) return v
  }
  const rows = await _db!.query<NavInfo>(
    'SELECT nav FROM nav_daily WHERE fund_code = ? AND nav IS NOT NULL'
      + ' AND nav_date <= ? ORDER BY nav_date DESC LIMIT 1',
    [fundCode, asOf ?? new Date().toISOString().slice(0, 10)],
  )
  // 无数据时返回 undefined，由调用方（confirmOrder）拒绝确认
  return rows[0]?.nav
}

// ─── 核心导出函数 ─────────────────────────────────────────────────────

/**
 * 提交前校验（幂等，不修改任何状态）。
 * - 来源非 human 且 reason 为空 → 拒绝
 * - checkBeforeSubmit 不通过 → 拒绝
 */
export async function checkBeforeSubmit(
  orderType: 'buy' | 'sell',
  fundCode: string,
  amount: number,
  decisionSource: string,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  if (decisionSource !== 'human' && !reason.trim()) {
    return { ok: false, message: 'auto_order_no_reason' }
  }
  // 实时可用预算（依赖 budget.ts）
  const budget = await getBudget()
  if (orderType === 'buy') {
    if (amount > budget.available) {
      return { ok: false, message: `amount exceeds available (${amount} > ${budget.available})` }
    }
    // 起购线校验
    //   min_purchase 是「基金最低申购金额」，与限购一样是真实约束
    //   null 表示「源里未知」（保留 DB 旧值）—— 这种情况暂不拦，给出可读提示
    //   > 0 时严格拦截
    const meta = await _fundMeta(fundCode)
    const minPurchase = meta.min_purchase
    if (minPurchase !== null && minPurchase !== undefined && minPurchase > 0 && amount < minPurchase) {
      return { ok: false, message: `低于起购金额 ${minPurchase.toFixed(2)} 元（请求 ${amount} 元）` }
    }
  }
  return { ok: true, message: '' }
}

/**
 * 提交新订单（pending 状态）。
 * 申购费不二次打折（alreadyDiscounted=true）。
 */
export async function submitOrder(
  orderType: 'buy' | 'sell',
  fundCode: string,
  amount: number,
  decisionSource: string,
  reason: string,
  navDate?: string,
): Promise<{ orderId: string; message: string; available_after: number }> {
  const id = makeId()
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  // 取折后费率，不走二次打折
  const meta = await _fundMeta(fundCode)
  const feeRate = meta.purchase_fee_rate ?? 0.0015
  const [fee_purchase, net_amount] = calcPurchase(amount, feeRate, undefined, true)

  // 买入不立即扣款，仅在 confirmOrder 时扣款（避免 pending 订单双重扣款）
  // 净值日推算：调用 describeOrderTiming 处理「交易日 15:00
  // 前 → 当日 / 否则 → 下一交易日」，避免自己拼 isTradingDay+prev/next 方向搞反
  const submitDt = navDate ? parseLocalDate(navDate) : new Date()
  const timing = describeOrderTiming(submitDt)
  const effectiveNavDate = timing.nav_date

  // orders.updated_at 是 NOT NULL，INSERT 必须给值 →
  //   `error code 19: NOT NULL constraint failed: orders.updated_at`，**手动下单写库必失败**。
  await _db!.run(
    `INSERT INTO orders (order_id, type, fund_code, amount, nav_date,
     status, decision_source, reason, created_at, updated_at,
     fee_rate, fee_purchase, net_amount)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    [id, orderType, fundCode, amount, effectiveNavDate,
     decisionSource, reason, now, now, feeRate, fee_purchase, net_amount],
  )

  // 更新可用预算
  const budget = await getBudget()
  return { orderId: id, message: `submitted ${orderType} ${amount} to ${fundCode}`, available_after: budget.available }
}

/**
 * 确认订单（成交）。
 *
 * 用 nav（单位净值）计算份额，无数据拒绝确认。
 * 赎回不记账（confirm_date 存 arrivalDate，到账日再入账）。
 * 赎回单 confirm_date 补写（与买入同规则）。
 */
export async function confirmOrder(
  orderId: string,
  decisionSource: string,
  reason: string,
): Promise<ConfirmResult> {
  const [order] = await _db!.query<Order>(
    'SELECT * FROM orders WHERE order_id = ?', [orderId],
  )
  if (!order) throw new Error(`order_not_found: ${orderId}`)
  if (order.status !== 'pending') throw new Error(`order_not_pending: ${order.status}`)

  // 取单位净值，无数据则拒绝
  const navDate = order.nav_date ?? new Date().toISOString().slice(0, 10)
  // _fundMeta 在基金未注入时返回假 meta（null）→ 必须拒绝确认。
  const meta = await _fundMeta(order.fund_code)
  if (!meta) throw new Error(`fund_meta_unavailable: ${order.fund_code}`)
  // `purchase_fee_rate` 缺失**不再阻塞成交**。
  //   该字段来自全市场申购信息表（fundmobapi 的 FundPurchaseList），受限流影响可能
  //   稳定返回 ErrCode 61136 → 列为 NULL → 「买入能提交、却永远无法确认成交」。
  //   费率未知时按 0 计算，并把「费率未知」如实写进订单备注（不假装有费率）。
  const feeKnown = typeof meta.purchase_fee_rate === 'number' && Number.isFinite(meta.purchase_fee_rate)
  const feeRate = feeKnown ? (meta.purchase_fee_rate as number) : 0
  const confirmReason = feeKnown ? reason : `${reason}${reason ? '；' : ''}申购费率未知（源限流），本单按 0 费计算`
  const nav = await _getNav(order.fund_code, navDate)
  if (nav === undefined) throw new Error(`no_unit_nav: ${order.fund_code} @ ${navDate}`)

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const isQdii = /QDII/i.test(meta.category ?? '')
  // 赎回与买入同规则计算 confirm_date
  const confirmDate = nextTradingDay(new Date(navDate), isQdii ? 2 : 1)
  const confirmDateStr = confirmDate.toISOString().slice(0, 10)

  const result: ConfirmResult = await _db!.transaction(async (tx) => {
    if (order.type === 'buy') {
      // 申购费不二次打折（meta.feeRateDiscounted = true）
      const [fee_purchase, net_amount] = calcPurchase(
        order.amount,
        feeRate,
        undefined,
        meta.feeRateDiscounted,
      )
      const shares = parseFloat((net_amount / nav).toFixed(6))

      // 确认时扣款（pending 阶段不扣，confirm 时一次性记账）
      // 建仓（FIFO 批次）
      const { lastId } = await appendLedger(
        -order.amount, `lot-${makeId()}`,
        { action: 'buy', fund_code: order.fund_code, shares, cost_amount: order.amount, order_id: orderId },
      )
      await tx.run(
        // 结构隔离：交易买入建批次 → source 固定 'trade'（真实持仓走 OCR 导入路径，不在此处）
        `INSERT INTO lots (lot_id, fund_code, buy_order_id, buy_date, confirm_date,
         shares, remaining_shares, cost_amount, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'trade', ?)`,
        [lastId, order.fund_code, orderId, navDate, confirmDateStr,
         shares, shares, order.amount, now],
      )

      await tx.run(
        `UPDATE orders SET status='filled', confirm_date=?, filled_nav=?,
         filled_shares=?, filled_net_amount=?, reason=?, updated_at=?
         WHERE order_id=?`,
        [confirmDateStr, nav, shares, net_amount, confirmReason, now, orderId],
      )

      const budget = await getBudget()
      return { orderId, type: 'buy', lotId: lastId, shares, nav,
        message: `buy confirmed ${shares.toFixed(6)}@${nav}`, budget_after: budget }
    } else {
      // 赎回确认日不记账（赎回款到账日入账，避免在途资金被当可用余额）
      // 赎回单 confirm_date 补写
      const sellNavDate = nextTradingDay(new Date(navDate), 1).toISOString().slice(0, 10)
      const sellNav = await _getNav(order.fund_code, sellNavDate) ?? nav
      const fee = calcRedeemFee(order.amount, sellNav, meta.category ?? '', 0)
      const netProceeds = order.amount - fee
      const arrivalDate = arrivalDateByCategory(new Date(navDate), meta.category ?? '')
      const arrivalDateStr = arrivalDate.toISOString().slice(0, 10)

      await tx.run(
        `UPDATE orders SET status='filled', confirm_date=?, filled_nav=?,
         filled_net_amount=?, expected_arrival_date=?, reason=?, updated_at=?
         WHERE order_id=?`,
        [confirmDateStr, sellNav, netProceeds, arrivalDateStr, confirmReason, now, orderId],
      )

      const budget = await getBudget()
      return { orderId, type: 'sell', arrivalDate: arrivalDateStr, nav: sellNav,
        message: `sell confirmed net=${netProceeds.toFixed(2)} arrival=${arrivalDateStr}`, budget_after: budget }
    }
  })
  // pending 订单确认后，清零 pending_committed（避免双重计算）
  if (result.type === 'buy' && _db instanceof MemoryBudgetDb) {
    ;(_db as unknown as { pendingCommittedOffset: number }).pendingCommittedOffset -= order.amount
  }
  // 补抓该基金净值：
  // 确认成功后 nav_daily 里可能仍没有这只基金的历史（首喂只抓种子基金），
  // 不补的话详情页 / 净值曲线 / 分析页对它依然是空的。
  // **动态 import**：data 层 → core 层 已有依赖方向，静态 import 会成环。
  // fire-and-forget：不 await、不阻塞确认返回；失败只记 fetch 错误，不连累下单。
  if (_db) {
    const dbRef = _db
    void import('../data/ensure_nav.ts')
      .then(({ ensureFundNav }) => ensureFundNav(dbRef, order.fund_code))
      .catch(() => { /* 抓取失败不影响确认结果，详情页会明确提示"暂无净值数据" */ })
  }
  return result
}

/**
 * 取消待处理订单。
 * 买入退款，赎回仅标记。
 */
export async function cancelOrder(
  orderId: string,
  reason: string,
): Promise<{ orderId: string; type: 'buy' | 'sell'; refunded?: number; message: string }> {
  const [order] = await _db!.query<Order>('SELECT * FROM orders WHERE order_id = ?', [orderId])
  if (!order) throw new Error(`order_not_found: ${orderId}`)
  if (order.status !== 'pending') throw new Error(`order_not_pending: ${order.status}`)

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  await _db!.run('UPDATE orders SET status = ?, reason = ?, updated_at = ? WHERE order_id = ?',
    ['cancelled', reason, now, orderId])

  let refunded: number | undefined
  if (order.type === 'buy') {
    // 取消 pending 买入：submitOrder 阶段未扣款（confirm 时一次性记账），
    // 故 cancel 时无需 appendLedger，只需把订单置为 cancelled，pending_committed 自动失效。
    // 返回 refunded 仅作信息展示（告诉调用方「本次取消释放了多少额度」）。
    refunded = order.amount
  }

  const budget = await getBudget()
  return { orderId, type: order.type as 'buy' | 'sell', refunded,
    message: `cancelled ${order.type} ${orderId}`,
  }
}

/**
 * 查询订单列表（支持按状态/基金/类型过滤）。
 */
export async function queryOrders(filters?: {
  status?: string
  fund_code?: string
  type?: string
}): Promise<Order[]> {
  let sql = 'SELECT * FROM orders'
  const params: unknown[] = []
  const wheres: string[] = []
  if (filters?.status) { wheres.push('status = ?'); params.push(filters.status) }
  if (filters?.fund_code) { wheres.push('fund_code = ?'); params.push(filters.fund_code) }
  if (filters?.type) { wheres.push('type = ?'); params.push(filters.type) }
  if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ')
  sql += ' ORDER BY created_at DESC'
  return _db!.query<Order>(sql, params)
}

/** 清空所有数据（测试用） */
export async function resetAll(): Promise<void> {
  await _db!.run('DELETE FROM orders')
  // 显式声明清两套（测试语义 = 清空全部）
  await _db!.run("DELETE FROM lots WHERE source IN ('real','trade')")
  await _metaCache.clear()
}

// ─── 验收用例 ─────────────────────────────────────────────────────────

async function runTests() {
  // 初始化内存 DB（使用静态导入确保同一模块实例）
  const db = new MemoryBudgetDb()
  setOrderDb(db)
  setLedgerDb(db)
  _setBudgetOrderDb(db)

  // 初始化净值数据和基金池（全部使用参数化 INSERT）
  await db.run(
    `INSERT INTO funds (fund_code, fund_name, category, purchase_fee_rate, status) VALUES (?, ?, ?, ?, ?)`,
    ['110011', '易方达中小盘混合', '混合型', 0.0012, 'active']
  )
  await db.run(
    `INSERT INTO funds (fund_code, fund_name, category, purchase_fee_rate, status) VALUES (?, ?, ?, ?, ?)`,
    ['110011', '易方达中小盘混合', '混合型', 0.0012, 'active']
  )
  await db.run(
    `INSERT INTO funds (fund_code, fund_name, category, purchase_fee_rate, status) VALUES (?, ?, ?, ?, ?)`,
    ['000021', '华安黄金ETF联接A', 'ETF联接', 0.0012, 'active']
  )
  await db.run(
    `INSERT INTO funds (fund_code, fund_name, category, purchase_fee_rate, status) VALUES (?, ?, ?, ?, ?)`,
    ['510300', '华泰柏瑞沪深300ETF', '指数型', 0.0012, 'active']
  )

  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['110011', '2026-09-15', 8.5000, 12.3000])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['110011', '2026-09-16', 8.5500, 12.3500])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['110011', '2026-09-17', 8.6000, 12.4000])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['110011', '2026-09-15', 1.2000, 1.8500])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['110011', '2026-09-16', 1.2100, 1.8600])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['110011', '2026-09-17', 1.2200, 1.8700])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['000021', '2026-09-15', 2.1000, 2.1000])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['000021', '2026-09-16', 2.1100, 2.1100])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['000021', '2026-09-17', 2.1200, 2.1200])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['510300', '2026-09-15', 4.3000, 4.3000])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['510300', '2026-09-16', 4.3200, 4.3200])
  await db.run(`INSERT INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`, ['510300', '2026-09-17', 4.3500, 4.3500])

  let pass = 0, fail = 0
  const check = (label: string, cond: boolean) => {
    if (cond) { console.log(`  ✓ ${label}`); pass++ }
    else { console.log(`  ✗ ${label}`); fail++ }
  }

  // ═══════════════════════════════════════════════════════
  // 用例 1：初始资金 → available === 初始资金
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 用例 1：初始资金 → available === 初始资金 ===')
  // initCapital 默认金额=0（不注入），测试走显式金额的「测试专用注入路径」
  const b1 = await initCapital(100000)
  console.log(`  initial_capital=${b1.initial_capital}, cumulative_added=${b1.cumulative_added}, cash_balance=${b1.cash_balance}`)
  check('available === initial_capital', b1.available === 100000.0)
  check('consistent', b1.consistent)

  // ═══════════════════════════════════════════════════════
  // 用例 2：下单 pending → pending_committed 增加、available 同额减少
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 用例 2：下单 pending → pending_committed 增加、available 同额减少 ===')
  const r2 = await submitOrder('buy', '110011', 50000, 'human', '测试买入')
  const b2 = await getBudget()
  console.log(`  submitOrder: ${r2.orderId}, available_after=${b2.available.toFixed(2)}`)
  console.log(`  pending_committed=${b2.pending_committed.toFixed(2)}, used_in_positions=${b2.used_in_positions.toFixed(2)}`)
  check('available = 100000 - 50000 = 50000', b2.available === 50000.0)
  check('pending_committed = 50000', b2.pending_committed === 50000.0)
  check('consistent', b2.consistent)

  // ═══════════════════════════════════════════════════════
  // 用例 3：确认买入 → 建 lot、扣款、available 按公式更新
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 用例 3：确认买入 → 建 lot、扣款、available 按公式更新 ===')
  console.log('  r2.orderId:', r2.orderId)
  const r3 = await confirmOrder(r2.orderId, 'human', '确认')
  console.log('  r3:', JSON.stringify(r3))
  const b3 = await getBudget()
  console.log(`  confirmOrder: shares=${r3.shares?.toFixed(6)}, nav=${r3.nav}, lotId=${r3.lotId}`)
  console.log(`  available=${b3.available.toFixed(2)}, cash_balance=${b3.cash_balance.toFixed(2)}, used_in_positions=${b3.used_in_positions.toFixed(2)}, pending_committed=${b3.pending_committed.toFixed(2)}`)
  const netAmount3 = 50000 / (1 + 0.0012)  // 外扣法：net = amount / (1 + rate)
  const expectedShares3 = parseFloat((netAmount3 / 8.6).toFixed(6))
  check(`shares ≈ ${expectedShares3.toFixed(6)}`, Math.abs((r3.shares ?? 0) - expectedShares3) < 0.001)
  check('available = 100000 - 50000 = 50000', b3.available === 50000.0)
  check('used_in_positions ≈ 50000', Math.abs(b3.used_in_positions - 50000) < 1)
  check('pending_committed = 0', b3.pending_committed === 0)
  check('consistent', b3.consistent)

  // ═══════════════════════════════════════════════════════
  // 用例 4：确认赎回 → FIFO 消耗批次、只存 arrivalDate（不记账）
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 用例 4：确认赎回 → FIFO 消耗批次、只存 arrivalDate（不记账） ===')
  const r4submit = await submitOrder('sell', '110011', 3000, 'human', '测试卖出')
  const b4pre = await getBudget()
  console.log(`  submitOrder sell: available=${b4pre.available.toFixed(2)}, pending_committed=${b4pre.pending_committed.toFixed(2)}`)
  check('pending sell 不影响 available', b4pre.available === 50000.0)
  check('pending_committed=0（无 pending buy）', b4pre.pending_committed === 0)

  const r4 = await confirmOrder(r4submit.orderId, 'human', '卖出确认')
  const b4 = await getBudget()
  console.log(`  confirmSell: arrivalDate=${r4.arrivalDate}, cash_balance=${b4.cash_balance.toFixed(2)}, available=${b4.available.toFixed(2)}`)
  check('cash_balance 不变（赎回款未到账）', b4.cash_balance === 50000.0)
  check('available 不变', b4.available === 50000.0)
  check('consistent', b4.consistent)

  // ═══════════════════════════════════════════════════════
  // 用例 5：重复下单超额 → 拒绝
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 用例 5：重复下单超额 → 拒绝 ===')
  const r5 = await checkBeforeSubmit('buy', '110011', 60000, 'human', '超额测试')
  check('超出可用预算应被拒绝', !r5.ok)
  console.log(`  reason: ${r5.message}`)

  // ═══════════════════════════════════════════════════════
  // 用例 6：Cancel 买入 → 全额退款，available 恢复
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 用例 6：Cancel 买入 → 全额退款，available 恢复 ===')
  const r6submit = await submitOrder('buy', '110011', 10000, 'human', '测试取消')
  const b6pre = await getBudget()
  console.log(`  before cancel: available=${b6pre.available.toFixed(2)}`)
  const r6 = await cancelOrder(r6submit.orderId, '测试取消')
  const b6 = await getBudget()
  console.log(`  after cancel: available=${b6.available.toFixed(2)}, refunded=${r6.refunded}`)
  check('available 恢复 = 100000 - 50000 = 50000', b6.available === 50000.0)
  check('refunded = 10000', r6.refunded === 10000)
  check('consistent', b6.consistent)

  // ═══════════════════════════════════════════════════════
  // 用例 7：专项 — 有分红基金用 nav 算份额（不是 acc_nav）
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 用例 7：专项 — 有分红基金用 nav 算份额（不是 acc_nav） ===')
  const r7sub = await submitOrder('buy', '110011', 5000, 'human', '分红口径测试')
  const r7 = await confirmOrder(r7sub.orderId, 'human', '口径确认')
  const expectedSharesNav = parseFloat(((5000 / (1 + 0.0012)) / 8.6).toFixed(6))
  const expectedSharesAccNav = parseFloat(((5000 * (1 - 0.0012)) / 12.4).toFixed(6))
  console.log(`  用 nav=8.6 算: shares=${(r7.shares ?? 0).toFixed(6)}, 期望=${expectedSharesNav.toFixed(6)}`)
  console.log(`  若错用 acc_nav=12.4: shares=${expectedSharesAccNav.toFixed(6)}（少 ${(1 - expectedSharesAccNav/expectedSharesNav)*100}.%）`)
  check('份额按 nav=8.6 计算（不是 acc_nav=12.4）',
    Math.abs((r7.shares ?? 0) - expectedSharesNav) < 0.001)
  check('不用 acc_nav=12.4（否则份额偏小）',
    Math.abs((r7.shares ?? 0) - expectedSharesAccNav) > 0.1)

  // ═══════════════════════════════════════════════════════
  // 不变式最终验证
  // ═══════════════════════════════════════════════════════
  console.log('\n=== 不变式最终验证 ===')
  const final = await getBudget()
  console.log(`  breakdown.consistent=${final.consistent}`)
  console.log(`  available=${final.available.toFixed(2)}  cash_balance=${final.cash_balance.toFixed(2)}  pending_committed=${final.pending_committed.toFixed(2)}`)
  check('breakdown.consistent === true', final.consistent)

  const lotsAfter = await db.query<{ cost_amount: number; remaining_shares: number; shares: number }>(
    'SELECT cost_amount, remaining_shares, shares FROM lots WHERE status="active" AND source="trade"',
  )
  const totalUsedInPositions = lotsAfter.reduce((s, l) => s + l.cost_amount * l.remaining_shares / l.shares, 0)
  const totalBuyAmount = lotsAfter.reduce((s, l) => s + l.cost_amount, 0)
  console.log(`  used_in_positions=${final.used_in_positions.toFixed(2)}  lot_cost_sum=${totalUsedInPositions.toFixed(2)}  total_buy=${totalBuyAmount.toFixed(2)}`)
  check('used_in_positions ≈ Σ(lot.cost × remaining/shares)', Math.abs(final.used_in_positions - totalUsedInPositions) < 0.01)

  console.log(`\n=== 结果：✅ ${pass} 通过，❌ ${fail} 失败 ===`)
}

// 仅当直接运行（npx tsx orders.ts）才跑测试，被 import 时不触发
// 避免 verify_data_layer.ts 等场景下 _db/_metaCache 模块级状态被污染
// 说明：本项目未安装 @types/node（移动端 + Vite 浏览器侧），用 globalThis 类型断言
//       替代直接引用 process / pathToFileURL，避免 IDE / tsc 报「找不到名称」
const __proc = (globalThis as { process?: { argv?: string[]; exit?: (code: number) => void } }).process
function __argv1ToHref(argv1: string): string {
  // 把命令行绝对路径转成 file:// URL（兼容 Windows / POSIX）
  //   Windows: C:\foo\bar.ts → file:///C:/foo/bar.ts
  //   POSIX:   /foo/bar.ts   → file:///foo/bar.ts
  const abs = argv1.replace(/\\/g, '/')
  return abs.startsWith('/') ? `file://${abs}` : `file:///${abs}`
}
if (__proc?.argv?.[1] && import.meta.url === __argv1ToHref(__proc.argv[1])) {
  runTests().catch((e: unknown) => { console.error(e); __proc.exit?.(1) })
}
