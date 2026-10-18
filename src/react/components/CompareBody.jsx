// CompareBody.jsx · 多基金对比
//
// 选 2–4 只基金，并排比 收益 / 回撤 / 波动。数据全部读本地 nav_daily（navStats），
// 不联网也能比；缺净值的指标显示「—」，不编造。
//
// 入口：分析页 entries 里 push 进来（与「兜底分析」同级），不新增底部 Tab。

import { Fragment, useEffect, useState, useCallback } from 'react'
import Card from './Card'
import EmptyState from './EmptyState'
import { fetchWatchlist, fetchPositions, jsNavStats } from '../lib/dataAdapter.js'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'
import { useStore } from '../store/useStore'

// 对比指标：收益类越高越好（high），回撤/波动越低越好（low）
const METRICS = [
  { key: 'type', label: '类型', kind: 'text' },
  { key: 'ret_1m', label: '近1月', better: 'high' },
  { key: 'ret_3m', label: '近3月', better: 'high' },
  { key: 'ret_6m', label: '近6月', better: 'high' },
  { key: 'ret_1y', label: '近1年', better: 'high' },
  { key: 'max_drawdown_pct', label: '跌得最多', better: 'low' },
  { key: 'annual_volatility_pct', label: '波动大小', better: 'low' },
]

function fmtPct(v) {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

export default function CompareBody({ onPick }) {
  const notify = useStore((s) => s.notify)
  const [funds, setFunds] = useState([])
  const [selected, setSelected] = useState([]) // 已选 fund_code 列表
  const [results, setResults] = useState(null) // { code: {name, category, stats} }
  const [loading, setLoading] = useState(false)
  const [comparing, setComparing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [wl, pos] = await Promise.all([fetchWatchlist(), fetchPositions()])
      const map = new Map()
      const push = (r) => {
        if (r && r.fund_code) map.set(r.fund_code, {
          code: r.fund_code,
          name: r.fund_name || r.fund_code,
          category: r.category || '',
        })
      }
      ;(wl.ok ? wl.data : []).forEach(push)
      ;(pos.ok ? pos.data : []).forEach(push)
      const list = [...map.values()].sort((a, b) => a.code.localeCompare(b.code))
      setFunds(list)
    } catch (e) {
      notify('加载基金列表失败：' + (e && e.message || e), 'error')
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => { load() }, [load])
  // 下拉刷新
  useEffect(() => registerPullRefresh(load), [load])

  const toggle = (code) => {
    setResults(null) // 重新选择后清空旧结果
    setSelected((prev) => {
      if (prev.includes(code)) return prev.filter((c) => c !== code)
      if (prev.length >= 4) { notify('最多对比 4 只', 'warning'); return prev }
      return [...prev, code]
    })
  }

  const runCompare = async () => {
    if (selected.length < 2) { notify('至少选 2 只', 'warning'); return }
    setComparing(true)
    setResults(null)
    try {
      const out = {}
      for (const code of selected) {
        const f = funds.find((x) => x.code === code)
        const r = await jsNavStats(code)
        out[code] = {
          name: (f && f.name) || code,
          category: (f && f.category) || '',
          stats: (r.ok && r.data) || null,
        }
      }
      setResults(out)
      const bestSummary = METRICS.filter(m => m.better).map(m => {
        let best = null
        for (const code of Object.keys(out)) {
          const v = out[code] && out[code].stats ? out[code].stats[m.key] : null
          if (v == null) continue
          if (best == null) best = v
          else best = m.better === 'high' ? Math.max(best, v) : Math.min(best, v)
        }
        return { k: m.key, best }
      })
    } catch (e) {
      notify('对比失败：' + (e && e.message || e), 'error')
    } finally {
      setComparing(false)
    }
  }

  // 每行最优值（用于高亮）
  const bestOf = (metric) => {
    if (!results || metric.kind === 'text' || !metric.better) return null
    let best = null
    for (const code of Object.keys(results)) {
      const v = results[code] && results[code].stats ? results[code].stats[metric.key] : null
      if (v == null) continue
      if (best == null) best = v
      else best = metric.better === 'high' ? Math.max(best, v) : Math.min(best, v)
    }
    return best
  }

  const cellClass = (v) => (v == null ? 'muted' : v >= 0 ? 'pos' : 'neg')

  return (
    <div className="hold-root">
      <Card
        className="wide"
        title="多基金对比"
        action={<button className="btn-tiny" onClick={load} disabled={loading}>{loading ? '加载中…' : '刷新列表'}</button>}
      >
        <div className="muted cell-note" style={{ marginBottom: 8, lineHeight: 1.7 }}>
          选 <b>2–4 只</b> 基金并排比收益 / 回撤 / 波动。数据读本机净值（不联网也能比），缺净值的指标显示「—」。
        </div>

        {funds.length === 0 && !loading ? (
          <EmptyState title="暂无可选基金" hint="先在交易页添加并抓取净值，或把基金加为关注。" />
        ) : (
          <div className="mini-list">
            {funds.map((f) => {
              const on = selected.includes(f.code)
              return (
                <div
                  key={f.code}
                  className={`mini-item${on ? ' selected-row' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(f.code)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(f.code) } }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span style={{ flex: '0 0 22px', fontSize: 16, color: on ? 'var(--down)' : 'var(--border-strong)' }}>{on ? '☑' : '☐'}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{f.name}</span>
                    <span className="muted cell-note" style={{ marginLeft: 6 }}>{f.code}</span>
                  </span>
                  {f.category && <span className="ov-tag">{f.category}</span>}
                </div>
              )
            })}
          </div>
        )}

        <div className="set-actions" style={{ marginTop: 10 }}>
          <button
            className="btn-primary btn-block"
            style={{ width: '100%' }}
            disabled={comparing || selected.length < 2}
            onClick={runCompare}
          >
            {comparing ? '对比中…' : `开始对比（已选 ${selected.length} 只）`}
          </button>
        </div>
      </Card>

      {results && (() => {
        const codes = Object.keys(results)
        const cols = `72px repeat(${codes.length}, minmax(0, 1fr))`
        return (
          <Card className="wide" title="对比结果">
            <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 4, alignItems: 'center' }}>
              <div className="muted cell-note">指标</div>
              {codes.map((code) => {
                const r = results[code]
                return (
                  <div
                    key={code}
                    role="button"
                    tabIndex={0}
                    style={{ textAlign: 'center', cursor: 'pointer' }}
                    onClick={() => onPick && onPick(code)}
                    onKeyDown={(e) => { if (e.key === 'Enter') onPick && onPick(code) }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 12, lineHeight: 1.3 }}>{r.name}</div>
                    <div className="muted cell-note">{code}</div>
                  </div>
                )
              })}

              {METRICS.map((m) => {
                const best = bestOf(m)
                return (
                  <Fragment key={m.key}>
                    <div className="muted cell-note" style={{ fontSize: 12 }}>{m.label}</div>
                    {codes.map((code) => {
                      const r = results[code]
                      const v = m.kind === 'text' ? null : (r.stats ? r.stats[m.key] : null)
                      let text, cls
                      if (m.kind === 'text') {
                        text = (r.category) || '—'
                        cls = 'muted'
                      } else if (m.key === 'max_drawdown_pct') {
                        text = v == null ? '—' : `-${v.toFixed(1)}%`
                        cls = v == null ? 'muted' : 'neg'
                      } else {
                        text = fmtPct(v)
                        cls = cellClass(v)
                      }
                      const isBest = best != null && v != null && Math.abs(v - best) < 1e-9
                      return (
                        <div
                          key={code}
                          className={cls}
                          style={{
                            textAlign: 'center',
                            fontSize: 13,
                            padding: '4px 2px',
                            ...(isBest ? { background: 'rgba(31,158,90,0.16)', fontWeight: 700, borderRadius: 6 } : {}),
                          }}
                        >
                          {text}{isBest ? ' ★' : ''}
                        </div>
                      )
                    })}
                  </Fragment>
                )
              })}
            </div>
            <div className="muted cell-note" style={{ marginTop: 8 }}>
              带 ★ 的指标最好。点基金名可去交易页。
            </div>
          </Card>
        )
      })()}
    </div>
  )
}
