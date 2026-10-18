// ─────────────────────────────────────────────
// event_key.ts · 从新闻/情报文本抽取关键词与实体（简单规则，无外部依赖）
// ─────────────────────────────────────────────

const CN_RE = /[\u4e00-\u9fa5]{2,8}/g
const EN_RE = /[A-Za-z][A-Za-z0-9._\-]{1,24}/g

const STOPWORDS = new Set([
  '我们', '他们', '市场', '今日', '昨日', '表示', '宣布', '报道', '消息', '根据',
  '公司', '中国', '美国', '数据', '显示', '方面', '已经', '可能', '以及', '对于',
  '一个', '这一', '目前', '相关', '基金', '股票', '板块', '投资', '预计', '由于',
])

/** 从文本中抽取关键词/实体列表（去重、按出现顺序）。 */
export function extractEventKeys(text: string): string[] {
  if (!text) return []
  const s = String(text)
  const keys: string[] = []
  const seen = new Set<string>()

  for (const m of s.match(CN_RE) || []) {
    if (STOPWORDS.has(m)) continue
    if (!seen.has(m)) { seen.add(m); keys.push(m) }
  }
  for (const m of s.match(EN_RE) || []) {
    const low = m.toLowerCase()
    if (seen.has(low)) continue
    seen.add(low); keys.push(m)
  }
  return keys
}
