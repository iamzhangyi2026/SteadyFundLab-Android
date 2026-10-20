/**
 * 费率计算：申购费（外扣法）、赎回费（自然日阶梯）、FIFO 批次赎回。
 * 阶梯规则依据证监会规定，全渠道统一执行。
 */

// 赎回费阶梯（对应 config.toml 的 [[fee.redeem_tiers]]）
// 依据：证监会规定，全渠道统一执行
export const REDEEM_TIERS = [
  { maxHoldingDays: 7, rate: 0.015, penalty: true },   // <7 天：惩罚性
  { maxHoldingDays: 30, rate: 0.0075 },                // 7–30 天
  { maxHoldingDays: 365, rate: 0.005 },                // 30 天–1 年
  { maxHoldingDays: 730, rate: 0.0025 },               // 1–2 年
  { maxHoldingDays: Infinity, rate: 0 },               // ≥2 年
]

// 申购费渠道折扣。支付宝是「部分基金 1.25 折起」，不是全部 1 折
export const PURCHASE_DISCOUNT = 0.125

/**
 * 申购费（外扣法）
 *
 * 净申购金额 = 申购金额 / (1 + 实际费率)
 *
 * 为什么不是 amount × rate：
 *   外扣法下 amount 是含费总额，费用包含在里面。
 *   内扣法会多算一点点，比例虽小但长期累积会影响回测精度。
 *
 * ⚠️ 参数口径：`rawRate` 必须是**原始费率**（接口 `fund_sourceRate`）。
 *   若传入的已是折后费率（接口 `fund_Rate` / `d.rate`），必须显式传 `discount=1`，
 *   否则会二次打折——当前调用方（Detail / simLedger）已用 `hasDiscounted` 守卫。
 */
export function calcPurchase(amount, rawRate, discount = PURCHASE_DISCOUNT) {
  if (amount <= 0) return { fee: 0, netAmount: 0, rate: 0 }
  if (!rawRate || rawRate <= 0) return { fee: 0, netAmount: amount, rate: 0 }
  const rate = rawRate * discount
  const netAmount = amount / (1 + rate)
  return { fee: amount - netAmount, netAmount, rate }
}

/**
 * 持有天数 —— 按自然日，不是交易日。
 *
 * 这是最容易搞错的地方：周一确认、下周一赎回 = 持有 7 个自然日，
 * 刚好跨过惩罚线。按交易日算会得出 5 天，费率算错一个档位。
 */
export function holdingDays(confirmDate, redeemDate) {
  const a = new Date(confirmDate)
  const b = new Date(redeemDate)
  return Math.floor((b - a) / 86400000)
}

/**
 * 按持有天数查赎回费率。
 * 判定逻辑：阶梯按 maxHoldingDays 升序排列，命中第一条即返回。
 */
export function redeemFeeRate(days) {
  for (const t of REDEEM_TIERS) {
    if (days < t.maxHoldingDays) {
      return { rate: t.rate, isPenalty: !!t.penalty }
    }
  }
  return { rate: 0, isPenalty: false }
}

/** 免罚门槛（自然日）：取罚期档的 maxHoldingDays，不在代码里写死 7 */
export function penaltyFreeDays() {
  const t = REDEEM_TIERS.find((x) => x.penalty)
  return t ? t.maxHoldingDays : 0
}

/**
 * FIFO 赎回 —— 按份额批次消耗，逐批算费率。
 * （公共 API：赎回试算接入时用；当前 UI 只用单档 redeemFeeRate）
 *
 * 为什么必须逐批而不是整体算：
 *   各批次持有天数不同，费率档位就不同。整体算必然错。
 *
 *   1 号买 1 万、10 号买 1 万、15 号赎回 1 万：
 *     正确（FIFO）   → 消耗 1 号批次，持有 14 天，费率 0.5%
 *     错误（平均成本）→ 天数被摊成 7 天，费率跳到 1.5%
 *   费用差 3 倍，回测结果完全不可信。
 *
 * @param lots         份额批次数组 [{ confirmDate, remainingShares }]
 * @param redeemShares 要赎回的份额；传 0 或负数 = 全部赎回
 * @param redeemDate   赎回成交日（YYYY-MM-DD）
 * @param nav          成交单位净值
 */
export function consumeLots(lots, redeemShares, redeemDate, nav) {
  const active = [...lots]
    .filter((l) => l.remainingShares > 0)
    .sort((a, b) => new Date(a.confirmDate) - new Date(b.confirmDate))

  const totalShares = active.reduce((s, l) => s + l.remainingShares, 0)
  let remaining =
    redeemShares > 0 ? Math.min(redeemShares, totalShares) : totalShares

  const consumed = []
  for (const lot of active) {
    if (remaining <= 1e-9) break
    const take = Math.min(lot.remainingShares, remaining)
    const days = Math.max(0, holdingDays(lot.confirmDate, redeemDate))
    const amount = take * nav
    const { rate, isPenalty } = redeemFeeRate(days)

    consumed.push({
      confirmDate: lot.confirmDate,
      shares: round(take, 4),
      holdingDays: days,
      feeRate: rate,
      fee: round(amount * rate, 2),
      isPenalty,
      amount: round(amount, 2),
      netAmount: round(amount - amount * rate, 2),
      daysToPenaltyFree: Math.max(0, penaltyFreeDays() - days),
    })
    remaining -= take
  }

  const gross = consumed.reduce((s, d) => s + d.amount, 0)
  const feeTotal = consumed.reduce((s, d) => s + d.fee, 0)

  return {
    lots: consumed,
    gross: round(gross, 2),
    fee: round(feeTotal, 2),
    netAmount: round(gross - feeTotal, 2),
    effectiveRate: gross > 0 ? feeTotal / gross : 0,
    isPenalty: consumed.some((d) => d.isPenalty),
  }
}

function round(v, n) {
  const p = Math.pow(10, n)
  return Math.round(v * p) / p
}
