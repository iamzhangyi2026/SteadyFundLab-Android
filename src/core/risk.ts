// ─────────────────────────────────────────────
// risk.ts · 组合风险分析
//
//
// 两份系统隔离：本模块只分析**真实持仓**组合
// （lots.buy_order_id LIKE 'ocr-import-%'，即「持仓」页那只用户真实持有的组合）。
// 交易页的「练手池 / 虚拟持仓」不计入此处（与持仓页口径一致）。
//
// 两个维度：
//   1. 持仓集中度 —— 按各基金市值占组合比例：单一最大 / 前三大 / HHI / 等效持仓数。
//   2. 行业暴露   —— 每只基金取最新报告期行业配置（fund_holdings·industry_alloc），
//                    按该基金占组合市值比例加权，聚合成组合级行业分布。
//
// 口径：市值用**单位净值 nav**（与 fetchPositions / portfolioState 一致）；
// 数据缺失（无 nav / 无行业配置）→ 明确标「数据缺失」，绝不编造。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

// ─── 类型 ──────────────────────────────────────────────────────────

export interface RiskPosition {
  fund_code: string
  fund_name: string | null
  category: string | null
  market_value: number | null      // 当前市值（nav × 份额），无 nav 则为 null
  cost_amount: number              // 导入成本（= 导入时市值）
  weight_pct: number | null        // 占组合市值比例（%）
  profit_pct: number | null        // 浮动收益率（%）
}

export interface ConcentrationResult {
  ok: boolean
  reason?: string
  positions: RiskPosition[]        // 按权重降序
  total_market_value: number
  top1_weight: number
  top3_weight: number
  hhi: number                      // 赫芬达尔指数（0–10000）
  effective_n: number              // 等效持仓数 = 1 / Σ(w²)
  flags: string[]
  level: 'ok' | 'warn' | 'high'
}

export interface IndustryExposureRow {
  industry: string
  weight_pct: number               // 占组合市值比例（%）
}

export interface IndustryExposureResult {
  ok: boolean
  reason?: string
  exposure: IndustryExposureRow[]
  coverage: { with_data: number; total: number }
  top_industry: string
  top_weight: number
  flags: string[]
  level: 'ok' | 'warn' | 'high'
}

export interface RiskThresholds {
  single_max_pct: number
  top3_max_pct: number
  effective_n_warn: number
  effective_n_high: number
  industry_max_pct: number
}

export interface RiskReport {
  ok: boolean
  reason?: string
  scope: 'real'
  total_market_value: number
  positions_count: number
  concentration: ConcentrationResult
  industry: IndustryExposureResult
  thresholds: RiskThresholds
}

// ─── 阈值（策略类，可调）─────────────────────────────────────────
// 单一持仓 > 40% / 前三大 > 60% / 等效持仓 ≤ 3 只(高) ≤ 5 只(略集中) / 单一行业 > 30%
export const RISK_ANALYSIS_CONFIG: RiskThresholds = {
  single_max_pct: 40,
  top3_max_pct: 60,
  effective_n_warn: 5,
  effective_n_high: 3,
  industry_max_pct: 30,
}

const r2 = (x: number) => Math.round(x * 100) / 100

// ─── 1. 真实持仓聚合（带市值）──────────────────────────────────

/** 读取真实持仓的聚合持仓（按 fund_code 合并），市值用最新单位净值 × 份额。 */
export async function loadRealPositions(db: LedgerDb): Promise<RiskPosition[]> {
  const rows = await db.query<{
    fund_code: string
    fund_name: string | null
    category: string | null
    remaining_shares: number
    cost_amount: number
    current_nav: number | null
  }>(
    `SELECT l.fund_code, f.fund_name, f.category,
            l.remaining_shares, l.cost_amount,
            (SELECT nav FROM nav_daily WHERE fund_code=l.fund_code ORDER BY nav_date DESC LIMIT 1) AS current_nav
     FROM lots l
     LEFT JOIN funds f ON f.fund_code = l.fund_code
     WHERE l.status='active' AND l.source='real'`,
    [],
  )

  const map = new Map<string, {
    fund_code: string; fund_name: string | null; category: string | null
    shares: number; cost: number; nav: number | null
  }>()
  for (const r of rows) {
    if (!map.has(r.fund_code)) {
      map.set(r.fund_code, {
        fund_code: r.fund_code, fund_name: r.fund_name, category: r.category,
        shares: 0, cost: 0, nav: r.current_nav,
      })
    }
    const g = map.get(r.fund_code)!
    g.shares += r.remaining_shares ?? 0
    g.cost += r.cost_amount ?? 0
    if (r.current_nav != null) g.nav = r.current_nav
  }

  const positions: RiskPosition[] = []
  for (const g of map.values()) {
    const mv = (g.nav && g.shares) ? g.nav * g.shares : null
    const profit_pct = (mv != null && g.cost > 0) ? (mv - g.cost) / g.cost * 100 : null
    positions.push({
      fund_code: g.fund_code,
      fund_name: g.fund_name,
      category: g.category,
      market_value: mv != null ? r2(mv) : null,
      cost_amount: r2(g.cost),
      weight_pct: null,
      profit_pct: profit_pct != null ? r2(profit_pct) : null,
    })
  }
  return positions
}

// ─── 2. 集中度计算（纯函数）────────────────────────────────────

export function computeConcentration(
  positions: RiskPosition[],
  t: RiskThresholds,
): ConcentrationResult {
  const valued = positions.filter(p => p.market_value != null && p.market_value > 0)
  const total = valued.reduce((s, p) => s + (p.market_value as number), 0)

  if (valued.length === 0 || total <= 0) {
    return {
      ok: false, reason: '没有可计算市值的真实持仓',
      positions: [], total_market_value: 0,
      top1_weight: 0, top3_weight: 0, hhi: 0, effective_n: 0,
      flags: [], level: 'ok',
    }
  }

  const ranked = valued
    .map(p => ({ ...p, weight_pct: r2((p.market_value as number) / total * 100) }))
    .sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0))

  // 把算出的占比写回原 positions（供 UI 整列展示）
  for (const rp of ranked) {
    const orig = positions.find(p => p.fund_code === rp.fund_code)
    if (orig) orig.weight_pct = rp.weight_pct
  }

  const top1 = ranked[0].weight_pct ?? 0
  const top3 = r2(ranked.slice(0, 3).reduce((s, p) => s + (p.weight_pct ?? 0), 0))
  const sumSq = ranked.reduce((s, p) => s + Math.pow((p.weight_pct ?? 0) / 100, 2), 0)
  const hhi = r2(sumSq * 10000)
  const effective_n = sumSq > 0 ? r2(1 / sumSq) : 0

  const flags: string[] = []
  let level: ConcentrationResult['level'] = 'ok'
  if (top1 > t.single_max_pct) {
    flags.push(`单一持仓「${ranked[0].fund_name || ranked[0].fund_code}」占比 ${top1}%，超过 ${t.single_max_pct}% 警戒线`)
    level = 'high'
  }
  if (top3 > t.top3_max_pct) {
    flags.push(`前三大持仓合计 ${top3}%，超过 ${t.top3_max_pct}% 警戒线`)
    if (level !== 'high') level = 'warn'
  }
  if (effective_n > 0 && effective_n <= t.effective_n_high) {
    flags.push(`等效持仓仅 ${effective_n} 只，组合高度集中`)
    level = 'high'
  } else if (effective_n > 0 && effective_n <= t.effective_n_warn) {
    flags.push(`等效持仓仅 ${effective_n} 只，略显集中`)
    if (level === 'ok') level = 'warn'
  }

  return {
    ok: true, positions: ranked, total_market_value: r2(total),
    top1_weight: top1, top3_weight: top3, hhi, effective_n, flags, level,
  }
}

// ─── 3. 行业暴露（读库 + 加权聚合）────────────────────────────

/** 读取每只基金最新报告期的行业配置（fund_holdings·industry_alloc）。 */
export async function loadIndustryAlloc(
  db: LedgerDb,
  fundCodes: string[],
): Promise<Map<string, { industry: string; weight: number }[]>> {
  const result = new Map<string, { industry: string; weight: number }[]>()
  if (fundCodes.length === 0) return result

  const placeholders = fundCodes.map(() => '?').join(',')
  const rows = await db.query<{
    fund_code: string; industry: string; weight: number; report_date: string
  }>(
    `SELECT fund_code, COALESCE(industry, stock_code) AS industry, weight, report_date
     FROM fund_holdings
     WHERE source='industry_alloc' AND fund_code IN (${placeholders})
     ORDER BY fund_code, report_date DESC, weight DESC`,
    fundCodes,
  )

  // 每个基金只取最新报告期
  const latestDate = new Map<string, string>()
  for (const r of rows) {
    if (!latestDate.has(r.fund_code)) latestDate.set(r.fund_code, r.report_date)
  }
  for (const r of rows) {
    if (r.report_date !== latestDate.get(r.fund_code)) continue
    if (!r.industry) continue
    if (!result.has(r.fund_code)) result.set(r.fund_code, [])
    result.get(r.fund_code)!.push({ industry: r.industry, weight: Number(r.weight) || 0 })
  }
  return result
}

export function computeIndustryExposure(
  positions: RiskPosition[],
  industryByFund: Map<string, { industry: string; weight: number }[]>,
  t: RiskThresholds,
): IndustryExposureResult {
  const valued = positions.filter(p => p.market_value != null && p.market_value > 0)
  const total = valued.reduce((s, p) => s + (p.market_value as number), 0)
  if (total <= 0) {
    return {
      ok: false, reason: '没有可计算市值的真实持仓',
      exposure: [], coverage: { with_data: 0, total: 0 },
      top_industry: '', top_weight: 0, flags: [], level: 'ok',
    }
  }

  const merged: Record<string, number> = {}
  let withData = 0
  for (const p of valued) {
    const alloc = industryByFund.get(p.fund_code)
    if (!alloc || alloc.length === 0) continue
    withData++
    const wpct = (p.market_value as number) / total * 100   // 该基金占组合比例
    for (const a of alloc) {
      // a.weight = 该基金内行业占比(%)；对组合贡献 = wpct × a.weight/100
      merged[a.industry] = (merged[a.industry] ?? 0) + wpct * a.weight / 100
    }
  }

  if (withData === 0) {
    return {
      ok: false,
      reason: '行业配置数据缺失（需联网抓取；可在基金详情页刷新，或点本页「补全行业数据」）',
      exposure: [], coverage: { with_data: 0, total: valued.length },
      top_industry: '', top_weight: 0, flags: [], level: 'ok',
    }
  }

  const exposure = Object.entries(merged)
    .map(([industry, weight]) => ({ industry, weight_pct: r2(weight) }))
    .sort((a, b) => b.weight_pct - a.weight_pct)

  const top = exposure[0] ?? { industry: '', weight_pct: 0 }
  const flags: string[] = []
  let level: IndustryExposureResult['level'] = 'ok'
  if (top.weight_pct > t.industry_max_pct) {
    flags.push(`单一行业「${top.industry}」占组合 ${top.weight_pct}%，超过 ${t.industry_max_pct}% 警戒线`)
    level = 'high'
  }
  return {
    ok: true, exposure, coverage: { with_data: withData, total: valued.length },
    top_industry: top.industry, top_weight: top.weight_pct, flags, level,
  }
}

// ─── 4. 编排 ──────────────────────────────────────────────────────

export async function riskReport(db: LedgerDb): Promise<RiskReport> {
  const t = RISK_ANALYSIS_CONFIG
  const positions = await loadRealPositions(db)
  if (positions.length === 0) {
    const emptyConc: ConcentrationResult = {
      ok: false, reason: '无持仓', positions: [], total_market_value: 0,
      top1_weight: 0, top3_weight: 0, hhi: 0, effective_n: 0, flags: [], level: 'ok',
    }
    const emptyInd: IndustryExposureResult = {
      ok: false, reason: '无持仓', exposure: [], coverage: { with_data: 0, total: 0 },
      top_industry: '', top_weight: 0, flags: [], level: 'ok',
    }
    return {
      ok: false, reason: '还没有真实持仓，先去「持仓」页导入真实持仓截图',
      scope: 'real', total_market_value: 0, positions_count: 0,
      concentration: emptyConc, industry: emptyInd, thresholds: t,
    }
  }

  const concentration = computeConcentration(positions, t)
  const industryByFund = await loadIndustryAlloc(db, positions.map(p => p.fund_code))
  const industry = computeIndustryExposure(positions, industryByFund, t)

  return {
    ok: true,
    scope: 'real',
    total_market_value: concentration.total_market_value,
    positions_count: positions.length,
    concentration,
    industry,
    thresholds: t,
  }
}
