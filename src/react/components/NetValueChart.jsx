import ReactECharts from '../lib/echarts'
import EmptyState from './EmptyState'
import { themeColor, isDark } from '../lib/theme'

// 通用净值/资产曲线图。categories=横轴标签，values=纵轴数值。
// 滚轮缩放 + 拖拽平移、玻璃态 tooltip、净值线轻微发光。
// ⚠️ ECharts 画在 canvas 上、读不到 CSS 变量 → 颜色用 themeColor() 取实际值，
//    且必须在**组件内**读取（模块顶层只执行一次，主题切换后不会更新）。
export default function NetValueChart({
  categories = [],
  values = [],
  height = 260,
  color,
  label = '净值曲线',
}) {
  if (!categories.length || !values.length) {
    return <EmptyState title="暂无曲线数据" hint="净值入库后自动出图" />
  }
  const AXIS_TEXT = themeColor('--text-soft', '#5b6675')
  const lineColor = color || themeColor('--accent', '#3b6ea5')
  const gridLine = themeColor('--border', '#e6e8ee')
  const strongLine = themeColor('--border-strong', '#cdd3dc')
  const accentSoft = themeColor('--accent-soft', 'rgba(59,110,165,0.12)')
  const dark = isDark()
  const tipBg = dark ? 'rgba(26,32,40,0.92)' : 'rgba(255,255,255,0.82)'
  const tipBorder = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.1)'
  const tipText = themeColor('--text', '#1f2430')

  // 把 #rrggbb 转 rgba
  const rgba = (hex, a) => {
    const m = String(hex).replace('#', '')
    const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  }
  const option = {
    grid: { left: 52, right: 18, top: 14, bottom: 40 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tipBg,
      borderColor: tipBorder,
      borderWidth: 1,
      textStyle: { color: tipText, fontSize: 13 },
      extraCssText:
        'backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.22); padding: 8px 12px;',
    },
    xAxis: {
      type: 'category',
      data: categories,
      boundaryGap: false,
      axisLabel: { color: AXIS_TEXT, fontSize: 12, hideOverlap: true },
      axisLine: { lineStyle: { color: gridLine } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: AXIS_TEXT, fontSize: 12 },
      splitLine: { lineStyle: { color: gridLine } },
    },
    dataZoom: [
      {
        type: 'inside',
        filterMode: 'none',
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
      },
      {
        type: 'slider',
        height: 16,
        bottom: 6,
        borderColor: 'transparent',
        fillerColor: accentSoft,
        handleStyle: { color: lineColor, borderColor: lineColor },
        moveHandleStyle: { color: lineColor },
        dataBackground: { lineStyle: { color: strongLine }, areaStyle: { color: gridLine } },
        selectedDataBackground: { lineStyle: { color: lineColor }, areaStyle: { color: accentSoft } },
        textStyle: { color: AXIS_TEXT, fontSize: 12 },
      },
    ],
    series: [
      {
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: values,
        lineStyle: { width: 2.2, color: lineColor, shadowColor: rgba(lineColor, 0.5), shadowBlur: 10 },
        itemStyle: { color: lineColor },
        emphasis: { focus: 'series' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: rgba(lineColor, 0.24) },
              { offset: 1, color: rgba(lineColor, 0) },
            ],
          },
        },
      },
    ],
  }
  // 图表对读屏软件是黑盒，外面包一句总述：这是什么图、区间多少
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return (
    <div role="img" aria-label={`${label}，共 ${values.length} 个数据点，区间 ${lo} 至 ${hi}`}>
      <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />
    </div>
  )
}
