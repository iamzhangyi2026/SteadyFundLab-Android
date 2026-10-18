/**
 * 费率计算模块 · src/core/fees.ts
 *
 * 约定：
 *   calcPurchase 的 alreadyDiscounted 参数表示费率已折后
 *   penaltyFreeDays() 是罚期门槛的唯一来源
 */
import { PURCHASE_DISCOUNT, REDEEM_TIERS } from './config.js'

/** 赎回费档位（含罚期标记） */
export interface RedeemTier {
  /** 上限天数（命中条件：days < maxHoldingDays） */
  maxHoldingDays: number
  /** 费率（小数，如 0.015 = 1.5%） */
  rate: number
  /** 是否惩罚档（罚期门槛的唯一来源） */
  penalty?: boolean
  /** 说明 */
  note?: string
}

/** previewRedeemFee 的返回值 */
export interface RedeemPreview {
  holdingDays: number
  redeemAmount: number
  feeRate: number
  fee: number
  isPenalty: boolean
  daysToPenaltyFree: number
  netAmount: number
}

// ─────────────────────────────────────────────
// ① calcPurchase — 外扣法
// ─────────────────────────────────────────────
/**
 * 计算申购费用与净申购金额（外扣法）。
 *
 * @param amount           申购金额（元）
 * @param rawRate          基金原始申购费率（小数，如 0.015 表示 1.5%）
 * @param discount         渠道折扣（如 0.125 表示 1.25 折），None 时从配置读取
 * @param alreadyDiscounted  申购费率已是折后值（渠道数据已打折）
 *                           为 true 时不乘 discount，避免二次打折少收 87.5%
 */
export function calcPurchase(
  amount: number,
  rawRate: number,
  discount: number | undefined = undefined,
  alreadyDiscounted: boolean = false
): [number, number] {
  if (discount === undefined) discount = PURCHASE_DISCOUNT
  if (amount <= 0) return [0, 0]
  if (rawRate == null || rawRate <= 0) return [0, amount]

  const rate = alreadyDiscounted ? rawRate : rawRate * discount
  const netAmount = amount / (1 + rate)
  const fee = amount - netAmount
  return [fee, netAmount]
}

// ─────────────────────────────────────────────
// ② holdingDays — 自然日差
// ─────────────────────────────────────────────
/**
 * 计算持有天数，按自然日（不是交易日）。
 * 证监会规定的「持续持有期少于 7 日」指自然日。
 */
export function holdingDays(confirmDate: Date, redeemNavDate: Date): number {
  const MS_PER_DAY = 86400000
  // 转 UTC 午夜消除时区干扰
  const a = Date.UTC(confirmDate.getFullYear(), confirmDate.getMonth(), confirmDate.getDate())
  const b = Date.UTC(redeemNavDate.getFullYear(), redeemNavDate.getMonth(), redeemNavDate.getDate())
  return Math.round((b - a) / MS_PER_DAY)
}

// ─────────────────────────────────────────────
// ③ redeemFeeRate — 按持有天数查费率
// ─────────────────────────────────────────────
/**
 * 按持有天数查赎回费率。
 *
 * @returns [rate, isPenalty]
 *   isPenalty 为 true 表示触发惩罚性费率，界面需高亮警示。
 */
export function redeemFeeRate(days: number, tiers: RedeemTier[] | undefined = undefined): [number, boolean] {
  const list = tiers ?? REDEEM_TIERS
  for (const t of list) {
    if (days < t.maxHoldingDays) {
      return [t.rate, days < penaltyFreeDays(tiers)]
    }
  }
  return [0, false]
}

// ─────────────────────────────────────────────
// ④ calcRedeem — 赎回费用
// ─────────────────────────────────────────────
/**
 * 计算赎回费用。
 *
 * @param redeemAmount  赎回金额（份额 × 成交净值），不是份额本身
 * @param days          持有天数（自然日）
 * @param tiers         自定义费率档位，缺省用配置
 */
export function calcRedeem(
  redeemAmount: number,
  days: number,
  tiers: RedeemTier[] | undefined = undefined
): [number, number, boolean] {
  const [rate, isPenalty] = redeemFeeRate(days, tiers)
  const fee = redeemAmount * rate
  return [fee, rate, isPenalty]
}

// ─────────────────────────────────────────────
// ⑤ previewRedeemFee — 赎回前预览
// ─────────────────────────────────────────────
/**
 * 赎回费预览。供界面在用户点「赎回」前展示，避免误触惩罚性费率。
 */
export function previewRedeemFee(
  shares: number,
  nav: number,
  confirmDate: Date,
  redeemNavDate: Date,
  tiers?: RedeemTier[]
): RedeemPreview {
  const days = holdingDays(confirmDate, redeemNavDate)
  const amount = shares * nav
  const [fee, rate, isPenalty] = calcRedeem(amount, days, tiers)
  return {
    holdingDays: days,
    redeemAmount: Math.round(amount * 100) / 100,
    feeRate: rate,
    fee: Math.round(fee * 100) / 100,
    isPenalty,
    daysToPenaltyFree: Math.max(0, penaltyFreeDays(tiers) - days),
    netAmount: Math.round((amount - fee) * 100) / 100,
  }
}

// ─────────────────────────────────────────────
// ⑥ penaltyFreeDays — 罚期门槛唯一来源
// ─────────────────────────────────────────────
/**
 * 从 tiers 中 penalty === true 那档派生免罚门槛。
 *
 * 罚期门槛（默认 7 天）曾散落在多处，现唯一来源在此。
 * 任何「还需几天免罚」都必须调此函数，禁止硬编码 7。
 */
export function penaltyFreeDays(tiers: RedeemTier[] | undefined = undefined): number {
  const list = tiers ?? REDEEM_TIERS
  const hit = list.find((t) => (t as { penalty?: boolean }).penalty === true)
  return hit ? hit.maxHoldingDays : 7
}

// ─────────────────────────────────────────────
// ⑦ calcRedeemFee — 赎回手续费（orders.py 调用入口）
// ─────────────────────────────────────────────
/**
 * 计算赎回手续费。
 *
 * @param grossAmount 赎回总金额（份额 × 成交净值）
 * @param feeRate     费率（小数）。为 0 或 null 时返回 0（模拟不收费基金）。
 */
export function calcRedeemFee(grossAmount: number, _redeemNav: number, _category: string, feeRate: number): number {
  if (!feeRate || feeRate <= 0) return 0
  return Math.round(grossAmount * feeRate * 100) / 100
}

// ─────────────────────────────────────────────
// 演示入口（Node 运行：npx tsx src/core/fees.ts）
// ─────────────────────────────────────────────
if (import.meta.url && new URL(import.meta.url).pathname.endsWith('/fees.ts')) {
  // __main__ 风格演示
  console.log('=== 用例 1：申购费（标准外扣法）===')
  let [fee, net] = calcPurchase(1000, 0.015, 0.125, false)
  console.log(`  输入: amount=1000, rawRate=0.015, discount=0.125`)
  console.log(`  rate = 0.015 × 0.125 = 0.001875`)
  console.log(`  net  = 1000 / 1.001875 = ${net.toFixed(4)}...`)
  console.log(`  fee  = 1000 − ${net.toFixed(4)} = ${fee.toFixed(4)}...`)
  console.log(`  期望: fee ≈ 1.87, net ≈ 998.13`)
  console.log()

  console.log('=== 用例 2：折后费率===')
  ;[fee, net] = calcPurchase(1000, 0.0008, undefined, true)
  console.log(`  输入: amount=1000, rawRate=0.0008, alreadyDiscounted=true`)
  console.log(`  rate = 0.0008（不再乘 0.125）`)
  console.log(`  net  = 1000 / 1.0008 = ${net.toFixed(4)}...`)
  console.log(`  fee  = ${fee.toFixed(4)}...`)
  console.log(`  期望: fee ≈ 0.80`)
  console.log(`  ❌ 若输出 ≈ 0.10 → 说明漏了 alreadyDiscounted`)
  console.log()

  console.log('=== 用例 3：赎回费阶梯 + 罚期 ===')
  const redeemAmount = 10000
  for (const d of [3, 6, 7, 30, 365, 800]) {
    const [r, p] = redeemFeeRate(d)
    const flag = p ? '  ← 惩罚档' : ''
    console.log(`  持有 ${d} 天 → 费率 ${(r * 100).toFixed(2)}%  → ${(r * redeemAmount).toFixed(2)} 元${flag}`)
  }
  console.log(`  penaltyFreeDays() → ${penaltyFreeDays()}`)
}
