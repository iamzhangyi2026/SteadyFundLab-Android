// ─────────────────────────────────────────────
// briefing.ts · 每日决策简报
//
//
// 交易决策有时间窗口（15:00 截单），但对话里的 AI 不会一直在线。
// 14:30 把市场快照 / 持仓状态 / 约束条件整理好，再配一个明确问题
// （"今天的基金该怎么买？"），人一开对话，AI 读这份简报就能立刻作答。
//
// ⚠️ 简报不含任何模拟数据。抓不到就标注「无数据」，不编造填充。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { positionSummary } from './ledger.ts'
import { checkDiscipline, penaltyRisk } from './rules.ts'
import { status as coordStatus } from './coordinator.ts'
import { RISK_CONFIG } from './config.ts'
import { getBudget } from './budget.ts'

export const HOOK_TIME = '14:30'
export const DEFAULT_QUESTION = '今天的基金该怎么买？'

async function _settingNum(db: LedgerDb, key: string, def: number): Promise<number> {
  try {
    const rows = await db.query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [key])
    const v = rows[0]?.value
    return v == null || v === '' ? def : Number(v)
  } catch { return def }
}

async function _latestNav(db: LedgerDb, code: string): Promise<[string, number] | null> {
  const rows = await db.query<{ nav_date: string; v: number }>(
    `SELECT nav_date, COALESCE(acc_nav, nav) AS v FROM nav_daily
     WHERE fund_code = ? ORDER BY nav_date DESC LIMIT 1`, [code],
  )
  const r = rows[0]
  return r ? [r.nav_date, r.v] : null
}

async function _latestNavPair(db: LedgerDb, code: string): Promise<[number, number] | null> {
  const rows = await db.query<{ nav: number; acc_nav: number | null }>(
    `SELECT nav, acc_nav FROM nav_daily WHERE fund_code = ? ORDER BY nav_date DESC LIMIT 1`, [code],
  )
  const r = rows[0]
  if (!r) return null
  return [r.nav, r.acc_nav ?? r.nav]
}

export interface Briefing {
  generated_at: string
  as_of: string
  hook_time: string
  question: string
  mode: { effective: string; ai_online: boolean; idle_hours: number | null }
  /** 真实账本（本金用户自设，无「月配额」概念） */
  capital: { available: number; cash_balance: number; used_in_positions: number }
  positions: Record<string, unknown>[]
  intel_today: string[]
  risk_limits: { pos_max_single_pct: number; max_amount_per_order: number; account_stop_pct: number }
}

/** 生成决策简报（结构化，可直接渲染 markdown 给人读）。 */
export async function generate(
  db: LedgerDb, asOf?: string, question: string = DEFAULT_QUESTION,
): Promise<Briefing> {
  const as_of = asOf || new Date().toISOString().slice(0, 10)
  const coord = await coordStatus(db, await _settingStr(db, 'mode', 'auto'))
  // ⚠️ funds 表是全市场约 2.7 万只，遍历全表会跑 10 万+ 查询直接挂死；
  //    简报的「持仓状态」只应列**持仓**基金。
  // 结构隔离：简报的 capital 来自交易盘账本（getBudget）→ 持仓状态同语境取 'trade'
  const heldRows = await db.query<{ fund_code: string; fund_name: string | null }>(
    `SELECT DISTINCT l.fund_code, f.fund_name FROM lots l
     LEFT JOIN funds f ON f.fund_code = l.fund_code
     WHERE l.status='active' AND l.remaining_shares > 0 AND l.source='trade'`,
  )
  const funds = heldRows.map(r => ({ fund_code: r.fund_code, fund_name: r.fund_name || '' }))

  const positions: Record<string, unknown>[] = []
  for (const f of funds) {
    const code = f.fund_code
    const name = f.fund_name || ''
    const navInfo = await _latestNavPair(db, code)
    const navDay = await _latestNav(db, code)
    if (!navInfo || !navDay) {
      positions.push({ fund_code: code, fund_name: name, note: '无净值数据' })
      continue
    }
    const [nav, accNav] = navInfo
    const [navDate, accForDisplay] = navDay
    const pos = await positionSummary(db, code, nav)
    const lines = await checkDiscipline(db, code, nav, accNav, as_of).catch(() => [])
    const pen = await penaltyRisk(db, code, as_of).catch(() => null)
    positions.push({
      ...pos,
      fund_code: code, fund_name: name, nav_date: navDate, nav: Number(nav.toFixed(4)),
      discipline_lines: (lines || []).map((l: any) => ({ type: l.type, detail: l.detail, action: l.action })),
      penalty: pen,
      _acc: accForDisplay,
    })
  }

  // 资金段给真实账本（可用/现金/持仓市值），无「月配额」概念
  const budget = await getBudget().catch(() => null)

  return {
    generated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    as_of, hook_time: HOOK_TIME, question,
    mode: { effective: coord.effective_mode, ai_online: coord.ai_online, idle_hours: coord.idle_hours },
    capital: {
      available: Number((budget?.available ?? 0).toFixed(2)),
      cash_balance: Number((budget?.cash_balance ?? 0).toFixed(2)),
      used_in_positions: Number((budget?.used_in_positions ?? 0).toFixed(2)),
    },
    positions,
    intel_today: [],
    risk_limits: {
      pos_max_single_pct: await _settingNum(db, 'pos_max_single_pct', 25),
      max_amount_per_order: await _settingNum(db, 'max_amount_per_order', 5000),
      account_stop_pct: await _settingNum(db, 'risk_account_stop_pct', RISK_CONFIG.max_drawdown_stop_pct),
    },
  }
}

async function _settingStr(db: LedgerDb, key: string, def: string): Promise<string> {
  try {
    const rows = await db.query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [key])
    const v = rows[0]?.value
    return v == null || v === '' ? def : v
  } catch { return def }
}

/** 渲染成给人（和 AI）读的 markdown。 */
export function toMarkdown(b: Briefing): string {
  const L: string[] = []
  L.push(`# 决策简报 · ${b.as_of} ${b.hook_time}`)
  L.push('')
  L.push(`生成时间：${b.generated_at}`)
  L.push(`运行模式：${b.mode.effective}（AI ${b.mode.ai_online ? '在线' : '离线'}）`)
  L.push('')
  L.push('## 待决策问题')
  L.push('')
  L.push(`**${b.question}**`)
  L.push('')
  const c = b.capital
  L.push('## 资金')
  L.push('')
  L.push(`- 可用现金 ${c.available.toFixed(2)} 元（现金余额 ${c.cash_balance.toFixed(2)} 元）`)
  L.push(`- 持仓市值 ${c.used_in_positions.toFixed(2)} 元`)
  L.push(`- 唯一硬约束：下单不超可用现金；金额全由用户定，App 不设上限`)
  L.push('')
  L.push('## 持仓状态')
  L.push('')
  if (!b.positions.length) L.push('（无持仓）')
  for (const p of b.positions) {
    if ('note' in p) { L.push(`- ${p.fund_code} ${p.fund_name || ''}：${p.note}`); continue }
    L.push(`- **${p.fund_code} ${p.fund_name}**`)
    L.push(`  - 净值 ${p.nav}（${p.nav_date}）　市值 ${Number(p.market_value ?? 0).toFixed(2)} 元　盈亏 ${Number(p.profit_pct ?? 0).toFixed(2)}%`)
    for (const ln of (p.discipline_lines as any[]) || []) {
      L.push(`  - ⚠ 触发 ${ln.type}：${ln.detail} → 建议 ${ln.action}`)
    }
    const pen = p.penalty as any
    if (pen?.has_penalty_risk) L.push(`  - ⚠ ${pen.detail}`)
  }
  L.push('')
  const r = b.risk_limits
  L.push('## 风控边界（不可越界）')
  L.push('')
  L.push(`- 单只持仓上限 ${r.pos_max_single_pct}%`)
  L.push(`- 单笔金额上限 ${r.max_amount_per_order} 元`)
  L.push(`- 最大回撤止损 ${r.account_stop_pct}%`)
  L.push('')
  L.push('---')
  L.push('')
  L.push('_本简报不含模拟数据。抓不到的项标注为「无数据」，不得编造填充。_')
  return L.join('\n')
}
