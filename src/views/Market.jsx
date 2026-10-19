// src/views/Market.jsx · 大盘指数页（C9）
// ------------------------------------------------------------
// 入口在「发现」页。五大指数实时点位 + 涨跌 + 近 60 日走势；
// 点某个指数看近 120 日 K 线（前复权收盘价）。
// 只展示指数本身，不做个股/板块推荐。

import { useEffect, useState } from 'react'
import { INDICES, loadMarketOverview, fetchIndexKline } from '../lib/market.js'
import { fetchSectors } from '../lib/sectors.js'
import IndexCard from '../components/IndexCard.jsx'
import SectorHeatmap from '../components/SectorHeatmap.jsx'
import { usePullRefresh } from '../lib/usePullRefresh.js'

export default function Market() {
  const [state, setState] = useState({ status: 'loading', indices: [], kline: [] })
  const [active, setActive] = useState('000300')
  const [detail, setDetail] = useState({ code: '', kline: [], loading: false })
  const [sectors, setSectors] = useState([])
  const [reloadKey, setReloadKey] = useState(0)

  usePullRefresh(() => setReloadKey((k) => k + 1))

  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, status: 'loading' }))
    loadMarketOverview()
      .then((r) => {
        if (!alive) return
        setState({ status: 'ok', indices: r.indices, kline: r.kline })
      })
      .catch(() => alive && setState({ status: 'error', indices: [], kline: [] }))
    return () => {
      alive = false
    }
  }, [reloadKey])

  useEffect(() => {
    const hit = INDICES.find((i) => i.code === active)
    if (!hit) return
    let alive = true
    setDetail((d) => ({ ...d, loading: true }))
    fetchIndexKline(hit.secid, 120)
      .then((kline) => alive && setDetail({ code: hit.code, kline, loading: false }))
      .catch(() => alive && setDetail({ code: hit.code, kline: [], loading: false }))
    return () => {
      alive = false
    }
  }, [active, reloadKey])

  useEffect(() => {
    let alive = true
    fetchSectors(40)
      .then((r) => alive && setSectors(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reloadKey])

  const activeIndex = state.indices.find((i) => i.code === active)
  const detailKline = detail.code === active ? detail.kline : []

  return (
    <>
      <div className="section-title">大盘指数</div>
      <div className="idx-grid">
        {state.status === 'loading'
          ? INDICES.map((i) => (
              <div className="idx-card idx-skeleton" key={i.code}>
                <div className="skeleton" style={{ height: 14, width: '60%' }} />
                <div className="skeleton" style={{ height: 22, width: '45%', marginTop: 10 }} />
              </div>
            ))
          : state.indices.map((i) => (
              <IndexCard
                key={i.code}
                item={i}
                kline={i.kline || []}
                active={i.code === active}
                onClick={() => setActive(i.code)}
              />
            ))}
      </div>

      <div className="section-title">
        {activeIndex ? `${activeIndex.name} · 近 120 日` : '近 120 日'}
      </div>
      <div className="card">
        {detail.loading ? (
          <div className="skeleton" style={{ height: 140 }} />
        ) : detailKline.length > 1 ? (
          <KlineChart data={detailKline} up={(detailKline[detailKline.length - 1].close ?? 0) >= (detailKline[0].close ?? 0)} />
        ) : (
          <div className="callout">暂未取到 K 线数据（接口不可达），稍后下拉刷新重试。</div>
        )}
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          数据源：腾讯前复权日线。指数点位仅用于观察市场环境，不构成投资建议。
        </p>
      </div>

      <div className="section-title">行业板块</div>
      <div className="card">
        <SectorHeatmap sectors={sectors} />
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          涨红跌绿，色块越深涨跌幅越大。按板块当日涨跌幅排序，仅展示，不构成板块推荐。
        </p>
      </div>

      <p className="card-note" style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
        下拉可刷新全部指数与板块。
      </p>
    </>
  )
}

function KlineChart({ data, up }) {
  const w = 320
  const h = 150
  const closes = data.map((p) => p.close)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1
  const path = data
    .map((p, i) => {
      const x = (i / (data.length - 1)) * w
      const y = h - 8 - ((p.close - min) / span) * (h - 16)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  const color = up ? 'var(--up)' : 'var(--down)'
  return (
    <div>
      <div className="kline-range">
        <span>{data[0].date}</span>
        <span>
          {min.toFixed(2)} – {max.toFixed(2)}
        </span>
        <span>{data[data.length - 1].date}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="kline-svg">
        <path d={path} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  )
}
