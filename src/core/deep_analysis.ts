// ─────────────────────────────────────────────
// deep_analysis.ts · 单基金「六段式」深度分析（本地代码规则，不调大模型）
//
// 六段结构：核心结论 / 硬指标 / 催化事件 / 估值与业绩 / 关注信号 / 投资建议。
// 定性规则：
//   位置 = 累计净值历史分位（≥80% 高估区｜40–80% 中位区｜<40% 低估区）
//   趋势 = 近1年收益（≥+10% 向上｜0~+10% 偏平｜-10%~0 偏弱｜<-10% 向下）
//   定性 = 位置 × 趋势矩阵（见 VERDICT_MATRIX）
//
// 口径约束：
//   - 收益 / 回撤 / 波动的净值口径与 core/analysis.ts navStats 一致（acc_nav，250 交易日窗口）；
//     「最大回撤（全历史）」另按调用方传入的全历史回撤结果展示，不与 250 日窗口混用。
//   - 累计净值历史分位 = 当前累计净值小于其值的样本数 ÷(样本数-1)，样本不足 2 个时留空。
//   - 全部字段来自真实数据源；取不到的如实留空（null / 「暂无」），不编造。
//   - 禁止输出买卖指令：第六段只给关注点与风险点，定位为「非推荐，仅供判断参考」。
// ─────────────────────────────────────────────

import { REDEEM_TIERS } from './config.ts'

// ─── 输入输出类型 ───────────────────────────────────────────────────

export interface NavSeriesPoint {
  date: string
  nav: number
  acc_nav: number
}

/** 全历史回撤（来自 navlab.drawdownRecovery 同口径的计算结果） */
export interface AllHistoryDrawdown {
  maxDrawdown: number          // 负数百分比，如 -32.15
  peakDate: string
  troughDate: string
  recovered: boolean
  recoveryDate: string | null
  recoveryDays: number | null
  pendingDays: number | null
}

/** 真实持仓单只聚合行（fetchPositions 的 source='real' 行） */
export interface RealPositionInput {
  total_shares: number
  total_cost: number
  market_value: number | null
  profit: number | null
  profit_pct: number | null
}

export interface CatalystItem {
  kind: 'announce' | 'stock_news'
  title: string
  pub_time: string | null
  source: string | null
}

export interface DividendAnnouncement {
  title: string
  pub_time: string | null
}

export interface DeepAnalysisInput {
  code: string
  name?: string
  series: NavSeriesPoint[]
  /** 指标统计（ret_1m/3m/6m/1y、annual_volatility_pct、samples；与 navStats 同口径） */
  stats: {
    ret_1m: number | null
    ret_3m: number | null
    ret_6m: number | null
    ret_1y: number | null
    annual_volatility_pct: number | null
    samples: number
  }
  drawdown: AllHistoryDrawdown | null
  position: RealPositionInput | null
  /** 真实持仓组合总市值（算仓位定位用；没有持仓时传 null） */
  portfolioMv: number | null
  purchaseStatus: string | null
  purchaseFeeRate: number | null      // 小数，如 0.015
  dividendMethod: string | null       // 'cash' | 'reinvest'
  dividendAnnouncements: DividendAnnouncement[]
  catalysts: CatalystItem[]
}

export type PositionBand = 'undervalued' | 'mid' | 'overvalued' | 'unknown'
export type TrendBand = 'up' | 'flat' | 'weak' | 'down' | 'unknown'

export interface MetricRow {
  label: string
  value: string | null
  note: string
  source: string
}

export interface SignalRow {
  priority: string
  name: string
  standard: string
  status: string
}

export interface DeepAnalysisReport {
  ok: boolean
  error?: string

  // 一、核心结论
  positionBand: PositionBand
  positionLabel: string
  trendBand: TrendBand
  trendLabel: string
  verdict: string
  verdictReason: string
  summary: string
  percentile: number | null

  // 二、硬指标
  metrics: MetricRow[]
  facts: string[]

  // 三、催化事件
  catalysts: CatalystItem[]
  catalystsNote: string

  // 四、估值与业绩
  valuation: { target: string; metric: string; value: string }[]
  valuationNote: string

  // 五、关注信号
  signals: SignalRow[]

  // 六、投资建议
  advice: {
    disclaimer: string
    focus: string[]
    risks: string[]
  }
}

// ─── 常量：定性矩阵 / 档位阈值 ──────────────────────────────────────

/** 位置 × 趋势 → 定性（文档给定矩阵，趋势数据不足时单列处理） */
const VERDICT_MATRIX: Record<Exclude<PositionBand, 'unknown'>, Record<Exclude<TrendBand, 'unknown'>, string>> = {
  undervalued: { up: '可关注', flat: '观察', weak: '左侧未确认', down: '回避' },
  mid: { up: '持有', flat: '持有观察', weak: '减仓观察', down: '回避' },
  overvalued: { up: '谨慎持有', flat: '谨慎', weak: '回避', down: '回避' },
}

const POSITION_BAND_LABEL: Record<PositionBand, string> = {
  undervalued: '低估区',
  mid: '中位区',
  overvalued: '高估区',
  unknown: '数据不足',
}

const TREND_BAND_LABEL: Record<TrendBand, string> = {
  up: '向上',
  flat: '偏平',
  weak: '偏弱',
  down: '向下',
  unknown: '数据不足',
}

/** 回撤风险等级（|最大回撤| 分档） */
function drawdownRiskLevel(mddPct: number | null): string {
  if (mddPct == null) return '数据不足，无法评级'
  const d = Math.abs(mddPct)
  if (d < 10) return `低（最深跌 ${d.toFixed(2)}%，10% 以内）`
  if (d < 20) return `中（最深跌 ${d.toFixed(2)}%，10%–20%）`
  if (d < 30) return `高（最深跌 ${d.toFixed(2)}%，20%–30%）`
  return `极高（最深跌 ${d.toFixed(2)}%，30% 以上）`
}

// ─── 纯函数 ────────────────────────────────────────────────────────

/** 累计净值历史分位（%）：当前值在本地全部历史累计净值中的位置。0%=历史最低，100%=历史最高。 */
export function navPercentile(series: NavSeriesPoint[]): number | null {
  const vals = (series || []).map(p => p.acc_nav).filter(v => v != null && v > 0)
  if (vals.length < 2) return null
  const last = vals[vals.length - 1]
  const below = vals.filter(v => v < last).length
  return (below / (vals.length - 1)) * 100
}

/** 位置分档：≥80% 高估区｜40–80% 中位区｜<40% 低估区 */
export function positionBandOf(percentile: number | null): PositionBand {
  if (percentile == null) return 'unknown'
  if (percentile >= 80) return 'overvalued'
  if (percentile >= 40) return 'mid'
  return 'undervalued'
}

/** 趋势分档：≥+10% 向上｜0~+10% 偏平｜-10%~0 偏弱｜<-10% 向下 */
export function trendBandOf(ret1y: number | null): TrendBand {
  if (ret1y == null || Number.isNaN(ret1y)) return 'unknown'
  if (ret1y >= 10) return 'up'
  if (ret1y >= 0) return 'flat'
  if (ret1y >= -10) return 'weak'
  return 'down'
}

export function verdictOf(pos: PositionBand, trend: TrendBand): string {
  if (pos === 'unknown') return '观察'
  if (trend === 'unknown') return pos === 'overvalued' ? '谨慎' : pos === 'mid' ? '持有观察' : '观察'
  return VERDICT_MATRIX[pos][trend]
}

/** 持有天数阈值 → 人类可读（7天 / 30天 / 1年 / 2年 / 2年以上） */
function holdingLabel(days: number): string {
  if (days >= 365) return `${Math.round(days / 365)} 年`
  return `${days} 天`
}

/** 赎回费阶梯文本（真实规则，读 config，不猜） */
export function redeemTiersText(): string {
  const tiers = REDEEM_TIERS.map(t => ({ ...t }));
  return tiers.map((t, i) => {
    const head = i === 0
      ? `持有<${holdingLabel(t.maxHoldingDays)}`
      : i === tiers.length - 1
        ? `持有≥${holdingLabel(tiers[i - 1].maxHoldingDays)}`
        : `持有<${holdingLabel(t.maxHoldingDays)}`
    return `${head} ${pct0(t.rate)}${'penalty' in t ? '（惩罚性）' : ''}`
  }).join('；')
}

function pct0(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`
}

function fmtPct(v: number | null, digits = 2): string | null {
  if (v == null || Number.isNaN(v)) return null
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

function fmtMoney(v: number | null): string | null {
  if (v == null || Number.isNaN(v)) return null
  return v.toFixed(2)
}

/** 当日涨跌（%）：最新单位净值相对前一交易日的涨跌幅；不足 2 个净值点留空。 */
export function dayChangePct(series: NavSeriesPoint[]): { pct: number; navDate: string; prevDate: string } | null {
  const pts = (series || []).filter(p => p.nav > 0)
  if (pts.length < 2) return null
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  if (!(prev.nav > 0)) return null
  return { pct: ((last.nav / prev.nav) - 1) * 100, navDate: last.date, prevDate: prev.date }
}

function dividendMethodLabel(m: string | null): string {
  if (m === 'reinvest') return '红利再投'
  if (m === 'cash') return '现金分红'
  return '未查询到'
}

// ─── 主入口：组装六段式报告 ─────────────────────────────────────────

export function buildDeepAnalysis(input: DeepAnalysisInput): DeepAnalysisReport {
  const { series, stats, drawdown, position, portfolioMv } = input

  const last = series.length ? series[series.length - 1] : null
  const prevNav = series.length > 1 ? series[series.length - 2] : null
  const dayChange = dayChangePct(series)
  const percentile = navPercentile(series)
  const posBand = positionBandOf(percentile)
  const trendBand = trendBandOf(stats.ret_1y)
  const verdict = verdictOf(posBand, trendBand)

  // ── 一、核心结论 ──
  const summaryParts: string[] = []
  summaryParts.push(stats.ret_1y != null ? `近1年 ${fmtPct(stats.ret_1y)}` : '近1年收益数据不足')
  summaryParts.push(stats.ret_3m != null ? `近3月 ${fmtPct(stats.ret_3m)}` : '近3月数据不足')
  summaryParts.push(drawdown ? `全历史最大回撤 ${fmtPct(drawdown.maxDrawdown)}` : '全历史最大回撤数据不足')
  summaryParts.push(
    percentile != null
      ? `累计净值处于历史 ${percentile.toFixed(1)}% 分位（${POSITION_BAND_LABEL[posBand]}）`
      : '累计净值历史分位数据不足',
  )
  const summary = `${summaryParts.join('，')}，当前位置与趋势合看定性为「${verdict}」。`

  // ── 二、硬指标（8 行） ──
  const metrics: MetricRow[] = [
    {
      label: '最新单位净值',
      value: last ? last.nav.toFixed(4) : null,
      note: `累计净值 ${last ? last.acc_nav.toFixed(4) : '—'}${last ? ` · ${last.date}` : ''}`,
      source: '本地净值库',
    },
    {
      label: '当日涨跌',
      value: dayChange ? fmtPct(dayChange.pct) : null,
      note: dayChange ? `${dayChange.navDate} 相对 ${dayChange.prevDate}` : '净值点不足 2 天，无法计算',
      source: '本地净值库',
    },
    {
      label: '近1月 / 近3月',
      value: `${fmtPct(stats.ret_1m) ?? '—'} / ${fmtPct(stats.ret_3m) ?? '—'}`,
      note: '按自然日窗口取累计净值计算',
      source: '本地净值库',
    },
    {
      label: '近6月 / 近1年',
      value: `${fmtPct(stats.ret_6m) ?? '—'} / ${fmtPct(stats.ret_1y) ?? '—'}`,
      note: '近1年按 250 交易日窗口（与筛选口径一致）',
      source: '本地净值库',
    },
    {
      label: '最大回撤（全历史）',
      value: drawdown ? fmtPct(drawdown.maxDrawdown) : null,
      note: '历史最高点到之后最低点的最深跌幅',
      source: '本地净值库',
    },
    {
      label: '年化波动率',
      value: stats.annual_volatility_pct != null ? fmtPct(stats.annual_volatility_pct) : null,
      note: '日收益率标准差 × √250（250 交易日口径）',
      source: '本地净值库',
    },
    {
      label: '历史长度',
      value: stats.samples > 0 ? `${stats.samples} 天` : null,
      note: '本地已入库的净值交易日数量',
      source: '本地净值库',
    },
    {
      label: '累计净值历史分位',
      value: percentile != null ? `${percentile.toFixed(1)}%` : null,
      note: percentile != null ? `当前值在历史中的位置：${POSITION_BAND_LABEL[posBand]}` : '净值样本不足',
      source: '本地净值库',
    },
  ]

  // 关键事实（2–3 条）
  const facts: string[] = []
  facts.push(`回撤风险等级：${drawdownRiskLevel(drawdown ? drawdown.maxDrawdown : null)}。`)
  if (drawdown && drawdown.peakDate && drawdown.troughDate) {
    facts.push(
      drawdown.recovered
        ? `最深回撤自 ${drawdown.peakDate} 高点跌至 ${drawdown.troughDate} 低点，之后用 ${drawdown.recoveryDays} 天涨回原位。`
        : `最深回撤自 ${drawdown.peakDate} 高点跌至 ${drawdown.troughDate} 低点，截至最新净值日仍未涨回原位（已过 ${drawdown.pendingDays} 天）。`,
    )
  } else {
    facts.push('本地净值样本不足，暂无回撤起止日期与修复情况。')
  }
  facts.push(
    percentile != null
      ? `当前净值处于${POSITION_BAND_LABEL[posBand]}（${percentile.toFixed(1)}% 分位），分位 ≥80% 为高估区、40–80% 为中位区、<40% 为低估区。`
      : '净值样本不足，历史分位无法计算。',
  )

  // ── 三、催化事件（调用方已合并公告 + 重仓股新闻，此处只做倒序与截断） ──
  const catalysts = [...input.catalysts]
    .sort((a, b) => String(b.pub_time || '').localeCompare(String(a.pub_time || '')))
    .slice(0, 8)
  const catalystsNote = catalysts.length > 0
    ? '按发布时间倒序取最近 8 条；公告来自基金公司披露，新闻来自公共资讯库。'
    : '暂无相关公告或新闻：本地资讯库中这只基金近期没有抓取到的公告与重仓股新闻。'

  // ── 四、估值与业绩 ──
  const valuation: { target: string; metric: string; value: string }[] = [
    {
      target: '本基金',
      metric: '历史分位 / 近1年',
      value: percentile != null
        ? `${percentile.toFixed(1)}%（${POSITION_BAND_LABEL[posBand]}）/ ${fmtPct(stats.ret_1y) ?? '—'}`
        : `— / ${fmtPct(stats.ret_1y) ?? '—'}`,
    },
  ]
  if (position) {
    const roi = position.profit_pct != null ? fmtPct(position.profit_pct) : null
    const pnl = position.profit != null ? `${position.profit >= 0 ? '+' : ''}¥${fmtMoney(position.profit)}` : null
    const shares = position.total_shares != null ? position.total_shares.toFixed(2) : '未提供'
    valuation.push({
      target: '你的持仓',
      metric: '持有收益率 / 盈亏',
      value: `${roi ?? '—'} · ${pnl ?? '—'}（成本 ¥${fmtMoney(position.total_cost)} → 市值 ¥${fmtMoney(position.market_value)}，份额 ${shares}）`,
    })
  } else {
    valuation.push({ target: '你的持仓', metric: '持有收益率', value: '未查询到该基金的真实持仓记录' })
  }
  valuation.push({
    target: '基金档案',
    metric: '申购 / 费率 / 分红',
    value: `${input.purchaseStatus || '未查询到'} · 申购费率 ${input.purchaseFeeRate != null ? pct0(input.purchaseFeeRate) : '未查询到'} · 分红方式 ${dividendMethodLabel(input.dividendMethod)}`,
  })
  valuation.push({
    target: '赎回费',
    metric: '持有天数阶梯',
    value: redeemTiersText(),
  })
  const divs = [...input.dividendAnnouncements]
    .sort((a, b) => String(b.pub_time || '').localeCompare(String(a.pub_time || '')))
  valuation.push({
    target: '分红记录',
    metric: '近 N 次 / 最近一次',
    value: divs.length > 0
      ? `近 ${divs.length} 次；最近一次「${divs[0].title}」（${divs[0].pub_time || '日期未知'}）`
      : '暂无：未查询到该基金的分红记录',
  })

  const valuationNote =
    posBand === 'overvalued'
      ? '净值处历史高位区，需警惕均值回归。'
      : posBand === 'undervalued'
        ? '净值处历史低位区，是否见底需结合趋势与催化事件合看。'
        : '净值处历史中位区，位置本身不构成偏向，重点看趋势与催化事件。'

  // ── 五、关注信号 ──
  const signals: SignalRow[] = [
    {
      priority: '★★★★★',
      name: '累计净值历史分位',
      standard: '突破 90% → 位置偏高；跌回 40% 以下 → 回到偏低区',
      status: percentile != null ? `${percentile.toFixed(1)}%` : '数据不足',
    },
    {
      priority: '★★★★☆',
      name: '最大回撤是否加深',
      standard: '出现更深回撤 → 风险等级上调',
      status: drawdown ? `${fmtPct(drawdown.maxDrawdown)}` : '数据不足',
    },
    {
      priority: '★★☆☆☆',
      name: '近 1 年收益方向',
      standard: '由负转正且连续两季为正 → 趋势确认',
      status: stats.ret_1y != null ? `${fmtPct(stats.ret_1y)}` : '数据不足',
    },
  ]

  // ── 六、投资建议 ──
  const weightPct =
    position && position.market_value != null && portfolioMv != null && portfolioMv > 0
      ? (position.market_value / portfolioMv) * 100
      : null
  const focus: string[] = [
    weightPct != null
      ? `仓位定位：该基金占你真实持仓总市值 ${weightPct.toFixed(1)}%，先明确它在你组合里扮演的角色，再决定要不要调整。`
      : '仓位定位：本地暂无完整的真实持仓市值数据，无法计算占比，可先在持仓页补全省份额与成本。',
    `分位与方向合看：当前 ${percentile != null ? `${percentile.toFixed(1)}%` : '未知'} 分位 × 近1年 ${fmtPct(stats.ret_1y) ?? '未知'}，定性「${verdict}」；位置便宜但趋势向下时不急于动作，位置偏高且趋势转弱时提高警惕。`,
    '同类对比：在「分析」页可对比本基金与基准指数的区间表现、与自选基金的重合度，同类排名数据本地未接入，以指数对比为准。',
  ]
  const risks: string[] = []
  risks.push(
    drawdown
      ? `回撤风险：全历史最深跌 ${Math.abs(drawdown.maxDrawdown).toFixed(2)}%，买入前先确认这个跌幅扛不扛得住。`
      : '回撤风险：本地净值样本不足，回撤风险暂无法量化。',
  )
  if (posBand === 'overvalued') {
    risks.push(`位置风险：净值处于历史 ${percentile!.toFixed(1)}% 分位的高位区，均值回归可能随时发生。`)
  }
  if (position && position.profit != null && position.profit < 0) {
    risks.push(`浮亏风险：该持仓当前浮亏 ¥${fmtMoney(Math.abs(position.profit))}（${fmtPct(position.profit_pct)}），割与不割取决于你对基本面的判断，不取决于亏了多少。`)
  }
  risks.push(
    percentile != null && stats.samples < 250
      ? '数据边界：本地净值历史不足 250 个交易日，分位与统计值的置信度有限，建议抓满历史后再看。'
      : '数据边界：分位与统计基于本地已入库净值，若历史未抓全会影响准确性；结论仅供判断参考，不构成买卖建议。',
  )

  return {
    ok: true,
    positionBand: posBand,
    positionLabel: POSITION_BAND_LABEL[posBand],
    trendBand,
    trendLabel: TREND_BAND_LABEL[trendBand],
    verdict,
    verdictReason: `位置：${POSITION_BAND_LABEL[posBand]}（累计净值历史分位 ${percentile != null ? percentile.toFixed(1) + '%' : '未知'}）；趋势：${TREND_BAND_LABEL[trendBand]}（近1年 ${fmtPct(stats.ret_1y) ?? '未知'}）`,
    summary,
    percentile,
    metrics,
    facts,
    catalysts,
    catalystsNote,
    valuation,
    valuationNote,
    signals,
    advice: {
      disclaimer: '本段为代码规则生成的参考信息，非投资推荐，不构成买卖指令。',
      focus,
      risks,
    },
  }
}
