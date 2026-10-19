// src/lib/deep_analysis.js · 单基金「六段式」深度分析（本地代码规则，不调大模型）
// ------------------------------------------------------------
// 六段结构：核心结论 / 硬指标 / 催化事件 / 估值与业绩 / 关注信号 / 投资建议。
// 定性规则：
//   位置 = 累计净值历史分位（≥80% 高估区｜40–80% 中位区｜<40% 低估区）
//   趋势 = 近1年收益（≥+10% 向上｜0~+10% 偏平｜-10%~0 偏弱｜<-10% 向下）
//   定性 = 位置 × 趋势矩阵（见 VERDICT_MATRIX）
//
// 口径约束：
//   - 区间收益 / 分位 / 回撤用累计净值（历史表现口径）；当日涨跌用单位净值，两者不混用
//   - 累计净值历史分位 = 当前值小于其值的样本数 ÷(样本数-1)，0%=历史最低，100%=历史最高
//   - 全部字段取真实数据；取不到的如实留空（null / 「暂无」），不编造
//   - 禁止输出买卖指令：第六段只给关注点与风险点，定位为「非推荐，仅供判断参考」

import { REDEEM_TIERS } from './fees.js'

// ─── 档位函数 ────────────────────────────────────────────────────────

/** 位置 × 趋势 → 定性（文档给定矩阵，趋势数据不足时单列处理） */
const VERDICT_MATRIX = {
  undervalued: { up: '可关注', flat: '观察', weak: '左侧未确认', down: '回避' },
  mid: { up: '持有', flat: '持有观察', weak: '减仓观察', down: '回避' },
  overvalued: { up: '谨慎持有', flat: '谨慎', weak: '回避', down: '回避' },
}

/** 累计净值历史分位（%）：当前值在本地全部历史累计净值中的位置 */
export function navPercentile(series) {
  const vals = (series || []).map((p) => p.acc_nav).filter((v) => v != null && v > 0)
  if (vals.length < 2) return null
  const last = vals[vals.length - 1]
  const below = vals.filter((v) => v < last).length
  return (below / (vals.length - 1)) * 100
}

/** 位置分档：≥80% 高估区｜40–80% 中位区｜<40% 低估区 */
export function positionBandOf(percentile) {
  if (percentile == null) return 'unknown'
  if (percentile >= 80) return 'overvalued'
  if (percentile >= 40) return 'mid'
  return 'undervalued'
}

/** 趋势分档：≥+10% 向上｜0~+10% 偏平｜-10%~0 偏弱｜<-10% 向下 */
export function trendBandOf(ret1y) {
  if (ret1y == null || !Number.isFinite(ret1y)) return 'unknown'
  if (ret1y >= 10) return 'up'
  if (ret1y >= 0) return 'flat'
  if (ret1y >= -10) return 'weak'
  return 'down'
}

/**
 * 位置 × 趋势 → 核心结论
 * @param {'undervalued'|'mid'|'overvalued'|'unknown'} pos 位置分档
 * @param {'up'|'flat'|'weak'|'down'|'unknown'} trend 趋势分档
 * @returns {string} 可关注 / 持有 / 谨慎 / 回避 / 观察 等
 */
export function verdictOf(pos, trend) {
  if (pos === 'unknown') return '观察'
  if (trend === 'unknown') return pos === 'overvalued' ? '谨慎' : pos === 'mid' ? '持有观察' : '观察'
  return VERDICT_MATRIX[pos][trend]
}

/** 当日涨跌（%）：最新单位净值相对前一交易日；不足 2 个净值点返回 null */
export function dayChangePct(series) {
  const pts = (series || []).filter((p) => p.nav > 0)
  if (pts.length < 2) return null
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  if (!(prev.nav > 0)) return null
  return { pct: (last.nav / prev.nav - 1) * 100, navDate: last.date, prevDate: prev.date }
}

const POSITION_BAND_LABEL = {
  undervalued: '低估区',
  mid: '中位区',
  overvalued: '高估区',
  unknown: '数据不足',
}

const TREND_BAND_LABEL = {
  up: '向上',
  flat: '偏平',
  weak: '偏弱',
  down: '向下',
  unknown: '数据不足',
}

/** 回撤风险等级（|最大回撤| 分档） */
function drawdownRiskLevel(mddPct) {
  if (mddPct == null || !Number.isFinite(mddPct)) return '数据不足，无法评级'
  const d = Math.abs(mddPct)
  if (d < 10) return `低（最深跌 ${d.toFixed(2)}%，10% 以内）`
  if (d < 20) return `中（最深跌 ${d.toFixed(2)}%，10%–20%）`
  if (d < 30) return `高（最深跌 ${d.toFixed(2)}%，20%–30%）`
  return `极高（最深跌 ${d.toFixed(2)}%，30% 以上）`
}

function pct0(rate) {
  return `${(rate * 100).toFixed(2)}%`
}

function fmtPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return null
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

function fmtMoney(v) {
  if (v == null || !Number.isFinite(v)) return null
  return v.toFixed(2)
}

function dividendMethodLabel(m) {
  if (m === 'reinvest') return '红利再投'
  if (m === 'cash') return '现金分红'
  return '未查询到'
}

/** 持有天数阈值 → 人类可读（7 天 / 30 天 / 1 年 / 2 年） */
function holdingLabel(days) {
  if (days >= 365) return `${Math.round(days / 365)} 年`
  return `${days} 天`
}

/** 赎回费阶梯文本（真实规则，读 fees.js 的 REDEEM_TIERS，不猜） */
export function redeemTiersText() {
  const tiers = REDEEM_TIERS.map((t) => ({ ...t }))
  return tiers
    .map((t, i) => {
      const head =
        i === 0
          ? `持有<${holdingLabel(t.maxHoldingDays)}`
          : i === tiers.length - 1
            ? `持有≥${holdingLabel(tiers[i - 1].maxHoldingDays)}`
            : `持有<${holdingLabel(t.maxHoldingDays)}`
      return `${head} ${pct0(t.rate)}${t.penalty ? '（惩罚性）' : ''}`
    })
    .join('；')
}

// ─── 主入口：组装六段式报告 ─────────────────────────────────────────

/**
 * @param {object} input
 *   series        [{date, nav, acc_nav}] 按日期升序；acc_nav 缺失时回退 nav
 *   stats         { ret_1m/3m/6m/1y, annualVol, samples } 由调用方按累计净值口径算好
 *   drawdown      navlab.drawdownRecovery 的结果（全历史）
 *   position      { total_shares, total_cost, market_value, profit, profit_pct } | null
 *   portfolioMv   真实持仓组合总市值（算仓位定位用；无则 null）
 *   purchaseStatus / purchaseFeeRate(小数) / dividendMethod
 *   dividendRecords [{title, pub_time}] 分红除息识别或分红公告（只有标题与日期）
 *   catalysts     [{kind:'announce'|'stock_news', title, pub_time, source}]
 */
export function buildDeepAnalysis(input) {
  const { series, drawdown, position, portfolioMv } = input
  const stats = input.stats || {}

  const last = series.length ? series[series.length - 1] : null
  const dayChange = dayChangePct(series)
  const percentile = navPercentile(series)
  const posBand = positionBandOf(percentile)
  const trendBand = trendBandOf(stats.ret_1y)
  const verdict = verdictOf(posBand, trendBand)

  // ── 一、核心结论 ──
  const summaryParts = [
    stats.ret_1y != null ? `近1年 ${fmtPct(stats.ret_1y)}` : '近1年收益数据不足',
    stats.ret_3m != null ? `近3月 ${fmtPct(stats.ret_3m)}` : '近3月数据不足',
    drawdown ? `全历史最大回撤 ${fmtPct(drawdown.maxDrawdown)}` : '全历史最大回撤数据不足',
    percentile != null
      ? `累计净值处于历史 ${percentile.toFixed(1)}% 分位（${POSITION_BAND_LABEL[posBand]}）`
      : '累计净值历史分位数据不足',
  ]
  const summary = `${summaryParts.join('，')}，当前位置与趋势合看定性为「${verdict}」。`

  // ── 二、硬指标（8 行） ──
  const metrics = [
    {
      label: '最新单位净值',
      value: last ? last.nav.toFixed(4) : null,
      note: `累计净值 ${last ? last.acc_nav.toFixed(4) : '—'}${last ? ` · ${last.date}` : ''}`,
      source: '公开行情',
    },
    {
      label: '当日涨跌',
      value: dayChange ? fmtPct(dayChange.pct) : null,
      note: dayChange ? `${dayChange.navDate} 相对 ${dayChange.prevDate}` : '净值点不足 2 天，无法计算',
      source: '公开行情',
    },
    {
      label: '近1月 / 近3月',
      value: `${fmtPct(stats.ret_1m) ?? '—'} / ${fmtPct(stats.ret_3m) ?? '—'}`,
      note: '按累计净值的区间涨幅计算',
      source: '公开行情',
    },
    {
      label: '近6月 / 近1年',
      value: `${fmtPct(stats.ret_6m) ?? '—'} / ${fmtPct(stats.ret_1y) ?? '—'}`,
      note: '按累计净值的区间涨幅计算',
      source: '公开行情',
    },
    {
      label: '最大回撤（全历史）',
      value: drawdown ? fmtPct(drawdown.maxDrawdown) : null,
      note: '历史最高点到之后最低点的最深跌幅',
      source: '公开行情',
    },
    {
      label: '年化波动率',
      value: stats.annualVol != null ? fmtPct(stats.annualVol) : null,
      note: '累计净值日收益率标准差 × √252',
      source: '公开行情',
    },
    {
      label: '历史长度',
      value: stats.samples > 0 ? `${stats.samples} 天` : null,
      note: '本地已抓取的净值交易日数量',
      source: '公开行情',
    },
    {
      label: '累计净值历史分位',
      value: percentile != null ? `${percentile.toFixed(1)}%` : null,
      note: percentile != null ? `当前值在历史中的位置：${POSITION_BAND_LABEL[posBand]}` : '净值样本不足',
      source: '公开行情',
    },
  ]

  // 关键事实（2–3 条）
  const facts = []
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
  const catalysts = [...(input.catalysts || [])]
    .sort((a, b) => String(b.pub_time || '').localeCompare(String(a.pub_time || '')))
    .slice(0, 8)
  const catalystsNote =
    catalysts.length > 0
      ? '按发布时间倒序取最近 8 条；公告来自基金公司披露，新闻来自公共资讯接口。'
      : '暂无相关公告或新闻：这只基金近期没有抓取到的公告与重仓股新闻。'

  // ── 四、估值与业绩 ──
  const valuation = [
    {
      target: '本基金',
      metric: '历史分位 / 近1年',
      value:
        percentile != null
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
    metric: '申购 / 费率',
    value: `${input.purchaseStatus || '未查询到'} · 申购费率 ${input.purchaseFeeRate != null ? pct0(input.purchaseFeeRate) : '未查询到'}`,
  })
  valuation.push({
    target: '赎回费',
    metric: '持有天数阶梯',
    value: redeemTiersText(),
  })
  const divs = [...(input.dividendRecords || [])].sort((a, b) =>
    String(b.pub_time || '').localeCompare(String(a.pub_time || '')),
  )
  valuation.push({
    target: '分红记录',
    metric: '近 N 次 / 最近一次',
    value:
      divs.length > 0
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
  const signals = [
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
  const focus = [
    weightPct != null
      ? `仓位定位：该基金占你真实持仓总市值 ${weightPct.toFixed(1)}%，先明确它在你组合里扮演的角色，再决定要不要调整。`
      : '仓位定位：本地暂无完整的真实持仓市值数据，无法计算占比，可先在持仓页补全省份额与成本。',
    `分位与方向合看：当前 ${percentile != null ? `${percentile.toFixed(1)}%` : '未知'} 分位 × 近1年 ${fmtPct(stats.ret_1y) ?? '未知'}，定性「${verdict}」；位置便宜但趋势向下时不急于动作，位置偏高且趋势转弱时提高警惕。`,
    '同类对比：在「自选」页可对比该基金与其它自选基金的区间表现，同类排名数据本地未接入，以指数与自选对比为准。',
  ]
  const risks = []
  risks.push(
    drawdown
      ? `回撤风险：全历史最深跌 ${Math.abs(drawdown.maxDrawdown).toFixed(2)}%，买入前先确认这个跌幅扛不扛得住。`
      : '回撤风险：本地净值样本不足，回撤风险暂无法量化。',
  )
  if (posBand === 'overvalued') {
    risks.push(`位置风险：净值处于历史 ${percentile.toFixed(1)}% 分位的高位区，均值回归可能随时发生。`)
  }
  if (position && position.profit != null && position.profit < 0) {
    risks.push(
      `浮亏风险：该持仓当前浮亏 ¥${fmtMoney(Math.abs(position.profit))}（${fmtPct(position.profit_pct)}），割与不割取决于你对基本面的判断，不取决于亏了多少。`,
    )
  }
  risks.push(
    percentile != null && (stats.samples || 0) < 250
      ? '数据边界：本地净值历史不足 250 个交易日，分位与统计值的置信度有限，建议抓满历史后再看。'
      : '数据边界：分位与统计基于本地已抓取净值，若历史未抓全会影响准确性；结论仅供判断参考，不构成买卖建议。',
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
