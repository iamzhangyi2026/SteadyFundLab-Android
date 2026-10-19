// src/lib/intel.js · 情报事件分类（规则版，不依赖大模型）
// ------------------------------------------------------------
// 把基金公告标题按关键词归到可行动的事件类型：
//   风险 / 分红 / 人事 / 发行 / 业绩 / 其他
//
// 只做标题分类，不推断公告内容、不编造影响。
// 分类规则按「风险优先」排序：一条标题同时命中多个时，取最需要关注的那个。

const RULES = [
  { type: '风险', tone: 'danger', re: /风险|清盘|终止|诉讼|处罚|预警|暂停上市|巨额赎回/ },
  { type: '分红', tone: 'teal', re: /分红|收益分配|派息/ },
  { type: '人事', tone: 'warn', re: /基金经理|任职|离任|变更|聘任|增聘/ },
  { type: '发行', tone: 'info', re: /发售|募集|成立|开放申购|限购|恢复申购|暂停申购|封闭期/ },
  { type: '业绩', tone: 'info', re: /业绩|季报|年报|中报|半年报|净值|收益率/ },
]

const FALLBACK = { type: '其他', tone: '' }

/** 单条标题 → { type, tone } */
export function classifyEvent(title) {
  const s = String(title || '')
  for (const r of RULES) {
    if (r.re.test(s)) return { type: r.type, tone: r.tone }
  }
  return { ...FALLBACK }
}

/**
 * 公告列表 → 带事件标签的列表 + 类型计数
 * @param {Array<{title,date}>} announcements
 */
export function buildEvents(announcements) {
  const rows = (announcements || []).map((a) => {
    const e = classifyEvent(a.title)
    return { ...a, eventType: e.type, tone: e.tone }
  })
  const counts = {}
  for (const r of rows) counts[r.eventType] = (counts[r.eventType] || 0) + 1
  return { rows, counts }
}
