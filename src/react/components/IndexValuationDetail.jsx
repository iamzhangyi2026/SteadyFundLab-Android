// IndexValuationDetail.jsx · 指数估值详情（二级页）
// 展示：当前估值 + PE 分位可视化条 + 历史 PE 走势曲线。
// 历史数据源：中证指数官网（仅收录中证系列）；深证系列（399xxx）不覆盖 → 如实提示，不造假。
import { useCallback, useEffect, useMemo, useState } from 'react'
import Modal from './Modal'
import EmptyState from './EmptyState'
import ReactECharts from '../lib/echarts'
import { fetchIndexPeHistoryFor } from '../lib/dataAdapter'
import { themeColor, isDark } from '../lib/theme'

const EVA = {
  low: { label: '低估', cls: 'ok' },
  mid: { label: '适中', cls: 'warn' },
  high: { label: '高估', cls: 'bad' },
}
const pct1 = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const num2 = (v) => (v == null || v === 0 ? '—' : Number(v).toFixed(2))

// 分位可视化条：0~100%，标注当前分位位置（低估<30% / 适中 30~70% / 高估>70%）
function PercentileBar({ value }) {
  const v = value == null ? null : Math.max(0, Math.min(1, value))
  return (
    <div className="pctl-wrap">
      <div className="pctl-bar">
        <span className="pctl-seg seg-low" style={{ width: '30%' }} />
        <span className="pctl-seg seg-mid" style={{ width: '40%' }} />
        <span className="pctl-seg seg-high" style={{ width: '30%' }} />
        {v != null && <span className="pctl-marker" style={{ left: `${v * 100}%` }} />}
      </div>
      <div className="pctl-scale">
        <span>0%</span><span>30%</span><span>70%</span><span>100%</span>
      </div>
      <div className="muted cell-note" style={{ marginTop: 6 }}>
        当前历史位置 <b>{pct1(value)}</b> —— 越低越便宜
      </div>
    </div>
  )
}

export default function IndexValuationDetail({ open, onClose, item }) {
  const [hist, setHist] = useState(null) // null=加载中 / []=无数据
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // ECharts 读不到 CSS 变量 → 组件内取实际值（主题切换后随重渲染更新）
  const dark = isDark()
  const AXIS_TEXT = themeColor('--text-soft', '#5b6675')
  const gridLine = themeColor('--border', '#e3e6ea')
  const splitLine = themeColor('--border', '#f0f2f4')
  const accent = themeColor('--accent', '#3b6ea5')
  const accentSoft = themeColor('--accent-soft', 'rgba(59,110,165,0.12)')
  const tipBg = dark ? 'rgba(26,32,40,0.92)' : 'rgba(255,255,255,0.92)'
  const tipText = themeColor('--text', '#26313d')

  const load = useCallback(async () => {
    if (!item?.index_code) { setHist([]); return }
    setBusy(true); setErr('')
    try {
      const r = await fetchIndexPeHistoryFor(item.index_code)
      if (!r.ok) { setErr(r.error || '取数失败'); setHist([]); return }
      setHist(r.data || [])
    } finally { setBusy(false) }
  }, [item?.index_code])
  useEffect(() => { if (open) load() }, [open, load])

  const option = useMemo(() => {
    if (!hist || !hist.length) return null
    const dates = hist.map((h) => h.date)
    const pes = hist.map((h) => h.pe)
    const lo = Math.min(...pes), hi = Math.max(...pes)
    return {
      grid: { left: 46, right: 14, top: 16, bottom: 44 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: tipBg,
        borderColor: gridLine,
        textStyle: { color: tipText, fontSize: 12 },
        formatter: (ps) => {
          const p = Array.isArray(ps) ? ps[0] : ps
          return p ? `${p.axisValue}<br/>市盈率 <b>${Number(p.data).toFixed(2)}</b>` : ''
        },
      },
      xAxis: {
        type: 'category', data: dates, boundaryGap: false,
        axisLine: { lineStyle: { color: gridLine } },
        axisTick: { show: false },
        axisLabel: { color: AXIS_TEXT, fontSize: 11, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        min: Math.floor(lo * 0.95), max: Math.ceil(hi * 1.05),
        splitLine: { lineStyle: { color: splitLine } },
        axisLabel: { color: AXIS_TEXT, fontSize: 11 },
      },
      series: [{
        type: 'line', data: pes, smooth: true, showSymbol: false,
        lineStyle: { color: accent, width: 2 },
        areaStyle: { color: accentSoft },
      }],
    }
  }, [hist, dark])

  if (!item) return null
  const eva = EVA[item.eva_type] || { label: item.eva_type || '—', cls: 'warn' }

  return (
    <Modal open={open} title={`${item.name} 估值详情`} onClose={onClose} width={420}>
      <div className="ivd-head">
        <span className="muted ivd-code">{item.index_code}</span>
        <span className={`ov-tag ${eva.cls}`}>{eva.label}</span>
      </div>

      <div className="muted cell-note" style={{ margin: '6px 0', lineHeight: 1.6 }}>
        「历史位置」＝现在的估值在它自己历史上排哪：<b>0% 最便宜、100% 最贵，越低越便宜</b>。
      </div>

      <div className="ivd-stats">
        <div className="ivd-stat"><span className="muted">市盈率</span><b>{num2(item.pe)}</b></div>
        <div className="ivd-stat"><span className="muted">市净率</span><b>{num2(item.pb)}</b></div>
        <div className="ivd-stat"><span className="muted">市盈率历史位置</span><b>{pct1(item.pe_percentile)}</b></div>
        <div className="ivd-stat"><span className="muted">市净率历史位置</span><b>{pct1(item.pb_percentile)}</b></div>
        <div className="ivd-stat"><span className="muted">股息率</span><b>{pct1(item.yeild)}</b></div>
      </div>

      <div className="ivd-section-title">市盈率历史位置</div>
      <PercentileBar value={item.pe_percentile} />

      <div className="ivd-section-title">历史市盈率走势</div>
      {hist == null ? (
        <EmptyState title="加载中" hint="正在拉取历史市盈率…" />
      ) : hist.length ? (
        <>
          <ReactECharts option={option} style={{ height: 220 }} notMerge />
          <div className="muted cell-note" style={{ marginTop: 6 }}>
            {hist[0].date} ~ {hist[hist.length - 1].date} · 共 {hist.length} 个交易日 · 数据源：中证指数官网
          </div>
        </>
      ) : (
        <EmptyState
          title="暂无历史市盈率曲线"
          hint={err
            ? `历史估值暂时取不到（${err}）—— 稍后再试。`
            : '该指数不在中证指数官网收录范围（官网仅收录中证系列，深证系列不覆盖）—— 不是没有，是数据源不覆盖。'}
        />
      )}
      <button className="btn btn-block" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={load}>
        {busy ? '刷新中…' : '刷新'}
      </button>
    </Modal>
  )
}
