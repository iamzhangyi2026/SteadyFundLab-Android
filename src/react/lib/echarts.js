// echarts 按需引入
//
// 为什么单独抽这个文件：图表组件若直接用 echarts-for-react 默认入口，
// 而 echarts-for-react 的默认入口内部是 `import * as echarts from 'echarts'`——
// **整包**引入，打包后独占 1.06MB（gzip 352KB），且总览页首屏就用到了饼图和折线图，
// 于是打开软件第一件事就是下载+解析这 1MB。
//
// 实际上本项目只用到三种图（饼/环、折线、热力图）和少数几个组件，
// 走 echarts 官方的按需引入（core + use）即可，体积能砍掉一大半。
//
// 使用方式不变：组件里 `import ReactECharts from '../lib/echarts'` 即可，
// 用法与 echarts-for-react 完全一致。
import React from 'react'
import * as echarts from 'echarts/core'
import { PieChart, LineChart, HeatmapChart, CandlestickChart } from 'echarts/charts'
import {
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  VisualMapComponent,
  TitleComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import ReactEChartsCore from 'echarts-for-react/lib/core'

echarts.use([
  PieChart,
  LineChart,
  HeatmapChart,
  CandlestickChart,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  VisualMapComponent,
  TitleComponent,
  CanvasRenderer,
])

// ⚠️ 必须显式把 echarts 实例传进去（core 入口不自带 echarts，需通过 props.echarts 传入）
//
// echarts-for-react 的 **/core 入口**与主入口不同：主入口自带 echarts，
// 而 core 的源码是 `this.echarts = props.echarts`（见 node_modules/echarts-for-react/lib/core.js:17）
// —— **不传就是 undefined**。
//
// 后果：图表不渲染，且组件卸载时 `componentWillUnmount` 里调
// `this.echarts.dispose()` 抛
// `TypeError: Cannot read properties of undefined (reading 'dispose')`，
// 被 ErrorBoundary 接住 → **整个页面变成「页面出错了」**（总览页就是这么崩的）。
//
// 包一层在这里注入，好处是各图表组件照旧写 `<ReactECharts option={...} />`，
// 不必每处都记得传 echarts —— 少一个可以忘的地方。
function ECharts(props) {
  return React.createElement(ReactEChartsCore, { echarts, ...props })
}

export default ECharts
export { echarts }
