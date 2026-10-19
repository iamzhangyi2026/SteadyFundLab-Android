// src/lib/holdingsModel.js · 统一持仓模型
// ------------------------------------------------------------
// 真实持仓与模拟持仓的账本结构不一样：
//   真实：amount 是**市值快照**，成本 = 市值 ÷ (1 + 收益率%)，份额可能缺失
//   模拟：amount 是**申购投入额**（就是成本），份额一定有
// 直接混用会把成本算错。这里统一成一套字段，供组合分析与各面板复用：
//
//   统一行 = { source:'real'|'sim', code, name, shares, cost, mv, live,
//              created_at, nav_at_import, pnl, pnlPct, estPnl }
//
// 口径：
//   - mv = 当前市值；cost = 累计投入成本；pnl = mv − cost
//   - estPnl（当日估算收益）按盘中/盘后两种净值基准分开算，与 realLedger.calcHolding 一致

import { calcHolding } from './realLedger.js'

/** 盈亏与当日估算收益（统一口径） */
export function pnlOf(row) {
  const pnl = row.mv != null && row.cost != null ? row.mv - row.cost : null
  const pnlPct = pnl != null && row.cost ? (pnl / row.cost) * 100 : null
  const pct = row.live?.pct ?? null
  const estPnl =
    row.mv != null && pct != null
      ? row.live?.pnlBase === 'yesterday'
        ? (row.mv * pct) / 100
        : (row.mv * pct) / (100 + pct)
      : null
  return { pnl, pnlPct, estPnl }
}

/**
 * 真实持仓行 → 统一行
 * @param {object} r 账本行（可带 live）
 */
export function fromRealRow(r) {
  const c = calcHolding(r)
  return {
    source: 'real',
    code: r.code,
    name: r.name,
    shares: r.shares != null ? Number(r.shares) : null,
    cost: c.cost,
    mv: c.mv,
    live: r.live ?? null,
    created_at: r.created_at || '',
    nav_at_import: r.nav_at_import != null ? Number(r.nav_at_import) : null,
  }
}

/**
 * 模拟持仓聚合行 → 统一行
 * @param {object} agg simHoldingByCode 的一行 {code,name,shares,amount,fee}
 * @param {object|null} live fetchHoldingsLive 返回的行情
 */
export function fromSimRow(agg, live = null) {
  const shares = agg.shares != null ? Number(agg.shares) : null
  const cost = agg.amount != null ? Number(agg.amount) : null
  const nav = live?.nav ?? null
  const mv = shares != null && nav != null ? shares * nav : null
  return {
    source: 'sim',
    code: agg.code,
    name: agg.name,
    shares,
    cost,
    mv,
    live,
    created_at: agg.created_at || agg.latest_created_at || '',
    nav_at_import: null,
  }
}

/** 批量转换 + 补盈亏字段 */
export function decorate(rows) {
  return rows.map((r) => ({ ...r, ...pnlOf(r) }))
}
