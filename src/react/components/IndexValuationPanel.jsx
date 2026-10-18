// IndexValuationPanel.jsx · 指数估值（PE / PB / 历史分位 / 股息率）
// 数据：蛋卷 index_eva（fetchIndexValuationFor）。抓不到 → 明确说「取不到」，不造假。
// 口径：pe_percentile / pb_percentile / yeild 都是 0~1 小数 → 显示时 ×100 成百分比。
//      估值类型 low=低估(青绿) / mid=适中(黄) / high=高估(红)。
import { useEffect, useState, useRef } from 'react'
import EmptyState from './EmptyState'
import IndexValuationDetail from './IndexValuationDetail'
import { fetchIndexValuationFor, fetchAndPersistGlobalQuotes, getGlobalQuotesFromDb } from '../lib/dataAdapter'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'

const EVA = {
  low: { label: '低估', cls: 'ok' },
  mid: { label: '适中', cls: 'warn' },
  high: { label: '高估', cls: 'bad' },
}

const pct1 = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const num2 = (v) => (v == null || v === 0 ? '—' : Number(v).toFixed(2))

export default function IndexValuationPanel() {
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [detail, setDetail] = useState(null)
  const [globalQuotes, setGlobalQuotes] = useState(null)
  const [globalUpdated, setGlobalUpdated] = useState('')

  // 本地时间字符串（非 UTC），用于「数据更新于」展示
  const nowLocal = () => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  const load = async () => {
    setBusy(true); setErr('')
    try {
      // ① 先读本地库（秒开，证明调度器已落库/刷新过）
      const cached = await getGlobalQuotesFromDb()
      if (cached.ok && cached.data && cached.data.length) {
        setGlobalQuotes(cached.data)
        setGlobalUpdated(cached.data[0]?.updated_at || '')
      }
      // ② 实时抓 + 落库（接入抓取脚本，持续更新）
      const [r, g] = await Promise.all([fetchIndexValuationFor(), fetchAndPersistGlobalQuotes()])
      if (!r.ok) { setErr(r.error || '取数失败'); setList([]) } else { setList(r.data || []) }
      if (g.ok && g.data && g.data.length) { setGlobalQuotes(g.data); setGlobalUpdated(nowLocal()) }
    } finally { setBusy(false) }
  }
  useEffect(() => { load() }, [])
  // 下拉刷新
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => registerPullRefresh(() => loadRef.current?.()), [])

  if (list == null) return <EmptyState title="加载中" hint="正在拉取指数估值…" />

  if (!list.length) {
    return (
      <div>
        <EmptyState
          title="取不到数据"
          hint={err ? `指数估值暂时取不到（${err}）——不是没有，是没拿到，稍后再试。` : '指数估值暂时取不到（网络或数据源问题）——不是没有，是没拿到，稍后再试。'}
        />
        <button className="btn btn-block" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={load}>
          {busy ? '刷新中…' : '重试'}
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="muted cell-note" style={{ lineHeight: 1.8, marginBottom: 10 }}>
        看的是「<b>这个位置贵还是便宜</b>」：把现在的市盈率、市净率放到它自己的历史里比，
        <b>越靠历史低位就越便宜</b>（0% 最便宜、100% 最贵）。
        估值类型：<b style={{ color: 'var(--teal)' }}>低估</b> / 适中 / <b style={{ color: 'var(--danger)' }}>高估</b>。
        <br />点击任一指数可查看 <b>历史市盈率走势</b>。
      </div>

      {list.map(v => {
        const eva = EVA[v.eva_type] || { label: v.eva_type || '—', cls: 'warn' }
        return (
          <div
            key={v.index_code}
            className="mini-item static ivd-row"
            role="button"
            tabIndex={0}
            onClick={() => setDetail(v)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(v) } }}
          >
            <div className="mini-top">
              <span className="mini-title">{v.name}</span>
              <span className="muted cell-note">{v.index_code}</span>
              <span className={`ov-tag ${eva.cls}`} style={{ marginLeft: 'auto' }}>{eva.label}</span>
              <span className="ivd-arrow" aria-hidden="true">›</span>
            </div>
            <div className="mini-stats">
              <span className="mini-stat">市盈率 <b>{num2(v.pe)}</b></span>
              <span className="mini-stat">市盈率历史位置 <b>{pct1(v.pe_percentile)}</b></span>
              <span className="mini-stat">市净率 <b>{num2(v.pb)}</b></span>
              <span className="mini-stat">市净率历史位置 <b>{pct1(v.pb_percentile)}</b></span>
              <span className="mini-stat">股息率 <b>{pct1(v.yeild)}</b></span>
            </div>
          </div>
        )
      })}

      {/* 全球行情：国外指数 + 商品实时点位/涨跌；无 PE 分位数据源，不造假 */}
      <div className="subhead" style={{ marginTop: 20, marginBottom: 8 }}>全球行情</div>
      <div className="muted cell-note" style={{ marginBottom: 10, lineHeight: 1.7 }}>
        看<b>实时点位 / 价格 + 当日涨跌</b>。
      </div>
      {globalQuotes == null ? (
        <div className="muted cell-note">加载中…</div>
      ) : globalQuotes.length === 0 ? (
        <div className="muted cell-note">全球行情暂时取不到，稍后下拉刷新重试。</div>
      ) : (
        <div className="mini-list">
          {globalQuotes.map((q) => (
            <div key={q.code} className="mini-item static">
              <div className="mini-top">
                <span className="mini-title">{q.name}</span>
                <span className="muted cell-note">{q.code}</span>
                <b className={q.change_pct >= 0 ? 'pos' : 'neg'} style={{ marginLeft: 'auto' }}>
                  {q.change_pct >= 0 ? '+' : ''}{q.change_pct.toFixed(2)}%
                </b>
              </div>
              <div className="mini-stats">
                <span className="mini-stat">{q.kind === 'commodity' ? '现价' : '点位'} <b>{Number(q.value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b></span>
              </div>
            </div>
          ))}
          <div className="muted cell-note" style={{ marginTop: 8 }}>
            数据更新于 {globalUpdated || '—'}
          </div>
        </div>
      )}

      <div className="muted cell-note" style={{ marginTop: 10, lineHeight: 1.7 }}>
        数据日期 {list[0]?.date || '—'}（最近交易日）。
        <br />深证 / 创业板系列暂不支持，只有中证系列有历史估值。
      </div>
      <button className="btn btn-block" style={{ width: '100%', marginTop: 12 }} disabled={busy} onClick={load}>
        {busy ? '刷新中…' : '刷新'}
      </button>

      <IndexValuationDetail open={!!detail} onClose={() => setDetail(null)} item={detail} />
    </div>
  )
}
