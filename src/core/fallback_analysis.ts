// ─────────────────────────────────────────────
// fallback_analysis.ts · 兜底分析（AI 不在线时的本地分析决策）
//
// 蓝本：docs/项目/交易决策SOP.md
// AI 离线/未配置时，兜底分析照常上（方法 = 本地选基算法，只读本地库）。
//
// 方法（用本地数据自动执行）：
//   Step3 候选筛选：全池（本地净值 ≥60 条的基金）→ 分位/ret_1y/ret_3m/波动分档回撤容忍
//         （screenCandidates 已含 SOP 3.2.1 自适应校准：D1 分档 / D2 备轨 / D3 趋势守门）
//   Step6A 纪律线：runOfflineCycle 已跑（+20 兑现 / -15 减仓 / -5 认错）
//   Step7 输出：**结论先行**（一句话定性）+ 数据支撑 + 风险点；禁止「买/不买」一句话结论
//
// 口径：分位 / 回撤 / 收益率一律用累计净值 acc_nav；夏普比率不做。
// ─────────────────────────────────────────────

import type { LedgerDb } from './budget.ts'
import { calcStats, screenCandidates, type Candidate } from './screen_rules.ts'
import { SCREEN_RULES } from './config.ts'

export interface FallbackCandidate {
  fund_code: string
  fund_name: string
  track: string
  score: number | null
  percentile: number
  ret_1y: number
  ret_3m: number | null
  annual_vol: number | null
  vol_band: string | null
  max_dd: number | null
  dd_tolerance: number | null
  nav_days: number
  latest_date: string | null
}

export interface FallbackAnalysisResult {
  as_of: string
  pool_size: number
  /** 一句话定性（结论先行） */
  conclusion: string
  candidates: FallbackCandidate[]
  /** 风险点（风险前置，不报喜不报忧） */
  risks: string[]
}

const MIN_STATS = 60   // 与 screen_rules.MIN_SERIES 一致

/**
 * 兜底分析主入口：对本地净值库里数据够（≥60 条）的基金跑 SOP 筛选，
 * 产出候选（按评分排序）+ 一句话结论 + 风险点。**只读本地库，不联网**。
 */
export async function runFallbackAnalysis(db: LedgerDb, asOf: string): Promise<FallbackAnalysisResult> {
  // ① 池 = 本地净值 ≥60 条的基金（一次 SQL 分组统计）
  const poolRows = await db.query<{ fund_code: string; c: number; latest: string }>(
    `SELECT fund_code, COUNT(*) AS c, MAX(nav_date) AS latest
       FROM nav_daily GROUP BY fund_code HAVING c >= ?`,
    [MIN_STATS],
  )
  const poolCodes = poolRows.map(r => r.fund_code)
  if (poolCodes.length === 0) {
    return {
      as_of: asOf, pool_size: 0,
      conclusion: '本地净值库暂无数据达标的基金（每只需 ≥60 个交易日净值），先在「交易」页关注并抓取净值。',
      candidates: [], risks: ['数据不足，本轮无法筛选'],
    }
  }

  // ② 一次拉全池净值序列（累计净值优先），JS 分组算指标
  const ph = poolCodes.map(() => '?').join(',')
  const navRows = await db.query<{ fund_code: string; v: number }>(
    `SELECT fund_code, COALESCE(acc_nav, nav) AS v FROM nav_daily
      WHERE fund_code IN (${ph}) AND COALESCE(acc_nav, nav) IS NOT NULL
      ORDER BY fund_code, nav_date`,
    poolCodes,
  )
  const seriesMap = new Map<string, number[]>()
  for (const r of navRows) {
    let arr = seriesMap.get(r.fund_code)
    if (!arr) { arr = []; seriesMap.set(r.fund_code, arr) }
    arr.push(Number(r.v))
  }

  const stats: Record<string, unknown>[] = []
  for (const [code, series] of seriesMap) {
    // 只取近 250 个点做评估窗口（与 evaluateFund 同口径）
    const win = series.slice(-250)
    const s = calcStats(win.map(v => ({ nav_date: '', nav: v, acc_nav: v })))
    stats.push({ fund_code: code, ...s })
  }

  // ③ SOP 筛选（四轨 + 自适应校准），按评分排序取 Top 5
  const candidates: Candidate[] = screenCandidates(stats, SCREEN_RULES || {})
  const top = candidates.slice(0, 5)

  // ④ 基金名
  const nameRows = await db.query<{ fund_code: string; fund_name: string }>(
    `SELECT fund_code, fund_name FROM funds WHERE fund_code IN (${top.map(() => '?').join(',') || "''"})`,
    top.map(c => c.fund_code),
  )
  const nameOf = new Map(nameRows.map(r => [r.fund_code, r.fund_name]))

  const out: FallbackCandidate[] = top.map(c => ({
    fund_code: c.fund_code,
    fund_name: nameOf.get(c.fund_code) || c.fund_code,
    track: c.track,
    score: c.score ?? null,
    percentile: Math.round(c.percentile * 10) / 10,
    ret_1y: Math.round(c.ret_1y * 100) / 100,
    ret_3m: c.ret_3m != null ? Math.round(c.ret_3m * 100) / 100 : null,
    annual_vol: c.annual_vol != null ? Math.round(c.annual_vol * 10) / 10 : null,
    vol_band: c.vol_band ?? null,
    max_dd: c.max_dd != null ? Math.round(c.max_dd * 10) / 10 : null,
    dd_tolerance: c.dd_tolerance ?? null,
    nav_days: seriesMap.get(c.fund_code)?.length ?? 0,
    latest_date: poolRows.find(r => r.fund_code === c.fund_code)?.latest ?? null,
  }))

  // ⑤ 结论先行（一句话定性）+ 风险点（SOP Step7 格式精神）
  let conclusion: string
  if (out.length === 0) {
    conclusion = `本轮全池 ${poolCodes.length} 只按 SOP 自适应校准筛选无一命中——市场整体处于高位或趋势普遍向下，属「宁可错过、不做错」的空仓观察期。`
  } else {
    const best = out[0]
    const band = best.vol_band === 'low' ? '低波' : best.vol_band === 'mid' ? '中波' : '高波'
    conclusion =
      `本轮筛选全池 ${poolCodes.length} 只，达标 ${candidates.length} 只，评分最高为 ${best.fund_name}（${best.fund_code}）：` +
      `分位 ${best.percentile}%、近1年 ${best.ret_1y >= 0 ? '+' : ''}${best.ret_1y}%、${band}波动（回撤容忍 -${best.dd_tolerance ?? '?'}%，实际 ${best.max_dd ?? '?'}%）。` +
      `以上为本地规则分析结论（非 AI），仅供参考，买入前请核对申购状态与罚期。`
  }

  const risks: string[] = []
  risks.push('候选基于本地已入库净值（分位/趋势/回撤按累计净值口径）；未入库的基金不在本轮池内。')
  risks.push('评分为规则打分（估值40+业绩30+风险30），规模项因手机端无数据不参与。')
  if (out.some(c => c.track === 'pure_value')) risks.push('含「纯洼地」标的：趋势尚未启动，左侧埋伏需承受更久的不涨。')
  if (out.some(c => c.track === 'high_vol')) risks.push('含「高波动」标的：波动大，须控制仓位。')
  const noR3m = out.some(c => c.ret_3m == null)
  if (noR3m) risks.push('部分候选近3月数据缺失，趋势守门未生效，谨慎对待。')

  return { as_of: asOf, pool_size: poolCodes.length, conclusion, candidates: out, risks }
}
