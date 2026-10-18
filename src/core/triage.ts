// ─────────────────────────────────────────────
// triage.ts · 新闻分拣引擎
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { extractEventKeys } from './event_key.ts'
import { resolveAlias } from './board_alias.ts'

export const CATEGORIES = ['macro', 'policy', 'geo', 'company', 'fund', 'sector', 'market', 'military', 'other']

const _CAT_KW: Record<string, string[]> = {
  policy: ['政策', '央行', '降准', '加息', '监管', '财政部', '国务院', '发文', '新规'],
  geo: ['国际', '美国', '中东', '地缘', '欧盟', '制裁', '关税', '乌克兰', '俄罗斯'],
  company: ['公司', '财报', '业绩', '营收', '利润', '董事长', '高管', 'ipo', '并购'],
  fund: ['基金', '定投', '净值', '基金经理', '份额', '申购', '赎回'],
  sector: ['板块', '行业', '赛道', '产业', '概念'],
  market: ['股市', 'a股', '港股', '美股', '指数', '涨跌', '收盘', '成交量', '行情'],
  military: ['军事', '军演', '装备', '国防', '导弹', '战机', '军队'],
  macro: ['gdp', '通胀', 'cpi', 'ppi', '失业率', '经济', '利率', '非农', '衰退'],
}
const _POS_KW = ['上涨', '利好', '增长', '提升', '超预期', '大涨', '复苏', '新高', '盈利', '上调', '突破']
const _NEG_KW = ['下跌', '利空', '下滑', '下降', '低于预期', '大跌', '暴跌', '亏损', '下调', '风险', '裁员', '违约']
const _SRC_HIGH = ['新华社', '人民日报', '央视', '央行', '证监会', '新华社客户端', '证券时报', '中国证券报']

function _classify(text: string): string {
  const low = text.toLowerCase()
  for (const cat of Object.keys(_CAT_KW)) {
    if (_CAT_KW[cat].some(kw => low.includes(kw))) return cat
  }
  return 'other'
}
function _impactDir(text: string): string {
  const low = text.toLowerCase()
  const pos = _POS_KW.filter(k => low.includes(k)).length
  const neg = _NEG_KW.filter(k => low.includes(k)).length
  if (pos > neg) return 'positive'
  if (neg > pos) return 'negative'
  return 'neutral'
}
function _credibility(text: string, source = ''): string {
  if (source && _SRC_HIGH.some(s => source.includes(s))) return 'high'
  if (/\d/.test(text) && ['公司', '央行', '工信部', '统计局'].some(k => text.includes(k))) return 'medium'
  return 'low'
}

export interface TriageResult {
  category: string
  impact_dir: string
  credibility: string
  impact_boards: string[]
  summary: string
}

/** 解析一段新闻文本为结构化字段。任何异常都返回安全默认。 */
export function triageNews(text: string, category?: string): TriageResult {
  try {
    const t = String(text || '')
    const summary = t.slice(0, 120).trim()
    const cat = (category && CATEGORIES.includes(category)) ? category : _classify(t)
    const boards: string[] = []
    for (const k of extractEventKeys(t)) {
      if (k.length >= 2 && k.length <= 5 && /[\u4e00-\u9fa5]/.test(k)) {
        const canonical = resolveAlias(k)
        if (!boards.includes(canonical)) boards.push(canonical)
      }
    }
    return { category: cat, impact_dir: _impactDir(t), credibility: _credibility(t), impact_boards: boards, summary }
  } catch {
    return { category: category || 'other', impact_dir: 'neutral', credibility: 'low', impact_boards: [], summary: String(text || '').slice(0, 120) }
  }
}

/** 读取 news_triage。category='all' 不过滤。 */
export async function getTriage(db: LedgerDb, category = 'all', limit = 300): Promise<Record<string, unknown>[]> {
  try {
    if (category && category !== 'all') {
      return await db.query('SELECT * FROM news_triage WHERE category = ? ORDER BY id DESC LIMIT ?', [category, limit])
    }
    return await db.query('SELECT * FROM news_triage ORDER BY id DESC LIMIT ?', [limit])
  } catch { return [] }
}

/** 流式 UI 用：等价于 getTriage(all)。 */
export function streamTriage(db: LedgerDb, limit = 50) { return getTriage(db, 'all', limit) }

/** 对缺失 category / impact_dir 的行重新打分。返回计数。 */
export async function runTriage(db: LedgerDb): Promise<{ rescored: number; total: number }> {
  let rescored = 0
  let total = 0
  try {
    const rows = await db.query<{ id: number; title: string | null; summary: string | null; category: string | null; impact_dir: string | null; credibility: string | null }>(
      `SELECT id, title, summary, category, impact_dir, credibility FROM news_triage
       WHERE category IS NULL OR category='' OR impact_dir IS NULL OR impact_dir=''`,
    )
    for (const r of rows) {
      const res = triageNews(`${r.title || ''} ${r.summary || ''}`, r.category || undefined)
      const cat = r.category || res.category
      const impact = r.impact_dir || res.impact_dir
      const cred = r.credibility || res.credibility
      await db.run('UPDATE news_triage SET category=?, impact_dir=?, credibility=? WHERE id=?', [cat, impact, cred, r.id])
      rescored++
    }
    const cnt = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM news_triage')
    total = cnt[0]?.c ?? 0
  } catch { /* ignore */ }
  return { rescored, total }
}
