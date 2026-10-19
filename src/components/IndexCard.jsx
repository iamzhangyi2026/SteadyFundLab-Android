// src/components/IndexCard.jsx · 指数卡（C9）
// ------------------------------------------------------------
// 实时点位 + 涨跌幅 + 近 60 日迷你走势（纯 SVG，不引图表库）。
// 点位/涨跌取腾讯行情；走势取东财前复权日线。取不到就显示「—」。

const fmt = (n) => (n == null ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

export default function IndexCard({ item, kline = [], active, onClick }) {
  const pts = kline.slice(-60).map((p) => p.close)
  const up = (item.pct ?? 0) >= 0
  const color = up ? 'var(--up)' : 'var(--down)'

  return (
    <button
      className={'idx-card' + (active ? ' idx-card-active' : '')}
      onClick={onClick}
      aria-label={item.name}
    >
      <div className="idx-head">
        <strong>{item.name}</strong>
        <span className="fund-code">{item.code}</span>
      </div>
      <div className="idx-value">{fmt(item.value)}</div>
      <div className={'idx-pct ' + (item.pct == null ? 'flat' : up ? 'up' : 'down')}>
        {item.pct == null ? '—' : `${item.pct > 0 ? '+' : ''}${item.pct.toFixed(2)}%`}
      </div>
      {pts.length > 1 ? <Spark pts={pts} color={color} /> : <div className="idx-nospark">暂无走势</div>}
      <div className="idx-time">{item.time || ''}</div>
    </button>
  )
}

function Spark({ pts, color }) {
  const w = 140
  const h = 38
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const d = pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * w
      const y = h - 3 - ((v - min) / span) * (h - 6)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="idx-spark">
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
