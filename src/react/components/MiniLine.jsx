// MiniLine.jsx · 轻量折线图（纯 SVG，不依赖 ECharts）——组合资产曲线用。
// 账户页是首屏，不引入 ECharts（约 600KB）；简单走势用 SVG 足够。
import { themeColor } from '../lib/theme'

export default function MiniLine({
  categories = [], values = [], height = 140, color,
}) {
  if (!values.length) return null

  const lineColor = color || themeColor('--accent', '#3b6ea5')
  const areaFill = themeColor('--accent-soft', 'rgba(59,110,165,0.12)')

  const W = 320
  const H = height
  const pad = 10
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const n = values.length
  const x = (i) => pad + (i / Math.max(1, n - 1)) * (W - pad * 2)
  const y = (v) => H - pad - ((v - lo) / span) * (H - pad * 2)

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(n - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`
  const loV = values[0]
  const hiV = values[values.length - 1]

  return (
    <div className="mini-line">
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="组合资产曲线">
        <path d={area} fill={areaFill} />
        <path d={line} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <div className="mini-line-axis">
        <span>{String(categories[0] || '').slice(0, 10)}</span>
        <span className="mini-line-range">{loV != null ? `¥${Number(loV).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}` : ''} → {hiV != null ? `¥${Number(hiV).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}` : ''}</span>
        <span>{String(categories[categories.length - 1] || '').slice(0, 10)}</span>
      </div>
    </div>
  )
}
