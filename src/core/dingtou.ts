// ─────────────────────────────────────────────
// dingtou.ts · 定投计划（按计划、固定金额、不重复地扣款）
//
//
// 定投与灵活加仓的纪律性正好相反：
//   定投     金额**固定**（每只基金各自设定），不受分析结论影响。
//            分析只决定「投哪些基金」，不决定「投多少钱」。
//   灵活加仓 金额**完全由分析决定**，不设固定档位，唯一硬约束是不超可用预算。
//
// 幂等：同一周期（周=自然周 / 月=自然月）每只基金每个频率只投一次，
//       用 dingtou_plan.last_invested_period 记录「本期已投」的期起始日，
//       重复调用不会重复下单。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { submitOrder } from './orders.ts'

export interface DingtouPlan {
  id?: number
  fund_code: string
  fund_name?: string | null
  amount: number
  frequency: 'weekly' | 'monthly'
  weekday?: number          // 周定投：0=周一 … 6=周日
  day_of_month?: number     // 月定投：1~28
  enabled?: number
  created_at?: string
  last_invested_period?: string | null
}

export interface DingtouRunResult {
  due: number
  placed: number
  failed: number
  orders: string[]
  notes: string[]
}

function _pad(n: number): string { return String(n).padStart(2, '0') }
function _ymd(d: Date): string { return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}` }
function _nowStr(): string {
  const d = new Date()
  return `${_ymd(d)} ${_pad(d.getHours())}:${_pad(d.getMinutes())}:${_pad(d.getSeconds())}`
}
function _parse(asOf?: string): Date {
  if (asOf) {
    const [y, m, dd] = asOf.slice(0, 10).split('-').map(Number)
    return new Date(y, m - 1, dd)
  }
  const d = new Date(); d.setHours(0, 0, 0, 0); return d
}

/** 期起始日：weekly=本周一，monthly=本月 1 号 */
export function periodStart(frequency: string, asOf?: string): string {
  const d = _parse(asOf)
  if (frequency === 'monthly') return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-01`
  const wd = (d.getDay() + 6) % 7   // 周一=0
  const mon = new Date(d); mon.setDate(d.getDate() - wd)
  return _ymd(mon)
}

export async function listPlans(db: LedgerDb): Promise<DingtouPlan[]> {
  return db.query<DingtouPlan>('SELECT * FROM dingtou_plan ORDER BY enabled DESC, id DESC')
}

/** 新增或更新（同一 fund_code + frequency 唯一） */
export async function upsertPlan(db: LedgerDb, p: DingtouPlan): Promise<void> {
  const freq = p.frequency === 'monthly' ? 'monthly' : 'weekly'
  await db.run(
    `INSERT INTO dingtou_plan
       (fund_code, fund_name, amount, frequency, weekday, day_of_month, enabled, created_at, last_invested_period)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(fund_code, frequency) DO UPDATE SET
       fund_name=excluded.fund_name,
       amount=excluded.amount,
       weekday=excluded.weekday,
       day_of_month=excluded.day_of_month,
       enabled=excluded.enabled`,
    [p.fund_code, p.fund_name ?? null, p.amount, freq, p.weekday ?? 0, p.day_of_month ?? 1, p.enabled ?? 1, _nowStr()],
  )
}

export async function togglePlan(db: LedgerDb, id: number, enabled: boolean): Promise<void> {
  await db.run('UPDATE dingtou_plan SET enabled=? WHERE id=?', [enabled ? 1 : 0, id])
}

export async function deletePlan(db: LedgerDb, id: number): Promise<void> {
  await db.run('DELETE FROM dingtou_plan WHERE id=?', [id])
}

/** 今天是否该计划的扣款日（周定投仅工作日；月定投按 day_of_month） */
function _isDueDay(plan: DingtouPlan, asOf?: string): boolean {
  const d = _parse(asOf)
  const dow = d.getDay()                     // 0=周日
  if (dow === 0 || dow === 6) return false   // 周末不扣款（交易日顺延交由 navDate 处理）
  if (plan.frequency === 'weekly') {
    const wd = (dow + 6) % 7                 // 周一=0
    return wd === (plan.weekday ?? 0)
  }
  return d.getDate() === (plan.day_of_month ?? 1)
}

/**
 * 执行到期定投（幂等：本期已投则跳过）。
 * 定投金额按用户签约计划扣款（无 maxPerFund 截断），
 * 唯一硬约束 = 当期扣款不超可用（没那么多钱就是扣不出）——
 * 表现为「本期跳过 + 留痕提示」，协议本身不删不改。
 * @param opts.emergencyStop 已紧急暂停 → 整体跳过
 */
export async function executeDingtou(
  db: LedgerDb,
  asOf?: string,
  opts: { emergencyStop?: boolean } = {},
): Promise<DingtouRunResult> {
  const out: DingtouRunResult = { due: 0, placed: 0, failed: 0, orders: [], notes: [] }
  if (opts.emergencyStop) { out.notes.push('已紧急暂停，跳过本期定投'); return out }

  const plans = await listPlans(db)
  for (const plan of plans) {
    if (!plan.enabled) continue
    if (!_isDueDay(plan, asOf)) continue
    out.due++
    const period = periodStart(plan.frequency, asOf)
    if (plan.last_invested_period === period) continue   // 本期已投（幂等）

    const amt = plan.amount
    try {
      const r = await submitOrder('buy', plan.fund_code, amt, 'auto', `定投计划自动扣款（${plan.frequency}）`)
      await db.run('UPDATE dingtou_plan SET last_invested_period=?, last_result=? WHERE id=?',
        [period, `上期：已扣 ¥${amt}`, plan.id])
      out.placed++
      out.orders.push(r.orderId)
    } catch (e) {
      const raw = (e as Error)?.message || String(e)
      // 失败人话留痕（真人要知道"钱动了没有"）：余额不足 / 暂停申购 / 其它
      const human = /exceeds available|available|预算|余额/i.test(raw)
        ? '上期：因余额不足跳过'
        : /limited|closed|suspend|暂停申购|purchase_status/i.test(raw)
          ? '上期：该基金暂停申购，未执行'
          : `上期：未执行（${raw.slice(0, 40)}）`
      await db.run('UPDATE dingtou_plan SET last_result=? WHERE id=?', [human, plan.id])
      out.failed++
      out.notes.push(`${plan.fund_code}: ${human}`)
    }
  }
  return out
}
