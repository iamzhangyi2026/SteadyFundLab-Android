/**
 * 文本安全渲染工具
 * 包含：Inline, Markdown, Block, Chips, Metrics, Points, SectorLine, impactTone, splitBy, splitNameValue
 */

// ── 基础工具函数 ───────────────────────────────────────────────
export function splitBy(text, regex) {
  if (!text) return []
  return String(text).split(regex).filter(Boolean)
}

export function splitNameValue(text) {
  if (!text) return { name: '', value: '' }
  const idx = text.search(/[:：]/)
  if (idx < 0) return { name: text.trim(), value: '' }
  const name = text.slice(0, idx).trim()
  const value = text.slice(idx + 1).trim()
  return { name, value }
}

export function impactTone(impact) {
  if (!impact) return ''
  const s = String(impact).toLowerCase()
  if (s.includes('positive') || s.includes('利好')) return 'pos'
  if (s.includes('negative') || s.includes('利空')) return 'neg'
  if (s.includes('neutral') || s.includes('中性')) return 'neutral'
  return ''
}

// ── Inline 安全渲染 ─────────────────────────────────────────────
export function Inline({ text }) {
  if (!text) return null
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  return <span dangerouslySetInnerHTML={{ __html: withBold }} />
}

export function Markdown({ text }) {
  if (!text) return null
  let html = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  html = html.replace(/`(.+?)`/g, '<code style="background:var(--bg-2);padding:1px 4px;border-radius:4px;font-size:0.9em">$1</code>')
  html = html.replace(/\n/g, '<br/>')
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}

// ── 结构化文本组件 ──────────────────────────────────────────────
export function Block({ title, note, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={blockTitleStyle}>{title}</span>
        {note && <span style={blockNoteStyle}>{note}</span>}
      </div>
      <div style={blockContentStyle}>{children}</div>
    </div>
  )
}

export function Chips({ items }) {
  if (!items || !Array.isArray(items) || items.length === 0) return null
  return (
    <div style={chipsWrapStyle}>
      {items.map((item, i) => (
        <span key={i} style={chipStyle}>
          {typeof item === 'object' ? (item.name || item.value || JSON.stringify(item)) : String(item)}
        </span>
      ))}
    </div>
  )
}

export function Metrics({ items }) {
  if (!items || !Array.isArray(items)) return null
  return (
    <div style={metricsWrapStyle}>
      {items.map((m, i) => (
        <div key={i} style={metricItemStyle}>
          <span style={metricLabelStyle}>{m.name || m.label}</span>
          <span style={{ ...metricValStyle, color: m.positive === false ? 'var(--down)' : m.positive === true ? 'var(--up)' : 'inherit' }}>
            {m.value ?? m.val ?? ''}
          </span>
        </div>
      ))}
    </div>
  )
}

export function Points({ text, labeled }) {
  if (!text) return null
  const lines = splitBy(text, /\n/)
  return (
    <div style={{ padding: '4px 0' }}>
      {lines.map((line, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ color: 'var(--accent)', flexShrink: 0 }}>•</span>
          <span style={{ color: labeled ? 'var(--text-1)' : 'var(--text-soft)' }}>{line.trim()}</span>
        </div>
      ))}
    </div>
  )
}

export function SectorLine({ text }) {
  if (!text) return null
  const parts = splitBy(text, /\s*[,，;；/]\s*/)
  return (
    <div style={sectorWrapStyle}>
      {parts.map((p, i) => (
        <span key={i} style={{ ...sectorChipStyle, marginRight: i < parts.length - 1 ? 6 : 0 }}>
          {p.trim()}
        </span>
      ))}
    </div>
  )
}

// ── 样式 ────────────────────────────────────────────────────────
const blockTitleStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text)' }
const blockNoteStyle = { fontSize: 11, color: 'var(--text-soft)', marginLeft: 4 }
const blockContentStyle = { paddingLeft: 4 }
const chipsWrapStyle = { display: 'flex', flexWrap: 'wrap', gap: 6 }
const chipStyle = { background: 'var(--accent-soft)', borderRadius: 12, padding: '3px 10px', fontSize: 12, color: 'var(--accent)' }
const metricsWrapStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px' }
const metricItemStyle = { display: 'flex', flexDirection: 'column', gap: 2 }
const metricLabelStyle = { fontSize: 11, color: 'var(--text-soft)' }
const metricValStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text)' }
const sectorWrapStyle = { display: 'flex', flexWrap: 'wrap', gap: 4 }
const sectorChipStyle = { background: 'var(--accent-soft)', borderRadius: 10, padding: '2px 8px', fontSize: 11, color: 'var(--accent)' }
