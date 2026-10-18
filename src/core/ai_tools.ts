// ─────────────────────────────────────────────
// ai_tools.ts · AI 工具集成
//
// 4 个工具：analyze_fund / summarize_news / screen_candidates / check_discipline
//
// ⚠️ 只做「取数 + 组装 + 写人话」，**不替用户做买卖决定**。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { simpleChat } from './llm_client.ts'

export interface AiToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const TOOLS: Record<string, AiToolDef> = {
  analyze_fund: {
    name: 'analyze_fund',
    description: '分析单只基金的估值、趋势、风险',
    parameters: {
      type: 'object',
      properties: {
        fund_code: { type: 'string', description: '基金代码' },
        fund_name: { type: 'string', description: '基金名称' },
      },
      required: ['fund_code'],
    },
  },
  summarize_news: {
    name: 'summarize_news',
    description: '对新闻进行摘要，提取关键信息',
    parameters: {
      type: 'object',
      properties: {
        news_text: { type: 'string', description: '新闻内容' },
        focus: { type: 'string', description: "关注点，如'行业影响'、'政策导向'" },
      },
      required: ['news_text'],
    },
  },
  screen_candidates: {
    name: 'screen_candidates',
    description: '在基金池中筛选候选标的',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回数量' },
        criteria: { type: 'string', description: '筛选条件' },
      },
      required: [],
    },
  },
  check_discipline: {
    name: 'check_discipline',
    description: '检查交易决策是否符合投资纪律',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作类型: buy/sell/hold' },
        fund_code: { type: 'string', description: '基金代码' },
        amount: { type: 'number', description: '金额' },
        current_position_pct: { type: 'number', description: '当前仓位百分比' },
      },
      required: ['action'],
    },
  },
}

export function getTools(): Record<string, AiToolDef> { return TOOLS }

export async function callTool(
  db: LedgerDb, toolName: string, params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case 'analyze_fund': return _analyzeFund(db, params)
    case 'summarize_news': return _summarizeNews(db, params)
    case 'screen_candidates': return _screenCandidates(db, params)
    case 'check_discipline': return _checkDiscipline(db, params)
    default: return { error: `未知工具: ${toolName}` }
  }
}

async function _analyzeFund(db: LedgerDb, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const fundCode = String(params.fund_code || '')
  const fundName = String(params.fund_name || '')
  const prompt = `请分析基金 ${fundCode} ${fundName}：
1. 当前估值水平（历史分位）
2. 近期趋势（近3月、近1年收益率）
3. 主要风险点
4. 投资建议

请给出简洁的分析报告。`
  const content = await simpleChat(db, prompt)
  return { tool: 'analyze_fund', fund_code: fundCode, analysis: content }
}

async function _summarizeNews(db: LedgerDb, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const newsText = String(params.news_text || '')
  const focus = String(params.focus || '')
  const prompt = `请对以下财经新闻进行摘要：

${newsText}

关注点：${focus || '整体影响'}

请提取关键信息，控制在200字以内。`
  const content = await simpleChat(db, prompt)
  return { tool: 'summarize_news', summary: content }
}

async function _screenCandidates(db: LedgerDb, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const limit = Number(params.limit ?? 5)
  const criteria = String(params.criteria || '')
  const prompt = `请在基金池中筛选候选标的：
筛选条件：${criteria || '估值洼地+趋势向上'}
返回数量：${limit}

请列出基金代码、名称、关键指标。`
  const content = await simpleChat(db, prompt)
  return { tool: 'screen_candidates', candidates: content }
}

/** 读 app_settings 数值参数（11 AI 开放：纪律检查反映用户自己的参数，缺省回退默认值） */
async function _settingNum(db: LedgerDb, key: string, def: number): Promise<number> {
  try {
    const rows = await db.query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [key])
    const v = rows[0]?.value
    return v == null || v === '' ? def : Number(v)
  } catch { return def }
}

async function _checkDiscipline(db: LedgerDb, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = String(params.action || '')
  const fundCode = String(params.fund_code || '')
  const amount = Number(params.amount ?? 0)
  const posPct = Number(params.current_position_pct ?? 0)
  // 风控检查按用户自己设定的参数执行，不内置固定条款；
  // 参数未设置时给通用版提示（不假装有一套权威 SOP）。
  const posMax = await _settingNum(db, 'pos_max_single_pct', 25)
  const stopLoss = await _settingNum(db, 'discipline_stop_loss', -5)
  const profitTake = await _settingNum(db, 'discipline_profit_take', 20)
  const prompt = `请按用户自己设定的参数检查以下交易决策：
操作：${action}
基金：${fundCode}
金额：${amount}元
当前仓位：${posPct}%

用户设定的提醒参数（只提醒、不拦截，买不卖最终由用户决定）：
1. 单只基金占总资产超过 ${posMax}% 时提醒集中
2. 亏损到 ${stopLoss}% 提醒认错离场；浮盈到 ${profitTake}% 提醒兑现
3. 若未设置某项，按常规仓位管理常识提醒，不要引用任何内置条款

请对照以上参数给出结论和建议；没命中就明说没命中，不编造。`
  const content = await simpleChat(db, prompt)
  return { tool: 'check_discipline', result: content }
}
