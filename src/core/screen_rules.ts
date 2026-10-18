// ─────────────────────────────────────────────
// screen_rules.ts · 核心算法（分位 / 回撤 / 收益率 / 筛选规则）
//
//
// 项目唯一目的：找「估值洼地（历史分位低）+ 趋势向上」的基金。
//   筛选：历史分位 < 50% + 近1年收益 > 0 + 最大回撤 < 50%
//   买入前：额外要求最大回撤 < 30%
//
// ⚠️ 口径：分位 / 回撤 / 收益率一律用**累计净值 acc_nav**（分红除息会形成假下跌）。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

export const MIN_SERIES = 60      // 最小数据长度
export const WINDOW_DAYS = 250    // 评估窗口（约 1 年交易日）
export const PCTL_MAX = 50.0      // 历史分位上限
export const RET_1Y_MIN = 0.0     // 近 1 年收益下限
export const MDD_MAX = 50.0       // 最大回撤上限
export const MDD_BUY_MAX = 30.0   // 买入前回撤上限

// ─── 基础指标 ─────────────────────────────────────────────

/** 当前值在历史序列中的百分位（0~100）；数据不足返回 null。 */
export function percentile(series: number[]): number | null {
  if (!series || series.length < MIN_SERIES) return null
  const current = series[series.length - 1]
  let less = 0
  for (let i = 0; i < series.length - 1; i++) if (series[i] < current) less++
  return ((less + 1) / series.length) * 100
}

/** 历史最大回撤（负数）；数据不足返回 null。 */
export function maxDrawdown(series: number[]): number | null {
  if (!series || series.length < MIN_SERIES) return null
  let peak = series[0]
  let maxDd = 0
  for (const nav of series) {
    if (nav > peak) peak = nav
    if (peak > 0) {
      const dd = ((peak - nav) / peak) * 100
      if (dd > maxDd) maxDd = dd
    }
  }
  return -maxDd
}

/** 近 N 个点收益率（%）；基准 <= 0 返回 null（不硬算、不除零）。 */
function retN(series: number[], n: number): number | null {
  if (!series || series.length < n) return null
  const base = series[series.length - n]
  if (!(base > 0)) return null
  return (series[series.length - 1] / base - 1) * 100
}

export const ret1m = (s: number[]) => retN(s, 20)
export const ret3m = (s: number[]) => retN(s, 60)
export const ret6m = (s: number[]) => retN(s, 120)

/**
 * 近 1 年收益率（%）：以**窗口首值**为基准。
 * ⚠️ 传入的是近 250 条窗口，"近 1 年"以窗口首值为基准；
 *    固定倒第 N 个点在序列长度变化时口径不稳，故取窗口首值。
 */
export function ret1y(series: number[]): number | null {
  if (!series || series.length < MIN_SERIES) return null
  const first = series[0]
  if (first <= 0) return null
  return (series[series.length - 1] / first - 1) * 100
}

/** 年化波动率（%，250 交易日，总体标准差）。 */
export function annualVol(series: number[]): number | null {
  if (!series || series.length < MIN_SERIES) return null
  const returns: number[] = []
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] > 0) returns.push((series[i] - series[i - 1]) / series[i - 1])
  }
  if (!returns.length) return null
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance) * Math.sqrt(250) * 100
}

/** 净值闸门：过滤异常值（正常基金净值 0.1 ~ 20.0）。 */
export function passNavGate(nav: number | null | undefined): boolean {
  if (nav == null || nav <= 0) return false
  return nav >= 0.1 && nav <= 20.0
}

/** 汇总统计（用于批量筛选）。 */
export function calcStats(navSeries: { nav_date: string; nav: number; acc_nav: number | null }[]) {
  if (!navSeries || !navSeries.length) return {}
  const accNavs = navSeries.map(s => s.acc_nav).filter((v): v is number => v != null)
  return {
    latest_date: navSeries[navSeries.length - 1]?.nav_date ?? null,
    latest_nav: navSeries[navSeries.length - 1]?.nav ?? null,
    acc_latest: accNavs.length ? accNavs[accNavs.length - 1] : null,
    percentile: accNavs.length ? percentile(accNavs) : null,
    max_drawdown: accNavs.length ? maxDrawdown(accNavs) : null,
    ret_1y: accNavs.length ? ret1y(accNavs) : null,
    ret_3m: accNavs.length ? ret3m(accNavs) : null,
    ret_1m: accNavs.length ? ret1m(accNavs) : null,
    ret_6m: accNavs.length ? ret6m(accNavs) : null,
    annual_vol: accNavs.length ? annualVol(accNavs) : null,
    data_count: accNavs.length,
  }
}

// ─── 三轨筛选规则 ─────────────────────────────────────────

export interface ScreenRulesConfig {
  main_track?: { percentile_max?: number; ret_1y_min?: number }
  pure_value_track?: { percentile_max?: number; ret_1y_max?: number }
  backup_track?: { percentile_min?: number; ret_1y_min?: number; ret_3m_threshold?: number }
  high_vol_relax?: { annual_vol_max?: number; max_dd_min?: number }
}

export interface Candidate {
  fund_code: string
  percentile: number
  ret_1y: number
  ret_3m: number | null
  annual_vol: number | null
  max_dd: number | null
  track: 'main' | 'pure_value' | 'backup' | 'high_vol'
  /** 综合评分（估值40 + 业绩30 + 风险30；规模数据缺省不参与，注明） */
  score?: number
  /** 波动档位：low / mid / high（SOP 3.2.1 D1） */
  vol_band?: 'low' | 'mid' | 'high'
  /** 该档位的回撤容忍上限（正数，如 30 表示容忍 -30%） */
  dd_tolerance?: number
}

// ─── SOP v3.1 自适应校准 ────

/**
 * D1 回撤容忍按年化波动分档（取代一刀切 -30%）：
 *   低波 <10% → 容忍 -10%；中波 10~25% → -30%；高波 ≥25% → -50%。
 * 返回正数容忍上限（如 30 = 容忍 -30%）。
 */
export function ddToleranceByVol(vol: number | null | undefined): number | null {
  if (vol == null || !Number.isFinite(vol)) return null
  if (vol < 10) return 10
  if (vol < 25) return 30
  return 50
}

/** 波动档位标签 */
export function volBand(vol: number | null | undefined): 'low' | 'mid' | 'high' | null {
  if (vol == null || !Number.isFinite(vol)) return null
  if (vol < 10) return 'low'
  if (vol < 25) return 'mid'
  return 'high'
}

/**
 * SOP 综合评分（0~100，规模项缺数据不计 → 上限 90）：
 *   估值 40%：(100 - 分位) × 0.4（净值历史分位替代 PE/PB 分位——手机端无 PE/PB 源）
 *   业绩 30%：min(ret_1y × 5, 30) × 0.3
 *   风险 30%：回撤相对档位容忍的安全度 × 0.3（超容忍 = 0）
 * ⚠️ 夏普比率不做。
 */
export function calcScore(c: { percentile: number; ret_1y: number; max_dd: number | null; annual_vol: number | null }): number | null {
  const tol = ddToleranceByVol(c.annual_vol)
  const valuation = (100 - c.percentile) * 0.4
  const perf = Math.min(Math.max(c.ret_1y, 0) * 5, 30) * 0.3
  let risk = 0
  if (c.max_dd != null && tol != null && tol > 0) {
    const used = Math.abs(c.max_dd)
    risk = Math.max(0, Math.min(1, (tol - used) / tol)) * 30
  }
  const total = valuation + perf + risk
  return Number.isFinite(total) ? Math.round(total * 10) / 10 : null
}

/**
 * 基金池筛选（四轨 + SOP 自适应校准）：
 *   主轨：分位 <50 且 近1年 >0 且（近3月 > -10 守门，D3 防「一年涨、三月崩」）
 *   纯洼地：分位 <50 且 近1年 ≤0（左侧埋伏，未启动）
 *   趋势：分位 ≥70 且 近1年 >0 且（近3月 > -10 或缺失）
 *   高波动：年化波动 ≤35 且 回撤 ≥-50
 *   D2 备轨：主轨命中 <2 只时启用——分位 < 池中位 −10pp 的前几名（防「全池高位 → 零命中」）
 * 结果按评分降序（同分按分位升序）。
 */
export function screenCandidates(navStats: Record<string, unknown>[], rules: ScreenRulesConfig = {}): Candidate[] {
  const out: Candidate[] = []
  const mt = rules.main_track || {}
  const pv = rules.pure_value_track || {}
  const bt = rules.backup_track || {}
  const hv = rules.high_vol_relax || {}

  // 先算一遍原始命中（主轨数），供 D2 备轨判断
  for (const stat of navStats) {
    const code = stat.fund_code as string
    const p = stat.percentile as number | null
    const r1y = stat.ret_1y as number | null
    const r3m = stat.ret_3m as number | null
    const vol = stat.annual_vol as number | null
    const dd = stat.max_drawdown as number | null
    if (p == null || r1y == null) continue

    const trendGate = r3m == null || r3m > (bt.ret_3m_threshold ?? -10)
    const mainPass = p < (mt.percentile_max ?? 50) && r1y > (mt.ret_1y_min ?? 0) && trendGate
    const pureValuePass = p < (pv.percentile_max ?? 50) && r1y <= (pv.ret_1y_max ?? 0)
    const backupPass = p >= (bt.percentile_min ?? 70) && r1y > (bt.ret_1y_min ?? 0)
      && (r3m == null || r3m > (bt.ret_3m_threshold ?? -10))
    let highVol = false
    if (vol != null && dd != null) {
      highVol = vol <= (hv.annual_vol_max ?? 35) && dd >= (hv.max_dd_min ?? -50)
    }
    if (mainPass || pureValuePass || backupPass || highVol) {
      out.push({
        fund_code: code, percentile: p, ret_1y: r1y, ret_3m: r3m, annual_vol: vol, max_dd: dd,
        track: mainPass ? 'main' : (pureValuePass ? 'pure_value' : (backupPass ? 'backup' : 'high_vol')),
      })
    }
  }

  // D2 备轨：主轨命中 <2 只时启用——分位 < 池中位 −10pp 的前几名标记为 backup 轨
  const mainCount = out.filter(c => c.track === 'main').length
  if (mainCount < 2 && navStats.length > 0) {
    const pcts = navStats
      .map((s) => s.percentile as number | null)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b)
    if (pcts.length >= 4) {
      const median = pcts[Math.floor(pcts.length / 2)]
      const threshold = median - 10
      const pool = navStats
        .filter((s) => (s.percentile as number | null) != null && (s.percentile as number) < threshold)
        .sort((a, b) => (a.percentile as number) - (b.percentile as number))
        .slice(0, 5)
      for (const s of pool) {
        const code = s.fund_code as string
        if (out.some(c => c.fund_code === code)) continue
        const r1y = s.ret_1y as number | null
        if (r1y == null) continue
        out.push({
          fund_code: code,
          percentile: s.percentile as number,
          ret_1y: r1y,
          ret_3m: (s.ret_3m as number | null) ?? null,
          annual_vol: (s.annual_vol as number | null) ?? null,
          max_dd: (s.max_drawdown as number | null) ?? null,
          track: 'backup',
        })
      }
    }
  }

  // 评分 + 档位（SOP v3.1）
  for (const c of out) {
    c.score = calcScore(c) ?? undefined
    c.vol_band = volBand(c.annual_vol) ?? undefined
    c.dd_tolerance = ddToleranceByVol(c.annual_vol) ?? undefined
  }
  out.sort((a, b) => (b.score ?? -999) - (a.score ?? -999) || a.percentile - b.percentile)
  return out
}

// ─── DB 相关 ─────────────────────────────────────────────

/** 最近 limit 条净值（升序），**优先累计净值**。 */
export async function navSeries(db: LedgerDb, code: string, limit: number = WINDOW_DAYS): Promise<number[]> {
  const rows = await db.query<{ v: number }>(
    `SELECT COALESCE(acc_nav, nav) AS v FROM nav_daily
     WHERE fund_code = ? AND COALESCE(acc_nav, nav) IS NOT NULL
     ORDER BY nav_date DESC LIMIT ?`,
    [code, limit],
  )
  return rows.map(r => Number(r.v)).reverse()
}

/**
 * QDII 份额币种口径：(kind, note)。'' 表示非 QDII。
 * 人民币份额净值**含**汇兑损益、美元份额**不含** —— 不标出来会把「汇率驱动」
 * 误读成「标的趋势」。
 */
export async function shareClassOf(db: LedgerDb, code: string): Promise<[string, string]> {
  const rows = await db.query<{ name: string | null; is_qdii: number | null }>(
    'SELECT fund_name AS name, is_qdii FROM funds WHERE fund_code = ?', [String(code)],
  )
  const row = rows[0]
  if (!row || !row.is_qdii) return ['', '']
  const name = String(row.name || '')
  if (name.includes('美元')) return ['usd', 'QDII·美元份额：净值以美元计，**不含人民币汇兑损益**（汇率风险自担）']
  if (name.includes('人民币')) return ['rmb', 'QDII·人民币份额：净值**已含汇兑损益**（人民币升值会拖累净值表现）']
  return ['qdii', 'QDII：净值已含汇兑损益（名称未标明币种，按人民币口径理解）']
}

export interface FundScreenResult {
  code: string
  nav_days: number
  percentile: number | null
  ret_1y: number | null
  max_dd: number | null
  pass_screen: boolean | null
  pass_buy: boolean | null
  reasons: string[]
  data_ok: boolean
  share_class: string
  currency_note: string
}

/**
 * 对单只基金跑项目筛选规则，返回**事实 + 达标与否**（不推荐买哪只）。
 */
export async function evaluateFund(db: LedgerDb, code: string): Promise<FundScreenResult> {
  const vals = await navSeries(db, code)
  const p = percentile(vals)
  const r = ret1y(vals)
  const d = maxDrawdown(vals)
  const [scKind, scNote] = await shareClassOf(db, code)

  const reasons: string[] = []
  if (p == null || r == null || d == null) {
    return {
      code, nav_days: vals.length, percentile: p, ret_1y: r, max_dd: d,
      pass_screen: null, pass_buy: null,
      reasons: [`净值序列仅 ${vals.length} 条（需 ≥${MIN_SERIES}），数据不足`],
      data_ok: false, share_class: scKind, currency_note: scNote,
    }
  }

  const okP = p < PCTL_MAX
  const okR = r > RET_1Y_MIN
  const okD = Math.abs(d) < MDD_MAX
  const passScreen = okP && okR && okD
  const passBuy = passScreen && Math.abs(d) < MDD_BUY_MAX

  reasons.push(`历史分位 ${p.toFixed(1)}%（${okP ? '<50 ✓' : '≥50 ✗'}）`)
  reasons.push(`近1年收益 ${r >= 0 ? '+' : ''}${r.toFixed(2)}%（${okR ? '>0 ✓' : '≤0 ✗'}）`)
  reasons.push(`最大回撤 ${d.toFixed(1)}%（${okD ? '<50 ✓' : '≥50 ✗'}）`)
  if (passScreen && !passBuy) {
    reasons.push(`买入前还要求回撤 <${MDD_BUY_MAX.toFixed(0)}%（当前 ${Math.abs(d).toFixed(1)}%，暂不满足）`)
  }
  if (scNote) reasons.push(scNote)

  return {
    code, nav_days: vals.length, percentile: p, ret_1y: r, max_dd: d,
    pass_screen: passScreen, pass_buy: passBuy, reasons, data_ok: true,
    share_class: scKind, currency_note: scNote,
  }
}

/** 批量评估（只读本地净值）。 */
export async function evaluateMany(db: LedgerDb, codes: string[]): Promise<FundScreenResult[]> {
  const uniq = [...new Set(codes.filter(Boolean))]
  const out: FundScreenResult[] = []
  for (const c of uniq) out.push(await evaluateFund(db, c))
  return out
}
