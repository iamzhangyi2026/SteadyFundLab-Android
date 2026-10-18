// Analysis.jsx · 分析页
//
// 改进：
//   - 六大模块原样保留
//   - 支持 selectedFund 高亮对应持仓
//   - 持仓行可点击 → 跳交易带 fundCode
//   - 数据刷新走 store.refresh()

import { useEffect, useState, useCallback, useMemo } from 'react'
import Card from '../components/Card'
import EmptyState from '../components/EmptyState'
import Modal from '../components/Modal'
import CompareBody from '../components/CompareBody.jsx'
import { ListGroup, ListItem } from '../components/ui.jsx'
import { useNav } from '../lib/nav.jsx'
import { useData } from '../hooks/useData.jsx'
import { useStore } from '../store/useStore'
import { buildAnalysisBundle } from '../../core/analysis.ts'
import { intelSummary, listIntelEvents } from '../../core/intel_collector.ts'
import { getDb, jsAnalyzeExposure, jsDetectStyleDrift, jsAppendIntel, jsScreenAll, fetchMarketIndex, jsLatestFallbackAnalysis } from '../lib/dataAdapter.js'
import IndexKlinePanel from '../components/IndexKlinePanel'
import IndexValuationPanel from '../components/IndexValuationPanel'
import BenchmarkPanel from '../components/BenchmarkPanel'
import { fetchDecisionLog } from '../lib/scheduler'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'

// 板块热力图（轻量 CSS 网格，不依赖 ECharts）：涨红跌绿，透明度按涨跌幅幅度
// 源用新浪行业板块（无资金流字段）→ 颜色与数值统一按**涨跌幅**，不依赖 net_inflow
function SectorHeat({ items }) {
  if (!items?.length) return <EmptyState title="暂无板块信号" hint="后台抓到板块行情后自动出图" />
  const maxAbs = Math.max(...items.map(b => Math.abs(b.change_pct) || 0), 1)
  const color = (v) => {
    const t = Math.min(1, Math.abs(v) / maxAbs)
    const base = v >= 0 ? '226,59,59' : '31,158,90'   // 涨红跌绿（A 股习惯）
    const alpha = 0.25 + t * 0.65
    return `rgba(${base},${alpha})`
  }
  return (
    <div className="heat-grid">
      {items.map(b => (
        <div key={b.board_name} className="heat-cell" style={{ background: color(b.change_pct) }}>
          <div className="hc-name">{b.board_name}</div>
          <div className="hc-val">{b.change_pct >= 0 ? '+' : ''}{b.change_pct.toFixed(2)}%</div>
        </div>
      ))}
    </div>
  )
}

// 候选标的（项目唯一目的：找「估值洼地 + 趋势向上」，两个独立维度）
// 主轨=分位<50 且 近1年>0；纯洼地=分位<50 且 近1年≤0；趋势=分位≥70 且 涨；高波动=波动≤35 且 回撤≥-50
function CandidateCard({ onPick }) {
  const notify = useStore((s) => s.notify)
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState(false)
  const [sortKey, setSortKey] = useState('default')

  const runScreen = async () => {
    setBusy(true)
    try {
      const r = await jsScreenAll({ limit: 3000 })
      if (!r.ok) { notify(`筛选失败：${r.error}`, 'error'); return }
      setList(r.data ?? [])
      notify(`筛选完成：${(r.data ?? []).length} 只达标`, 'success')
    } finally { setBusy(false) }
  }

  // G1 池内多维排序：分位/近1年/回撤/波动四个字段本来就渲染了，
  // 这里纯前端排序后 slice(0,50)，不碰数据层。按钮按「更优的排在前面」定义。
  const SORTS = [
    { key: 'default', label: '默认（算法序）' },
    { key: 'ret_1y', label: '近1年收益高' },
    { key: 'max_dd', label: '跌得少' },
    { key: 'annual_vol', label: '波动小' },
    { key: 'percentile', label: '估值更低' },
  ]
  const sorted = useMemo(() => {
    if (!list) return null
    const arr = [...list]
    const n = (v, d) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v))
    switch (sortKey) {
      case 'ret_1y':
        arr.sort((a, b) => n(b.ret_1y, -Infinity) - n(a.ret_1y, -Infinity)); break
      // 回撤是负数（如 -20.5）→ 数值越大越接近 0 = 回撤越小，降序即「回撤小优先」
      case 'max_dd':
        arr.sort((a, b) => n(b.max_dd, -Infinity) - n(a.max_dd, -Infinity)); break
      case 'annual_vol':
        arr.sort((a, b) => n(a.annual_vol, Infinity) - n(b.annual_vol, Infinity)); break
      case 'percentile':
        arr.sort((a, b) => n(a.percentile, Infinity) - n(b.percentile, Infinity)); break
      default: break
    }
    return arr
  }, [list, sortKey])

  const TRACK = { main: '低估+上涨', pure_value: '低估未涨', backup: '高位仍涨', high_vol: '高波动' }
  return (
    <Card
      className="wide"
      title="候选标的"
      action={<button className="btn-tiny" disabled={busy} onClick={runScreen}>{busy ? '筛选中…' : '开始筛选'}</button>}
    >
      <div className="muted cell-note" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        筛选标准：估值便宜（历史低位）+ 趋势向上（近 1 年涨了）两个条件，四类覆盖：
        「低估+上涨」/「低估未涨」/「高位仍涨」/「高波动」。点「开始筛选」运行。
      </div>
      {list == null ? (
        <div className="muted cell-note">点右上角「开始筛选」运行。</div>
      ) : list.length === 0 ? (
        <div className="muted cell-note">没有达标基金（可能本地净值数据不足，先在交易页添加并抓取净值）。</div>
      ) : (
        <div className="mini-list">
          {/* 池内排序（G1）：筛选负责缩范围，排序让你在范围内自己挑 */}
          <div className="sort-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {SORTS.map(s => (
              <button
                key={s.key}
                className="btn-tiny"
                style={sortKey === s.key ? { background: 'var(--text)', color: 'var(--on-accent)' } : undefined}
                onClick={() => setSortKey(s.key)}
              >{s.label}</button>
            ))}
          </div>
          {sorted.slice(0, 50).map(c => {
            const trackCls = c.track === 'main' ? 'ok' : c.track === 'pure_value' ? 'warn' : c.track === 'backup' ? 'warn' : 'bad'
            const retCls = (c.ret_1y ?? 0) >= 0 ? 'pos' : 'neg'
            return (
              <div
                key={c.fund_code}
                className="mini-item"
                role="button"
                tabIndex={0}
                onClick={() => onPick(c.fund_code)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(c.fund_code) } }}
              >
                <div className="mini-top">
                  <span className="mini-title">{c.fund_code}</span>
                  <span className={`ov-tag ${trackCls}`}>{TRACK[c.track] || c.track}</span>
                </div>
                <div className="mini-stats">
                  <span className="mini-stat">分位 <b>{c.percentile?.toFixed(1)}%</b></span>
                  <span className="mini-stat">近1年 <b className={retCls}>{c.ret_1y == null ? '—' : `${c.ret_1y >= 0 ? '+' : ''}${c.ret_1y.toFixed(2)}%`}</b></span>
                  <span className="mini-stat">最大跌幅 <b className="neg">{c.max_dd == null ? '—' : `${c.max_dd.toFixed(1)}%`}</b></span>
                  <span className="mini-stat">波动 <b>{c.annual_vol == null ? '—' : `${c.annual_vol.toFixed(1)}%`}</b></span>
                </div>
              </div>
            )
          })}
          <div className="muted cell-note" style={{ marginTop: 6 }}>共 {list.length} 只达标（显示前 50，可上方按钮排序）。点击行 → 去交易页查看。</div>
        </div>
      )}
      <FallbackCard onPick={onPick} />
    </Card>
  )
}

// 兜底分析：
// 本机每天由离线周期跑一次本地选基算法，结论落 decision_log。
// 这里把结论、候选、风险点直接摆出来 —— 不依赖 AI 在线，也不假装 AI 在线。
// 现并入「候选标的」卡底部作一个分区（03 分支 A），不再独立占入口。
function FallbackCard({ onPick }) {
  const [fa, setFa] = useState(null)
  const [logs, setLogs] = useState([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await jsLatestFallbackAnalysis()
      setFa(r && r.ok ? r.data : null)
      const lr = await fetchDecisionLog(8)
      setLogs(lr && lr.ok ? (lr.data || []) : [])
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const day = fa ? String(fa.ts || fa.as_of || '').slice(0, 10) : ''
  const TRACK_LABEL = { main: '低估+上涨', pure_value: '低估未涨', backup: '高位仍涨', high_vol: '高波动' }
  return (
    <div className="fallback-section" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>没网 / 助手离线时：本机自己算的结论</div>
        <button className="btn-tiny" onClick={load} disabled={busy}>{busy ? '读取出…' : '刷新'}</button>
      </div>

      {!fa ? (
        <div className="muted cell-note" style={{ lineHeight: 1.8 }}>
          还没有离线结论。它由「离线周期」每天跑一次（App 启动后约 1 分钟）。
          已纳入净值的基金越多，结论越有参考价值。
        </div>
      ) : (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.6, marginBottom: 6 }}>
            {fa.conclusion}
          </div>
          <div className="muted cell-note" style={{ marginBottom: 8 }}>
            数据日期 {day}{fa.pool_size != null ? ` · 全池 ${fa.pool_size} 只` : ''}
          </div>

          {Array.isArray(fa.candidates) && fa.candidates.length > 0 && (
            <div className="mini-list">
              {fa.candidates.slice(0, 5).map((c, i) => (
                <div
                  key={c.fund_code || i}
                  className="mini-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => onPick && onPick(c.fund_code)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onPick && onPick(c.fund_code) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span className="muted cell-note" style={{ flex: '0 0 20px' }}>{i + 1}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{c.fund_name || c.fund_code}</span>
                    <span className="muted cell-note" style={{ marginLeft: 6 }}>{c.fund_code}</span>
                    <div className="muted cell-note" style={{ marginTop: 2 }}>
                      评分 {c.score != null ? Number(c.score).toFixed(1) : '—'} · 分位 {c.percentile != null ? Number(c.percentile).toFixed(1) : '—'}% · 近1年 {c.ret_1y != null ? `${c.ret_1y > 0 ? '+' : ''}${Number(c.ret_1y).toFixed(2)}%` : '—'} · 最大跌幅 {c.max_dd != null ? `${Number(c.max_dd).toFixed(2)}%` : '—'}
                      {c.track ? ` · ${TRACK_LABEL[c.track] || c.track}` : ''}
                    </div>
                  </span>
                  <span className="muted cell-note">去交易 ›</span>
                </div>
              ))}
            </div>
          )}

          {Array.isArray(fa.risks) && fa.risks.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="muted cell-note" style={{ marginBottom: 4 }}>风险点（照实列出，不美化）</div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
                {fa.risks.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </div>
          )}
        </>
      )}

      {logs.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="muted cell-note" style={{ marginBottom: 4 }}>最近的提醒与结论</div>
          <div className="mini-list">
            {logs.map((l, i) => (
              <div key={i} className="mini-item" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="muted cell-note" style={{ flex: '0 0 96px' }}>{String(l.ts || '').slice(5, 16)}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.6 }}>
                  {l.fund_name || l.fund_code || ''}
                  {l.fund_name || l.fund_code ? ' · ' : ''}
                  {l.reason || ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 持仓体检页（双触发）──────────────────────────────────
//   source='trade' → **模拟持仓体检**：进页自动跑（虚拟盘常调，即时反馈）
//   source='real'  → **真实持仓体检**：卡头「分析」按钮，**点了才跑**（OCR 导入的存量资产、
//                    非高频 → 省资源不打扰；可反复点，幂等）
//   两套数据严格隔离：source 过滤下推到 SQL（_loadHoldings），互不串账。
function PortfolioCheckBody({ source }) {
  const { selectedFund } = useData()
  const manual = source === 'real'
  const [bundle, setBundle] = useState(null)
  const [driftReports, setDriftReports] = useState({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // 跳交易页（与主页面同一事件通道）
  const gotoTrade = useCallback((fundCode) => {
    window.dispatchEvent(new CustomEvent('fundapp:goto-trade', { detail: { fundCode } }))
  }, [])

  const run = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const db = getDb()
      if (!db) { setErr('数据层未初始化'); return }
      const rows = await _loadHoldings(db, source)
      const totalMv = rows.reduce((s, h) => s + h.market_value, 0)
      const catSummary = {}
      for (const h of rows) {
        const cat = h.category || '类型未知'
        catSummary[cat] = (catSummary[cat] || 0) + (totalMv > 0 ? h.market_value / totalMv : 0)
      }
      const driftMap = {}
      for (const h of rows) {
        const expR = await jsAnalyzeExposure(h.fund_code)
        if (expR.ok && expR.data) {
          const driftR = await jsDetectStyleDrift(h.fund_name || h.fund_code, expR.data.allocation || [])
          if (driftR.ok) driftMap[h.fund_code] = driftR.data
        }
      }
      const result = await buildAnalysisBundle(db, {
        holdings: rows,
        fundCategorySummary: catSummary,
        intelWarning: '',
      })
      setBundle(result)
      setDriftReports(driftMap)
    } catch (e) {
      setErr((e && e.message) || String(e))
    } finally { setBusy(false) }
  }, [source])

  useEffect(() => { if (!manual) run() }, [manual, run])

  const selectedCode = selectedFund
  const tag = source === 'real'
    ? <span className="src-tag src-tag-real">真实</span>
    : <span className="src-tag src-tag-sim">模拟</span>
  const title = source === 'real' ? '真实持仓体检' : '模拟持仓体检'

  // 真实持仓：未点「分析」前只显示触发入口（不自动跑）
  if (manual && !bundle) {
    return (
      <Card className="wide" title={title}>
        <div style={{ marginBottom: 10, fontSize: 13 }}>{tag}<b>真实持仓（截图导入）</b></div>
        {err && <div className="text-danger cell-note" style={{ marginBottom: 10 }}>⚠ {err}</div>}
        <button className="btn btn-primary" disabled={busy} onClick={run}>
          {busy ? '分析中…' : '分析'}
        </button>
      </Card>
    )
  }

  if (!bundle) {
    return <Card className="wide" title={title}><EmptyState title="加载中" hint="正在准备数据…" /></Card>
  }

  const empty = bundle.penetration.source === 'empty'
  return (
    <>
      <div className="muted cell-note" style={{ padding: '0 0 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
        {tag}
        <span>{source === 'real' ? '真实持仓（截图导入）' : '模拟持仓'}</span>
      </div>

      {empty ? (
        <Card className="wide" title="体检结果">
          <EmptyState
            title={source === 'real' ? '还没有真实持仓' : '还没有虚拟持仓'}
            hint={source === 'real' ? '去「持仓」页导入持仓截图' : '去「交易」页买入'}
          />
        </Card>
      ) : (
        <>
          <Card className="wide" title="持仓透视">
            <div className="penetration-summary">
              <span className={`warn-${bundle.penetration.concentration_warning.level}`}>
                {bundle.penetration.concentration_warning.detail}
              </span>
              <span className="coverage">已覆盖 {(bundle.penetration.coverage_pct * 100).toFixed(0)}% 持仓</span>
            </div>
            <div className="penetration-list">
              {bundle.penetration.rows.map(r => (
                <div key={r.stock_code} className="pen-row">
                  <span className="pname">{r.stock_name}</span>
                  <span className="pcode">{r.stock_code}</span>
                  <span className="pbar" style={{ width: `${r.composite_weight * 200}px` }} />
                  <span className="pwt">{(r.composite_weight * 100).toFixed(2)}%</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="wide" title="净值统计">
            {Object.keys(bundle.nav_stats).length === 0 ? (
              <EmptyState title="数据缺失" hint="当前组合无持仓" />
            ) : (
              <div className="mini-list">
                {Object.entries(bundle.nav_stats).map(([code, s]) => (
                  <div
                    key={code}
                    className={`mini-item${code === selectedCode ? ' selected-row' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => gotoTrade(code)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gotoTrade(code) } }}
                  >
                    <div className="mini-top"><span className="mini-title">{code}</span></div>
                    <div className="mini-stats">
                      <span className="mini-stat">1月 <b className={_cls(s.ret_1m)}>{_fmt(s.ret_1m)}</b></span>
                      <span className="mini-stat">3月 <b className={_cls(s.ret_3m)}>{_fmt(s.ret_3m)}</b></span>
                      <span className="mini-stat">6月 <b className={_cls(s.ret_6m)}>{_fmt(s.ret_6m)}</b></span>
                      <span className="mini-stat">1年 <b className={_cls(s.ret_1y)}>{_fmt(s.ret_1y)}</b></span>
                      <span className="mini-stat">最大跌幅 <b className="neg">{_fmt(s.max_drawdown_pct)}</b></span>
                      <span className="mini-stat">波动 <b>{_fmt(s.annual_volatility_pct)}</b></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="wide" title="持仓风格有没有变">
            {!Object.keys(driftReports).length ? (
              <EmptyState title="数据缺失" hint="暂无行业分布数据，无法判断风格有没有变" />
            ) : (
              <div className="narrative-list">
                {Object.entries(driftReports).map(([code, d]) => (
                  <div
                    key={code}
                    className={`narrative-row ${code === selectedCode ? 'selected-row' : ''}`}
                    onClick={() => gotoTrade(code)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="nlabel">{code}</span>
                    <span className={`ntext ${d.drifted ? 'neg' : 'pos'}`}>{d.note}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="wide" title="组合叙述">
            <div className="narrative-list">
              <div className="narrative-row"><span className="nlabel">集中度</span><span className="ntext">{bundle.narrative.concentration}</span></div>
              <div className="narrative-row"><span className="nlabel">持仓风格</span><span className="ntext">{bundle.narrative.style_drift}</span></div>
              <div className="narrative-row"><span className="nlabel">同涨同跌</span><span className="ntext">{bundle.narrative.co_movement}</span></div>
            </div>
          </Card>

          <Card className="wide" title="近期新闻与情报">
            {!bundle.news || bundle.news.count === 0 ? (
              <EmptyState title="近 7 天暂无新闻与情报" hint="抓取后自动入库，与持仓 / 沙盒 / 关注共用一份真实行情" />
            ) : (
              <div className="narrative-list">
                {Object.entries(bundle.news.by_fund).map(([code, items]) =>
                  items.slice(0, 3).map((n, i) => (
                    <div className="narrative-row" key={`${code}-${i}`}>
                      <span className="nlabel">{code}</span>
                      <span className="ntext">{n.title}</span>
                    </div>
                  ))
                )}
                {bundle.news.intel_events.slice(0, 3).map((e, i) => (
                  <div className="narrative-row" key={`intel-${i}`}>
                    <span className="nlabel">情报</span>
                    <span className="ntext">{e.title}{e.event_date ? `（${e.event_date}）` : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </>
  )
}

export default function Analysis() {
  const { initialized, navigate } = useData()
  const nav = useNav()
  // 下拉刷新
  const [pullTick, setPullTick] = useState(0)
  useEffect(() => registerPullRefresh(() => setPullTick((t) => t + 1)), [])
  const [bundle, setBundle] = useState(null)
  const [intelEvents, setIntelEvents] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [intelOpen, setIntelOpen] = useState(false)
  const [indexes, setIndexes] = useState([])

  // 大盘指数：进页面就拉一次（东财 push2，抓不到静默留空，不显示假数据）
  useEffect(() => {
    let alive = true
    fetchMarketIndex().then(r => { if (alive && r.ok) setIndexes(r.data ?? []) })
    return () => { alive = false }
  }, [])

  // 跳转交易页
  const gotoTrade = (fundCode) => {
    navigate('trade', { fundCode })
  }

  const run = async () => {
    if (!initialized) return
    setBusy(true)
    setError(null)
    try {
      const db = getDb()
      if (!db) {
        setError('数据层未初始化')
        return
      }
      // ②a 模拟持仓体检：只取交易盘持仓（source='trade'，结构隔离）
      const rows = await _loadHoldings(db, 'trade')
      const totalMv = rows.reduce((s, h) => s + h.market_value, 0)
      const catSummary = {}
      for (const h of rows) {
        // 基金类型不得兜「其他」——缺失就标「类型未知」，不伪装成某个类型
        const cat = h.category || '类型未知'
        catSummary[cat] = (catSummary[cat] || 0) + (totalMv > 0 ? h.market_value / totalMv : 0)
      }
      // 情报提示
      const intel = await intelSummary(db, 7)
      const intelWarn = intel.total > 0
        ? `${intel.note}；${Object.entries(intel.by_category).filter(([, c]) => c > 0).map(([k, c]) => `${k} ${c}`).join(' / ')}`
        : '近 7 天无自动提取情报，放风不代表落地，据此下单需等待细则'
      // 情报事件明细
      try {
        setIntelEvents(await listIntelEvents(db, { limit: 20 }))
      } catch {
        setIntelEvents([])
      }

      // 重叠买入（被 ≥2 只基金同时持有的股票）直接从 penetration.rows 的 contributors 算，不单独跑

      const result = await buildAnalysisBundle(db, {
        holdings: rows,
        fundCategorySummary: catSummary,
        intelWarning: intelWarn,
      })
      setBundle(result)
    } catch (e) {
      setError((e && e.message) || String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initialized) run()
  }, [initialized, pullTick])

  if (!initialized) {
    return (
      <div className="hold-root">
        <div className="hold-block" style={{ marginTop: 8 }}>
          <div className="hold-block-title">选基 · 持仓体检 · 看市场</div>
          <EmptyState title="正在准备数据" hint="首次打开需要准备基金与净值，稍等片刻…" />
        </div>
      </div>
    )
  }


  // ── 安卓结构：一屏一个主题 —— 入口列表，点进去看详情 ──
  // 一屏一个主题，避免单页塞太多模块导致手机端翻页
  const entries = [
    // ② 持仓体检拆两套（双触发）：模拟自动跑 / 真实点「分析」才跑
    {
      key: 'check-sim', title: '模拟持仓体检', sub: '虚拟盘 · 进页自动跑（透视 / 净值 / 风格 / 叙述）',
      body: () => <PortfolioCheckBody source="trade" />,
    },
    {
      key: 'check-real', title: '真实持仓体检', sub: '截图识别导入的真实持仓 · 点「分析」才运行',
      body: () => <PortfolioCheckBody source="real" />,
    },
    {
      key: 'candidates', title: '候选标的', sub: '帮你筛出该关注的基金',
      body: () => <CandidateCard onPick={gotoTrade} />,
    },
    {
      key: 'compare', title: '多基金对比', sub: '2–4 只摆一起，谁好谁坏一目了然',
      body: () => <CompareBody onPick={gotoTrade} />,
    },
    {
      key: 'benchmark', title: '基准对比（模拟盘）', sub: '虚拟组合 vs 沪深300，跑赢没有',
      body: () => <BenchmarkPanel source="trade" />,
    },
    {
      key: 'benchmark-real', title: '基准对比（真实持仓）', sub: '真实组合 vs 沪深300，跑赢没有',
      body: () => <BenchmarkPanel source="real" />,
    },
    {
      key: 'heatmap', title: '板块', sub: '一眼看各行业冷热',
      body: () => (
        <Card className="wide" title="板块"
          action={busy ? '刷新中…' : (
            <button className="btn-tiny" onClick={run}>刷新</button>
          )}>
          {error && <div className="error-banner">⚠ {error}</div>}
          {!bundle ? (
            <EmptyState title="加载中" hint="正在拉取板块行情…" />
          ) : bundle.sector.source === 'empty' ? (
            <EmptyState title="板块行情暂时取不到" hint="稍后自动重试" />
          ) : (
            <>
              <SectorHeat items={bundle ? [...(bundle.sector.hot || []), ...(bundle.sector.danger || [])] : []} />
              <div className="muted cell-note" style={{ marginTop: 10, lineHeight: 1.8 }}>
                {(() => {
                  const hot = bundle.sector.hot || []
                  const danger = bundle.sector.danger || []
                  const parts = []
                  if (hot[0]) parts.push(`领涨：${hot[0].board_name} +${hot[0].change_pct.toFixed(2)}%`)
                  if (danger[0]) parts.push(`领跌：${danger[0].board_name} ${danger[0].change_pct.toFixed(2)}%`)
                  return parts.length ? parts.join(' / ') : ''
                })()}
              </div>
              <div className="muted cell-note" style={{ marginTop: 4, lineHeight: 1.7 }}>
                排序：{(bundle.sector.hot || []).some(r => (r.net_inflow || 0) !== 0)
                  ? '按资金流入排'
                  : '按涨跌幅排'}
              </div>
            </>
          )}
        </Card>
      ),
    },
    {
      key: 'index-eva', title: '指数估值', sub: '市盈率 / 市净率历史分位：这个位置贵还是便宜',
      body: () => <IndexValuationPanel />,
    },
    {
      key: 'intel', title: '情报事件', sub: '从资讯里提取的政策 / 行业 / 公司事件',
      value: intelEvents.length ? `${intelEvents.length} 条` : '',
      body: () => (
        <Card
          className="wide"
          title="情报事件"
          action={<button className="btn-tiny" onClick={() => setIntelOpen(true)}>+ 录入</button>}
        >
          {!intelEvents.length ? (
            <div className="muted cell-note" style={{ lineHeight: 1.8 }}>
              暂无情报事件。情报由「离线周期」每天从市场资讯里按关键词提取一次（政策 / 行业 / 公司 / 资金 / 海外 / 风险）。
            </div>
          ) : (
            <ul className="intel-list">
              {intelEvents.slice(0, 12).map((e, i) => (
                <li key={i} className="intel-item">
                  <span className={`tag ${_intelTag(e.impact_dir)}`}>
                    {INTEL_CAT_LABEL[e.category] || e.category || '其他'}
                  </span>
                  <div className="intel-body">
                    <div className="intel-title">{e.title}</div>
                    <div className="muted cell-note">
                      {e.event_date}
                      {e.impact_boards ? ` · 影响：${e.impact_boards}` : ''}
                      {e.source ? ` · 来源：${e.source}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ),
    },
  ]

  return (
    /* hold-root：与持仓/交易页一致的「全宽贴边、无左右边框」根容器（.stack 有 16px 内边距 → 两边留白，故全宽贴边） */
    <div className="hold-root">
      {/* 大盘指数排（真实数据，抓不到就不显示，不造假） */}
      {indexes.length > 0 && (
        <div className="hold-block" style={{ marginTop: 8 }}>
          <div className="hold-block-title">大盘指数</div>
          {indexes.map(ix => {
            const openK = () => nav.push('page', { title: `${ix.name} 日K`, body: () => <IndexKlinePanel code={ix.code} name={ix.name} /> })
            return (
              <div
                className="hold-row"
                key={ix.code}
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
                onClick={openK}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openK() } }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="hold-row-name">{ix.name}</div>
                  <div className="hold-row-sub">{ix.value.toFixed(2)}</div>
                </div>
                <div className="hold-row-pct" style={{ color: ix.change_pct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {ix.change_pct >= 0 ? '+' : ''}{ix.change_pct.toFixed(2)}%
                </div>
                <span className="li-arrow" aria-hidden>›</span>
              </div>
            )
          })}
        </div>
      )}

      {(() => {
        const byKey = Object.fromEntries(entries.map(e => [e.key, e]))
        const group = (title, keys) => (
          <ListGroup title={title}>
            {keys.map(k => {
              const e = byKey[k]
              if (!e) return null
              return (
                <ListItem
                  key={e.key}
                  title={e.title}
                  sub={e.sub}
                  value={e.value || ''}
                  onClick={() => { nav.push('page', { title: e.title, body: e.body }) }}
                />
              )
            })}
          </ListGroup>
        )
        return (
          <>
            {group('① 选基 · 该买什么', ['candidates', 'compare'])}
            {group('② 持仓体检 · 我拿的怎么样', ['check-sim', 'check-real', 'benchmark', 'benchmark-real'])}
            {group('③ 看市场 · 外面怎么回事', ['heatmap', 'index-eva', 'intel'])}
          </>
        )
      })()}

      <IntelModal
        open={intelOpen}
        onClose={() => setIntelOpen(false)}
        onSaved={() => { setIntelOpen(false); run() }}
      />
    </div>
  )
}

// ─── 情报手动补录（用于修正/补充）──────
const INTEL_CATS = [
  { v: 'policy', label: '政策' }, { v: 'geo', label: '地缘' }, { v: 'military', label: '军事' },
  { v: 'conference', label: '会议' }, { v: 'macro', label: '宏观' }, { v: 'company', label: '公司' },
]

function IntelModal({ open, onClose, onSaved }) {
  const notify = useStore((s) => s.notify)
  const [form, setForm] = useState({
    event_date: new Date().toISOString().slice(0, 10),
    category: 'policy', title: '', detail: '',
    impact_boards: '', impact_dir: 'neutral', source: '',
  })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async () => {
    if (!form.title.trim()) { notify('请填写标题', 'error'); return }
    setBusy(true)
    try {
      const r = await jsAppendIntel(form)
      if (!r.ok) { notify(`录入失败：${r.error}`, 'error'); return }
      if (!r.data?.inserted) notify('该情报已存在（同标题同日期）', 'warning')
      else notify('情报已保存', 'success')
      onSaved && onSaved()
    } finally { setBusy(false) }
  }

  return (
    <Modal open={open} title="录入情报" onClose={onClose}>
      <div className="row2">
        <div className="field">
          <label>事件日期</label>
          <input type="date" value={form.event_date} onChange={set('event_date')} />
        </div>
        <div className="field">
          <label>类别</label>
          <select value={form.category} onChange={set('category')}>
            {INTEL_CATS.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>标题</label>
        <input value={form.title} onChange={set('title')} placeholder="如：某半导体产线拟扩建" />
      </div>
      <div className="field">
        <label>详情</label>
        <textarea rows={3} value={form.detail} onChange={set('detail')} />
      </div>
      <div className="row2">
        <div className="field">
          <label>影响方向</label>
          <select value={form.impact_dir} onChange={set('impact_dir')}>
            <option value="positive">利好</option>
            <option value="negative">利空</option>
            <option value="neutral">中性</option>
          </select>
        </div>
        <div className="field">
          <label>影响板块</label>
          <input value={form.impact_boards} onChange={set('impact_boards')} placeholder="如 半导体,新能源" />
        </div>
      </div>
      <div className="field">
        <label>来源</label>
        <input value={form.source} onChange={set('source')} />
      </div>
      <div className="set-actions">
        <button className="btn-primary btn-block" style={{ width: '100%' }} disabled={busy} onClick={submit}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </Modal>
  )
}

/** 情报分类中文标签 */
const INTEL_CAT_LABEL = {
  policy: '政策',
  industry: '行业',
  company: '公司',
  capital: '资金',
  overseas: '海外',
  risk: '风险',
}

function _intelTag(dir) {
  if (dir === 'positive') return 'ok'
  if (dir === 'negative') return 'danger'
  return 'neutral'
}

// ─── helpers ──────────────────────────────────────────────────

async function _loadHoldings(db, source = 'trade') {
  // 结构隔离：持仓体检按 source 取（'trade' 模拟体检自动跑 / 'real' 真实体检手动触发）
  const rows = await db.query(
    `SELECT l.fund_code, f.fund_name, l.remaining_shares, n.nav, f.category AS category
     FROM lots l
     LEFT JOIN funds f ON f.fund_code = l.fund_code
     LEFT JOIN nav_daily n ON n.fund_code = l.fund_code
       AND n.nav_date = (SELECT MAX(nav_date) FROM nav_daily WHERE fund_code = l.fund_code)
     WHERE l.status='active' AND l.remaining_shares > 0 AND l.source = ?`,
    [source],
  )
  return rows.map(r => ({
    fund_code: r.fund_code,
    fund_name: r.fund_name,
    market_value: (r.remaining_shares || 0) * (r.nav || 0),
    shares: r.remaining_shares || 0,
    category: r.category || '',   // 不兜「其他」，缺失保持空
  }))
}

function _fmt(v) {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}
function _cls(v) {
  if (v == null) return ''
  return v >= 0 ? 'pos' : 'neg'
}
