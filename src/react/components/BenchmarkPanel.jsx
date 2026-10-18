// BenchmarkPanel.jsx · 基准对比（我的组合 vs 沪深300）
// 两条线都归一化到起点=100；数据不足时明说"还不足"，不造假。
import { useEffect, useState, useRef } from 'react'
import ReactECharts from '../lib/echarts'
import EmptyState from './EmptyState'
import { fetchBenchmarkCompare } from '../lib/dataAdapter'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'
import { themeColor, isDark } from '../lib/theme'

export default function BenchmarkPanel({ source = 'trade' }) {
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState(false)

  // ECharts 读不到 CSS 变量 → 组件内取实际值（主题切换后随重渲染更新）
  const AXIS_TEXT = themeColor('--text-soft', '#5b6675')
  const UP = themeColor('--up', '#E23B3B')
  const DOWN = themeColor('--down', '#1F9E5A')
  const BENCH = themeColor('--text-mute', '#8B95A7')
  const gridLine = themeColor('--border', 'rgba(15,23,42,0.12)')
  const splitLine = themeColor('--border', 'rgba(15,23,42,0.06)')
  const dark = isDark()
  const tipBg = dark ? 'rgba(26,32,40,0.92)' : 'rgba(255,255,255,0.9)'
  const tipBorder = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.1)'
  const tipText = themeColor('--text', '#1f2430')

  const load = async () => {
    setBusy(true)
    try {
      // 结构隔离：组合线按 source 取（'trade' 虚拟盘 / 'real' 真实持仓）
      const r = await fetchBenchmarkCompare('000300', 240, source)
      setD(r.ok ? r.data : null)
    } finally { setBusy(false) }
  }
  useEffect(() => { load() }, [source])
  // 下拉刷新
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => registerPullRefresh(() => loadRef.current?.()), [])

  if (d == null) return <EmptyState title="加载中" hint="正在拉取组合曲线与沪深300…" />
  if (d.insufficient) {
    return (
      <div>
        <EmptyState title="数据还不足" hint={d.reason} />
        <button className="btn btn-block" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={load}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>
    )
  }

  const option = {
    animation: false,
    grid: { left: 56, right: 16, top: 38, bottom: 40 },
    legend: { top: 4, textStyle: { color: AXIS_TEXT, fontSize: 12 } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg,
      borderColor: tipBorder,
      textStyle: { color: tipText, fontSize: 12 },
    },
    xAxis: {
      type: 'category',
      data: d.dates.map(s => String(s).slice(5)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: gridLine } },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
    },
    yAxis: {
      scale: true,
      name: '从 100 起算',
      nameTextStyle: { color: AXIS_TEXT, fontSize: 11 },
      axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      splitLine: { lineStyle: { color: splitLine } },
    },
    series: [
      {
        name: '我的组合', type: 'line', data: d.portfolio, smooth: true, showSymbol: false,
        lineStyle: { width: 2, color: UP }, itemStyle: { color: UP },
      },
      {
        name: '沪深300', type: 'line', data: d.benchmark, smooth: true, showSymbol: false,
        lineStyle: { width: 2, color: BENCH }, itemStyle: { color: BENCH },
      },
    ],
  }

  const excess = d.excess
  return (
    <div>
      <div className="hold-block" style={{ marginBottom: 10 }}>
        <div className="hold-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hold-row-name">我的组合</div>
            <div className="hold-row-sub">{d.snapDays} 个快照 · 从 100 起算</div>
          </div>
          <div className="hold-row-pct" style={{ color: d.portfolioRet >= 0 ? UP : DOWN }}>
            {d.portfolioRet >= 0 ? '+' : ''}{d.portfolioRet}%
          </div>
        </div>
        <div className="hold-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hold-row-name">沪深300</div>
            <div className="hold-row-sub">同期沪深300</div>
          </div>
          <div className="hold-row-pct" style={{ color: (d.benchmarkRet ?? 0) >= 0 ? UP : DOWN }}>
            {d.benchmarkRet != null ? (d.benchmarkRet >= 0 ? '+' : '') + d.benchmarkRet + '%' : '—'}
          </div>
        </div>
        <div className="hold-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hold-row-name">比沪深300多赚</div>
            <div className="hold-row-sub">{excess != null ? (excess >= 0 ? '跑赢沪深300' : '跑输沪深300') : '—'}</div>
          </div>
          <div className="hold-row-pct" style={{ color: (excess ?? 0) >= 0 ? UP : DOWN }}>
            {excess != null ? (excess >= 0 ? '+' : '') + excess + '%' : '—'}
          </div>
        </div>
      </div>

      <ReactECharts option={option} style={{ height: 300 }} />

      <div className="muted cell-note" style={{ marginTop: 8, lineHeight: 1.7 }}>
        组合线来自「每日收盘后自动记录」的资产快照；沪深300 为同期指数。两条线都从起点 100 起算，可直接比高低。
      </div>

      <button className="btn btn-block" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={load}>
        {busy ? '刷新中…' : '刷新'}
      </button>
    </div>
  )
}
