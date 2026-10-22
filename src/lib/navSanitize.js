// src/lib/navSanitize.js · 净值序列异常跳变检测
// ------------------------------------------------------------
// 数据源偶发会把净值口径整个换掉（例如债券基金单日跳到三倍），
// 不拦住的话组合收益会算出严重失真的数。
//
// 处理原则（不可信的数据不编造、不显示）：
//   - 不擅自缩放还原（无法从外部确认是份额合并还是数据错误）
//   - 检出跳变点后，凡区间跨越跳变的收益类指标一律降级为「不可信」
//   - UI 明确给出跳变日期与前后数值，让用户自己判断
//
// 阈值 50%：正常公募单日涨跌上限约 ±10%（个股涨跌停传导），债券基金
// 在 ±1% 量级；唯一可能超过 50% 的是份额拆分/合并的口径事件。

/** 默认单日跳变阈值（%） */
export const JUMP_THRESHOLD = 50

/**
 * 检测净值序列中的异常跳变点
 * @param {Array<{date:string, nav:number}>} hist 按日期升序
 * @param {number} [threshold=50] 单日 |涨跌幅| 百分比阈值
 * @returns {Array<{date:string, prevDate:string, from:number, to:number, pct:number}>}
 */
export function detectJumps(hist, threshold = JUMP_THRESHOLD) {
  if (!Array.isArray(hist) || hist.length < 2) return []
  const out = []
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1]
    const b = hist[i]
    if (!a || !b) continue
    const pa = Number(a.nav)
    const pb = Number(b.nav)
    if (!Number.isFinite(pa) || !Number.isFinite(pb) || pa <= 0) continue
    const pct = ((pb / pa) - 1) * 100
    if (Math.abs(pct) >= threshold) {
      out.push({
        date: b.date,
        prevDate: a.date,
        from: pa,
        to: pb,
        pct: +pct.toFixed(2),
      })
    }
  }
  return out
}

/**
 * 区间 [fromDate, toDate] 是否被跳变点破坏（闭区间，含端点跨越）
 * @returns {null | {date:string, prevDate:string, from:number, to:number, pct:number}}
 */
export function jumpInRange(hist, fromDate, toDate, threshold = JUMP_THRESHOLD) {
  for (const j of detectJumps(hist, threshold)) {
    if (j.date > fromDate && j.date <= toDate) return j
    if (j.date >= fromDate && j.date < toDate) return j
  }
  return null
}
