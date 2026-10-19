// src/components/SectorHeatmap.jsx · 行业板块热力图
// ------------------------------------------------------------
// 色块网格：涨红跌绿（A 股口径），透明度随涨跌幅加深。
// 只做展示，不构成板块推荐。

export default function SectorHeatmap({ sectors = [] }) {
  if (!sectors.length) {
    return <div className="callout">板块数据暂不可达，稍后下拉刷新重试。</div>
  }
  return (
    <div className="sector-grid">
      {sectors.map((s) => (
        <div
          className="sector-cell"
          key={s.code || s.name}
          style={{ background: bgOf(s.pct) }}
          title={`${s.name} ${s.pct > 0 ? '+' : ''}${s.pct.toFixed(2)}%`}
        >
          <span>{s.name}</span>
          <b>
            {s.pct > 0 ? '+' : ''}
            {s.pct.toFixed(2)}%
          </b>
        </div>
      ))}
    </div>
  )
}

function bgOf(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'var(--border)'
  const a = Math.min(0.78, 0.16 + (Math.abs(pct) / 6) * 0.62)
  return pct >= 0 ? `rgba(226, 59, 59, ${a})` : `rgba(31, 158, 90, ${a})`
}
