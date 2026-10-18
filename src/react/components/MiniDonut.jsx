// MiniDonut.jsx · 轻量环形图（纯 SVG，不依赖 ECharts）
//
// 为什么不直接用 DonutChart：它引入 ECharts（约 600KB），而账户页是首屏，
// 会显著拖慢启动。资产配置 / 组合行业暴露这类「分段占比」用 SVG 画足够。
// data = [{ name, value }]；unit='money' 时按金额格式化。
import { isDark } from '../lib/theme'

// 分类调色板：浅色底用深一档、深色底用亮一档（保证深色下依然分得开）
const PALETTE_LIGHT = [
  'var(--accent)', '#4fa3a5', '#5c9e6e', '#c99a3f', '#7a6bb5',
  '#4a7fb5', '#c1784f', '#b55c7e', '#6b9e4f', '#8a8f9c',
]
const PALETTE_DARK = [
  '#5b9be8', '#4fd1c5', '#68d391', '#f6c453', '#a78bfa',
  '#63a4e0', '#f0955c', '#ec7fa9', '#8fce6b', '#9aa3b2',
]

export default function MiniDonut({
  data = [], size = 148, thickness = 22, unit = '', centerLabel, centerValue,
}) {
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0)
  if (!data.length || total <= 0) return null

  const PALETTE = isDark() ? PALETTE_DARK : PALETTE_LIGHT

  const r = (size - thickness) / 2
  const c = size / 2
  const circ = 2 * Math.PI * r
  const fmt = (v) =>
    unit === 'money'
      ? '¥' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
      : `${v}${unit}`

  let offset = 0
  return (
    <div className="mini-donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="占比环形图">
        <g transform={`rotate(-90 ${c} ${c})`}>
          {data.map((d, i) => {
            const frac = (Number(d.value) || 0) / total
            const len = frac * circ
            const el = (
              <circle
                key={i} cx={c} cy={c} r={r} fill="none"
                stroke={PALETTE[i % PALETTE.length]} strokeWidth={thickness}
                strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset}
              />
            )
            offset += len
            return el
          })}
        </g>
        {(centerValue != null || centerLabel) && (
          <g>
            {centerValue != null && (
              <text x={c} y={c - 1} textAnchor="middle" className="mini-donut-value">{fmt(centerValue)}</text>
            )}
            {centerLabel && (
              <text x={c} y={c + 14} textAnchor="middle" className="mini-donut-label">{centerLabel}</text>
            )}
          </g>
        )}
      </svg>
      <ul className="mini-donut-legend">
        {data.map((d, i) => (
          <li key={i}>
            <span className="sw" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="nm">{d.name}</span>
            <span className="vl">{((Number(d.value) || 0) / total * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
