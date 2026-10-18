// IndexKlinePanel.jsx · 指数日 K 线（ECharts 蜡烛图）
// 数据：push2his 日K（fetchIndexKlineFor）。抓不到 → 明确说"取不到"，不造假。
// 红涨绿跌（中国习惯）。
import { useEffect, useState } from 'react'
import ReactECharts from '../lib/echarts'
import EmptyState from './EmptyState'
import { fetchIndexKlineFor } from '../lib/dataAdapter'
import { themeColor, isDark } from '../lib/theme'

export default function IndexKlinePanel({ code, name }) {
  const [bars, setBars] = useState(null)
  const [busy, setBusy] = useState(false)

  // ECharts 读不到 CSS 变量 → 组件内取实际值（主题切换后随重渲染更新）
  const AXIS_TEXT = themeColor('--text-soft', '#5b6675')
  const UP = themeColor('--up', '#E23B3B')
  const DOWN = themeColor('--down', '#1F9E5A')
  const gridLine = themeColor('--border', 'rgba(15,23,42,0.12)')
  const splitLine = themeColor('--border', 'rgba(15,23,42,0.06)')
  const dark = isDark()
  const tipBg = dark ? 'rgba(26,32,40,0.92)' : 'rgba(255,255,255,0.9)'
  const tipBorder = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.1)'
  const tipText = themeColor('--text', '#1f2430')

  const load = async () => {
    setBusy(true)
    try {
      const r = await fetchIndexKlineFor(code, 120)
      setBars(r.ok ? (r.data || []) : [])
    } finally { setBusy(false) }
  }

  useEffect(() => { load() }, [code])

  if (bars == null) return <EmptyState title="加载中" hint="正在拉取指数日K…" />
  if (!bars.length) {
    return <EmptyState title="取不到数据" hint="该指数日K暂时取不到（网络或数据源问题）——不是没有，是没拿到，稍后再试。" />
  }

  const cats = bars.map(b => b.date.slice(5))
  const data = bars.map(b => [b.open, b.close, b.low, b.high])   // ECharts 蜡烛顺序：[开, 收, 低, 高]
  const option = {
    animation: false,
    grid: { left: 58, right: 16, top: 18, bottom: 44 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg,
      borderColor: tipBorder,
      textStyle: { color: tipText, fontSize: 12 },
    },
    xAxis: {
      type: 'category',
      data: cats,
      boundaryGap: true,
      axisLine: { lineStyle: { color: gridLine } },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
    },
    yAxis: {
      scale: true,
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: { lineStyle: { color: splitLine } },
    },
    dataZoom: [{ type: 'inside', start: 40, end: 100 }],
    series: [{
      type: 'candlestick',
      data,
      itemStyle: {
        color: UP, color0: DOWN,          // 阳线红 / 阴线绿（中国习惯）
        borderColor: UP, borderColor0: DOWN,
      },
    }],
  }

  return (
    <div>
      <div className="muted cell-note" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        {name || code} · 近 {bars.length} 个交易日 · 红涨绿跌 · 可双指缩放/拖动
      </div>
      <ReactECharts option={option} style={{ height: 320 }} />
      <button className="btn btn-block" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={load}>
        {busy ? '刷新中…' : '刷新'}
      </button>
    </div>
  )
}
