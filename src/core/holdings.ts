// ─────────────────────────────────────────────
// holdings.ts · 持仓穿透分析与可投范围校验
//
//
// 三件事：
//   1. 可投范围校验（场外 vs 场内）—— 名称含 ETF 但无「联接」则拒绝
//   2. 行业暴露穿透 —— 从 industry_allocation 接口聚合，判断集中度
//   3. 风格漂移 / 重叠度 —— 名称宣称方向 vs 实际持仓；两只基金前十大重叠判定
// ─────────────────────────────────────────────

import { UNIVERSE_CONFIG, ANALYSIS_CONFIG } from './config.ts'

// ─── 类型 ──────────────────────────────────────────────────────────

export interface IndustryAllocRow {
  industry: string
  weight: number      // 占净值比例（%）
  report_date: string // 'YYYY-MM-DD'
}

export interface FundStockRow {
  stock_code: string
  stock_name: string
  weight_pct?: number
  report_date?: string
}

export interface ExposureReport {
  fund_code: string
  report_date: string
  allocation: Array<{ industry: string; weight: number }>  // 按占比降序
  top_industry: string
  top_weight: number
  concentrated: boolean
  note: string
}

export interface DriftReport {
  claimed_industry: string | null
  actual_pct: number
  threshold: number
  drifted: boolean
  note: string
}

export interface OverlapReport {
  overlap_count: number
  overlapped: boolean
  stocks: Array<{ stock_code: string; stock_name: string }>
}

// ─── 1. 可投范围校验 ─────────────────────────────────────────────

/**
 * 校验一只基金能否在本系统交易（只买场外，不买场内 ETF/REITs）。
 * 判定顺序：禁止名单 → 模糊词校验 → 允许名单
 */
export function checkTradable(fundType: string, fundName: string): [ok: boolean, reason: string] {
  const allowed = UNIVERSE_CONFIG.allowed_types
  const forbidden = UNIVERSE_CONFIG.forbidden_types
  const ambiguous = UNIVERSE_CONFIG.ambiguous_keywords

  const ft = (fundType ?? '').trim()
  const fn = (fundName ?? '').trim()

  // 1. 空类型直接拒绝（防止 forbidden.includes('') 误命中所有禁止项）
  if (!ft) {
    return [false, '缺少类型字段，无法确认是否场外品种，拒绝加入']
  }

  // 2. 明确禁止的品类
  for (const f of forbidden) {
    if (f && f.includes(ft)) {
      return [false, `类型「${ft}」在禁止名单内（需要股票账户或非公募场外品种）`]
    }
  }

  // 2. 名称含 ETF 但没有「联接」字样 → 极可能是场内品种
  for (const kw of ambiguous) {
    if (kw && fn.includes(kw) && !fn.includes('联接')) {
      return [false,
        `名称含「${kw}」但无「联接」字样，可能是场内品种（需股票账户）。` +
        `场外可买的是「XX${kw}联接」，请人工确认后再加入自选池`
      ]
    }
  }

  // 3. 类型必须在允许名单内
  if (allowed.length > 0) {
    const match = allowed.some(a => ft.includes(a) && a.length > 0)
    if (!match) {
      return [false, `类型「${ft}」不在可投范围 ${JSON.stringify(allowed)} 内`]
    }
  }

  return [true, 'ok']
}

// ─── 2. 行业暴露穿透 ──────────────────────────────────────────────

/**
 * 分析一只基金的真实行业暴露（从已入库的行业配置数据聚合）。
 *
 * 数据来源：sqlite_fetcher.fetchIndustryAllocation → 写 fund_holdings(source='industry_alloc')
 * 本函数从 DB 读取并聚合，不做网络请求。
 */
export function analyzeExposure(fundCode: string, allocRows: IndustryAllocRow[]): ExposureReport {
  if (allocRows.length === 0) {
    return { fund_code: fundCode, allocation: [], note: '未抓到行业配置',
      report_date: '', top_industry: '', top_weight: 0, concentrated: false }
  }

  // 按行业名聚合（同一行业可能有多条记录）
  const merged: Record<string, number> = {}
  for (const a of allocRows) {
    merged[a.industry] = (merged[a.industry] ?? 0) + a.weight
  }

  const ranked = Object.entries(merged)
    .map(([industry, weight]) => ({ industry, weight: Math.round(weight * 100) / 100 }))
    .sort((a, b) => b.weight - a.weight)

  const limit = ANALYSIS_CONFIG.concentration_warn_pct
  const top = ranked[0] ?? { industry: '', weight: 0 }
  const reportDate = allocRows[0]?.report_date ?? ''

  return {
    fund_code: fundCode,
    report_date: reportDate,
    allocation: ranked,
    top_industry: top.industry,
    top_weight: top.weight,
    concentrated: top.weight >= limit,
    note: `最大单一行业「${top.industry}」占 ${top.weight}%，` +
          `${top.weight >= limit ? '已超过' : '未超过'}集中度阈值 ${limit}%`,
  }
}

// ─── 3. 风格漂移检测 ──────────────────────────────────────────────

/**
 * 检测风格漂移：名称宣称的方向 vs 实际持仓。
 * 若实际持仓中该方向占比低于阈值，判定为漂移。
 */
export function detectStyleDrift(
  fundName: string,
  allocation: Array<{ industry: string; weight: number }>,
  threshold?: number,
): DriftReport {
  const hints = ANALYSIS_CONFIG.name_industry_hints
  const warnThreshold = threshold ?? ANALYSIS_CONFIG.drift_warn_pct

  let claimed: string | null = null
  let keywords: string[] = []
  for (const h of hints) {
    for (const kw of h.keywords) {
      if (kw && fundName.includes(kw)) {
        claimed = h.industry
        keywords = [...h.keywords]
        break
      }
    }
    if (claimed) break
  }

  if (!claimed) {
    return {
      claimed_industry: null,
      actual_pct: 0,
      threshold: warnThreshold,
      drifted: false,
      note: '名称中没有明确的行业指向词，不做漂移判断',
    }
  }

  // 用宣称行业的关键词去匹配实际行业名，累加占比
  const actual = allocation.reduce((sum, a) => {
    const match = keywords.some(k => k && a.industry.includes(k))
    return sum + (match ? a.weight : 0)
  }, 0)

  const drifted = actual < warnThreshold
  return {
    claimed_industry: claimed,
    actual_pct: Math.round(actual * 100) / 100,
    threshold: warnThreshold,
    drifted,
    note: `名称指向「${claimed}」，实际持仓中该方向占 ${actual.toFixed(2)}%` +
          (drifted ? ' —— 与名称严重不符，不可按名称理解这只基金' : ''),
  }
}

// ─── 4. 重叠度 ────────────────────────────────────────────────────

/**
 * 计算两只基金的前十大重仓股重叠程度。
 * 重叠 >= N 只判定为「假分散」。
 */
export function calcOverlap(
  holdingsA: FundStockRow[],
  holdingsB: FundStockRow[],
): OverlapReport {
  if (!holdingsA.length || !holdingsB.length) {
    return { overlap_count: 0, overlapped: false, stocks: [] }
  }

  const aMap = new Map<string, string>()
  for (const h of holdingsA) {
    if (h.stock_code) aMap.set(h.stock_code, h.stock_name ?? '')
  }
  const bCodes = new Set(holdingsB.map(h => h.stock_code).filter(Boolean))

  const common = Array.from(aMap.entries())
    .filter(([code]) => bCodes.has(code))
    .map(([stock_code, stock_name]) => ({ stock_code, stock_name }))

  const limit = ANALYSIS_CONFIG.overlap_warn_count
  return {
    overlap_count: common.length,
    overlapped: common.length >= limit,
    stocks: common,
  }
}

// ─── 5. 持仓明细落库 ──────────────────────────────────────────────

/**
 * 将行业配置或重仓股列表写入 fund_holdings 表。
 *
 * @param db        LedgerDb 实例（来自 init_app 传入的 real db）
 * @param fundCode  基金代码
 * @param rows      行列表（来自 fetchIndustryAllocation 或 fetchFundTopHoldings）
 * @param source    'industry_alloc' | 'top_holdings'
 * @returns 实际写入的行数
 */
export async function saveHoldings(
  db: { run: (sql: string, params: unknown[]) => Promise<unknown> },
  fundCode: string,
  rows: Array<Record<string, unknown>>,
  source: 'industry_alloc' | 'top_holdings',
): Promise<number> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  let count = 0
  for (const h of rows) {
    const reportDate = String(h.report_date ?? h['报告期'] ?? '').slice(0, 10)
    if (!reportDate) continue
    // 行业配置行**没有股票代码**（fetchIndustryAllocation 返回 { industry, weight, report_date }），
    // 行业行必须一并落库：跳过无 stockCode 的行会导致行业配置缺失、持仓穿透为空。
    // 现在：行业名同时写入 industry 列，并以行业名充当主键标识（stock_code）。
    const industry = String(h.industry ?? h['行业类别'] ?? '').trim()
    const stockCodeRaw = String(h.stock_code ?? h['股票代码'] ?? '').trim()
    const stockCode = stockCodeRaw || (source === 'industry_alloc' ? industry : '')
    if (!stockCode) continue
    const stockName = String(h.stock_name ?? h['股票名称'] ?? '').trim() || (source === 'industry_alloc' ? industry : null)
    const weight = typeof h.weight === 'number' ? h.weight
      : typeof h.weight_pct === 'number' ? h.weight_pct
      : null
    // INSERT OR REPLACE：刷新时覆盖同一 (fund_code, report_date, stock_code, source) 的旧值，
    // 否则旧脏数据会永久占位。
    const stmt = `
      INSERT OR REPLACE INTO fund_holdings
        (fund_code, report_date, stock_code, stock_name, weight, board_code, industry, source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    try {
      await db.run(stmt, [
        fundCode, reportDate, stockCode,
        stockName,
        weight,
        h.board_code ?? null,
        industry || null,
        source,
        now,
      ])
      count++
    } catch { /* 静默忽略约束冲突 */ }
  }
  return count
}
