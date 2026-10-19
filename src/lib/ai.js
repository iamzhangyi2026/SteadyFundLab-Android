// src/lib/ai.js · AI 决策 + 纪律线（B 类独有）
// ------------------------------------------------------------
// ⚠️ 诚实说明：本模块**没有接大模型**（没有密钥，也不该在客户端硬编码密钥）。
// 它做的是「规则决策引擎」：用六段式同一套分位/趋势/回撤口径，
// 把结论翻译成可执行的纪律线（仓位上限、加仓/减仓条件、复核线）。
//
// UI 上必须明确标注「规则结论 · 未接大模型」，不能把它说成 AI 生成。
// 以后接了真 LLM，只需在调用方把 mode 换成 'llm'，本模块的纪律线仍可作为兜底。

import { positionBandOf, trendBandOf, verdictOf } from './deep_analysis.js'

/** 位置 → 单只仓位上限（占组合市值%） */
const POSITION_CAP = { undervalued: 30, mid: 20, overvalued: 10, unknown: 10 }

/**
 * 生成决策纪律线
 * @param {{name?:string, percentile:number|null, ret1y:number|null, mdd:number|null,
 *          vol:number|null, weightPct:number|null}} p
 * @returns {object}
 */
export function buildDecision({ name, percentile, ret1y, mdd, vol, weightPct }) {
  const pos = positionBandOf(percentile)
  const trend = trendBandOf(ret1y)
  const verdict = verdictOf(pos, trend)
  const cap = POSITION_CAP[pos] ?? 10

  const lines = []

  // 1) 仓位纪律
  if (weightPct != null) {
    if (weightPct > cap) {
      lines.push({
        kind: 'risk',
        title: '仓位超上限',
        text: `当前占组合 ${weightPct.toFixed(1)}%，高于「${pos === 'overvalued' ? '高估区' : pos === 'mid' ? '中位区' : '低估区'}」建议上限 ${cap}%。若要降，优先降到 ${cap}% 以内。`,
      })
    } else {
      lines.push({
        kind: 'ok',
        title: '仓位在纪律内',
        text: `当前占组合 ${weightPct.toFixed(1)}%，未超过建议上限 ${cap}%。`,
      })
    }
  } else {
    lines.push({
      kind: 'info',
      title: '仓位未计算',
      text: '账本缺少完整份额/市值，无法计算占组合比例，先补全持仓再谈仓位纪律。',
    })
  }

  // 2) 加仓条件
  lines.push({
    kind: pos === 'undervalued' && trend !== 'down' ? 'ok' : 'info',
    title: '加仓条件',
    text:
      pos === 'undervalued'
        ? trend === 'down'
          ? '位置已在低估区，但趋势仍向下 —— 左侧未确认，最多小额定投，不重仓抄底。'
          : '位置在低估区且趋势不再向下，可按月定投分批建仓，不一次性打满。'
        : `当前位置是「${pos === 'overvalued' ? '高估区' : pos === 'mid' ? '中位区' : '数据不足'}」，不满足加仓条件；等分位回到 40% 以下再看。`,
  })

  // 3) 减仓 / 复核条件
  lines.push({
    kind: pos === 'overvalued' && trend === 'down' ? 'risk' : 'info',
    title: '减仓 / 复核条件',
    text:
      pos === 'overvalued' && trend === 'down'
        ? '高估区 + 趋势向下，属于最需要提高警惕的组合；先复核持有理由，再决定是否降仓。'
        : pos === 'overvalued'
          ? '位置偏高但趋势还在，继续持有也要设复核线：分位突破 90% 或近 1 年收益转负，就重新评估。'
          : '暂不触发减仓条件；每季度复核一次分位与近 1 年收益即可。',
  })

  // 4) 回撤纪律
  lines.push({
    kind: mdd != null && Math.abs(mdd) >= 30 ? 'risk' : 'info',
    title: '回撤纪律',
    text:
      mdd == null
        ? '历史回撤数据不足，无法设定回撤纪律。'
        : `全历史最大回撤 ${mdd.toFixed(2)}%。买入前先确认：再出现一次同等跌幅，你是否扛得住；扛不住就别用这个仓位。`,
  })

  // 5) 定投纪律
  lines.push({
    kind: 'info',
    title: '定投纪律',
    text:
      pos === 'overvalued'
        ? '高估区暂停新增定投，已有定投可继续但不再加码。'
        : pos === 'undervalued'
          ? '低估区可维持或适度提高定投额，但单月不超过计划额的 1.5 倍。'
          : '中位区按原计划定投，不因短期涨跌临时改额度。',
  })

  return {
    mode: 'rule',
    modeLabel: '规则结论 · 未接大模型',
    name: name || '',
    verdict,
    positionBand: pos,
    trendBand: trend,
    positionCap: cap,
    percentile,
    ret1y,
    mdd,
    vol,
    weightPct,
    lines,
    disclaimer: '以上为本地规则引擎按分位/趋势/回撤生成的纪律线，不是 AI 生成内容，也不构成投资建议。',
  }
}
