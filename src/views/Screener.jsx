// src/views/Screener.jsx · 全市场基金筛选（完整版）
// ------------------------------------------------------------
// 排行来自天天基金全市场（约 1.8 万只），先按近1年/近6月/近3月/今年来排序；
// 再对当前页前 12 只补算「历史位置 / 最深跌 / 一年波动幅度」，按三轨条件过滤。
//
// 筛选口径对齐项目 screen_rules：近1年 > 0、位置 < 50%、下跌 < 50%。
// 没算位置的行不参与「只看达标」，也不假装达标。

import { useEffect, useState } from 'react'
import { fetchFundRank, enrichHistory, screenRows, scoreOf, SORT_OPTIONS } from '../lib/screener.js'
import RowSkeleton from '../components/RowSkeleton.jsx'

const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`)
const cls = (v) => (v == null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down')

export default function Screener({ onOpen }) {
  const [sort, setSort] = useState('1nzf')
  const [state, setState] = useState({ loading: true, rows: [], total: 0, error: null })
  const [enriched, setEnriched] = useState(null)
  const [busy, setBusy] = useState(false)
  const [onlyPass, setOnlyPass] = useState(false)

  useEffect(() => {
    let alive = true
    setState({ loading: true, rows: [], total: 0, error: null })
    setEnriched(null)
    fetchFundRank({ page: 1, size: 20, sort })
      .then((r) => {
        if (!alive) return
        setState({
          loading: false,
          rows: r.rows,
          total: r.total,
          error: r.rows.length ? null : '排行接口暂不可达',
        })
      })
      .catch((e) => alive && setState({ loading: false, rows: [], total: 0, error: e?.message || '抓取失败' }))
    return () => {
      alive = false
    }
  }, [sort])

  async function compute() {
    setBusy(true)
    try {
      const r = await enrichHistory(state.rows.slice(0, 12))
      setEnriched(r)
    } finally {
      setBusy(false)
    }
  }

  const merged = state.rows.map((r) => {
    const e = enriched?.find((x) => x.code === r.code)
    return e || r
  })
  const passed = enriched ? screenRows(enriched, { maxPercentile: 50, maxDrawdown: 50, minY1: 0 }) : []
  const shown = onlyPass ? merged.filter((r) => passed.some((p) => p.code === r.code)) : merged

  return (
    <>
      <div className="card">
        <div className="chip-row">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.key}
              className={'chip' + (sort === o.key ? ' info' : '')}
              onClick={() => setSort(o.key)}
              style={{ border: 0, cursor: 'pointer' }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          全市场共 {state.total ? state.total.toLocaleString('zh-CN') : '—'} 只基金，按所选区间涨幅排序。
          排行本身不含历史位置与下跌，需要点「计算位置/下跌」对当前页前 12 只补算（每只一次请求，约 10 秒）。
        </p>
      </div>

      <div className="section-title">排行</div>

      {state.loading ? (
        <div className="card plain card-list">
          {[1, 2, 3, 4].map((i) => (
            <RowSkeleton key={i} />
          ))}
        </div>
      ) : state.error ? (
        <div className="card">
          <div className="callout danger">{state.error}</div>
        </div>
      ) : (
        <div className="card plain card-list">
          {shown.map((r, i) => (
            <button
              key={r.code}
              className="fund-row"
              style={{ width: '100%', textAlign: 'left', border: 0, background: 'transparent' }}
              onClick={() => onOpen && onOpen(r.code)}
            >
              <div className="fund-main">
                <div className="fund-name">
                  {i + 1}. {r.name}
                </div>
                <div className="fund-meta">
                  <span className="fund-code">{r.code}</span>
                  {' · '}净值 {r.nav == null ? '—' : r.nav.toFixed(4)}
                  {' · '}近1年 <span className={cls(r.y1)}>{fmtPct(r.y1)}</span>
                  {' · '}近6月 <span className={cls(r.m6)}>{fmtPct(r.m6)}</span>
                  {' · '}近3月 <span className={cls(r.m3)}>{fmtPct(r.m3)}</span>
                </div>
                <div className="fund-meta">
                  费率 {r.rate == null ? '—' : `${r.rate}%`}
                  {r.scale != null ? ` · 规模 ${r.scale} 亿` : ''}
                  {r.percentile != null ? ` · 位置 ${r.percentile.toFixed(1)}%` : ''}
                  {r.maxDrawdown != null ? ` · 下跌 ${Math.abs(r.maxDrawdown).toFixed(1)}%` : ''}
                  {r.vol != null ? ` · 波动 ${r.vol.toFixed(1)}%` : ''}
                </div>
                {r.percentile != null ? (
                  <div className="chip-row" style={{ marginTop: 6 }}>
                    {r.percentile < 50 ? <span className="chip teal">位置 &lt; 50%</span> : null}
                    {r.y1 != null && r.y1 > 0 ? <span className="chip info">近1年为正</span> : null}
                    {Math.abs(r.maxDrawdown ?? 999) < 50 ? <span className="chip warn">下跌 &lt; 50%</span> : null}
                    {scoreOf(r) != null ? <span className="chip">综合 {scoreOf(r)}</span> : null}
                  </div>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      )}

      <button
        className="btn btn-block"
        style={{ marginTop: 'var(--space-3)' }}
        onClick={compute}
        disabled={busy || state.loading || state.rows.length === 0}
      >
        {busy ? '正在计算位置/下跌…' : '计算位置 / 下跌（前 12 只）'}
      </button>

      {enriched ? (
        <button
          className="btn btn-block"
          style={{ marginTop: 'var(--space-2)' }}
          onClick={() => setOnlyPass((v) => !v)}
        >
          {onlyPass ? '显示全部' : `只看达标（${passed.length} 只）`}
        </button>
      ) : null}

      <p className="card-note" style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
        达标口径：近1年 &gt; 0、历史位置 &lt; 50%、最深跌 &lt; 50%。仅作统计筛选，不构成买入建议。
      </p>
    </>
  )
}
