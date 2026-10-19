/**
 * 自选观察首页：上半屏是用户自己的真实持仓（导入所得），下半屏是观察池行情。
 * 关注列表仍是产品内置观察样本，不能当作用户真实持仓。
 */

import { useEffect, useMemo, useState } from 'react'
import { fetchFund, latestNetWorth, dayChange, fmtNavDate } from '../lib/eastmoney.js'
import RowSkeleton from '../components/RowSkeleton.jsx'
import { usePullRefresh } from '../lib/usePullRefresh.js'

const WATCH_LIST = [
  { code: '040001', tag: '成长' },
  { code: '110010', tag: '价值' },
  { code: '000021', tag: '混合' },
  { code: '100038', tag: '指数' },
]

export default function Watch({ onOpen, onDiscover, onSimLedger }) {
  const [state, setState] = useState({ status: 'loading', items: [] })

  // 下拉刷新（手势在 App 根，事件分发给当前页面）
  usePullRefresh(() => setRefreshTrigger((k) => k + 1))
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  async function load() {
    setState({ status: 'loading', items: [] })
    const items = await Promise.all(
      WATCH_LIST.map(async (w) => {
        try {
          return { ...w, d: await fetchFund(w.code), error: null }
        } catch (e) {
          return { ...w, d: null, error: e.message }
        }
      })
    )
    setState({ status: 'ok', items })
  }

  useEffect(() => {
    let alive = true
    Promise.all(
      WATCH_LIST.map(async (w) => {
        try {
          return { ...w, d: await fetchFund(w.code), error: null }
        } catch (e) {
          return { ...w, d: null, error: e.message }
        }
      })
    ).then((items) => alive && setState({ status: 'ok', items }))
    return () => { alive = false }
  }, [refreshTrigger])

  const summary = useMemo(() => {
    const valid = state.items.filter((item) => item.d)
    const up = valid.filter((item) => (dayChange(item.d.netWorth) ?? 0) > 0).length
    const down = valid.filter((item) => (dayChange(item.d.netWorth) ?? 0) < 0).length
    return { valid: valid.length, up, down }
  }, [state.items])

  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date())

  return (
    <div className="watch-page">
      <section className="watch-welcome">
        <div className="watch-eyebrow"><span className="live-dot" /> FUND DESK <span>·</span> {date}</div>
        <h1>把每一次观察，<br /><em>变成有据可依。</em></h1>
        <p>净值、费率与持仓线索，一屏看清。</p>
      </section>

      {/* 真实持仓只放在「持仓」页 —— 自选页专注观察池，不重复展示自己的钱 */}
      <section className="market-card" aria-label="自选行情摘要">
        <div className="market-topline">
          <div><div className="market-kicker">自选行情</div><div className="market-title">今日观察</div></div>
          <span className={`market-status ${state.status === 'loading' ? 'is-loading' : ''}`}>
            <i />{state.status === 'loading' ? '正在更新' : summary.valid ? `已获取 ${summary.valid}/${WATCH_LIST.length} 只` : '数据暂不可用'}
          </span>
        </div>
        <div className="market-bottomline">
          <div className="market-count"><strong>{state.status === 'loading' ? '—' : summary.valid}</strong><span>只基金已获取净值</span></div>
          <div className="market-mood">
            <span className="mood-up">↑ {state.status === 'loading' ? '—' : summary.up}</span>
            <span className="mood-down">↓ {state.status === 'loading' ? '—' : summary.down}</span>
          </div>
        </div>
        <div className="market-foot"><span className="market-foot-mark">i</span>按基金公布净值展示；QDII 可能存在披露时差</div>
      </section>

      <div className="watch-section-head">
        <div><span className="section-overline">YOUR WATCHLIST</span><h2>关注列表</h2></div>
        <button className="text-action" onClick={load} disabled={state.status === 'loading'}>↻ 更新</button>
      </div>

      <section className="watch-list-card">
        {state.status === 'loading'
          ? WATCH_LIST.map((w) => <RowSkeleton key={w.code} />)
          : state.items.map((item) => <FundRow key={item.code} item={item} onClick={() => item.d && onOpen(item.code)} />)}
      </section>
      {state.status === 'ok' && summary.valid < WATCH_LIST.length && (
        <div className="data-note"><span>!</span>部分基金暂未获取到数据；缺失值保持空白，不做推测。</div>
      )}

      <div className="watch-section-head tools-heading">
        <div><span className="section-overline">NEXT STEP</span><h2>继续探索</h2></div>
      </div>
      <section className="quick-actions">
        <button className="quick-card discover-action" onClick={onDiscover}>
          <span className="quick-icon">⌕</span><span className="quick-title">发现机会</span><span className="quick-caption">查看历史分位与趋势</span><span className="quick-arrow">↗</span>
        </button>
        <button className="quick-card ledger-action" onClick={onSimLedger}>
          <span className="quick-icon">▤</span><span className="quick-title">模拟账本</span><span className="quick-caption">记录策略推演与交易</span><span className="quick-arrow">↗</span>
        </button>
      </section>

      <div className="privacy-note"><span>⌂</span><div><strong>记录留在本机</strong><small>持仓与推演数据仅保存在这台设备</small></div><span className="privacy-check">✓</span></div>
      <p className="watch-disclaimer">行情信息用于学习与策略验证，不构成投资建议。</p>
    </div>
  )
}

function FundRow({ item, onClick }) {
  const { d, error, tag, code } = item
  if (error || !d) {
    return <div className="watch-fund-row unavailable"><div className="fund-avatar">{tag.slice(0, 1)}</div><div className="watch-fund-main"><strong>基金 {code}</strong><small>{error || '暂无数据'}</small></div><span className="fund-unavailable">暂不可用</span></div>
  }
  const last = latestNetWorth(d.netWorth)
  const chg = dayChange(d.netWorth)
  const cls = chg == null || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down'
  const sign = chg > 0 ? '+' : ''
  const dateLabel = last ? fmtNavDate(last.x, 'short') : '日期未知'
  return (
    <button className="watch-fund-row" onClick={onClick}>
      <span className={`fund-avatar avatar-${tag}`}>{tag.slice(0, 1)}</span>
      <span className="watch-fund-main"><strong>{d.name}</strong><small><span className="fund-code">{d.code}</span><i />{tag}<i />净值 {dateLabel}</small></span>
      <span className="watch-fund-numbers"><strong>{last ? last.y.toFixed(4) : '—'}</strong><small className={cls}>{chg == null ? '涨跌 —' : `${sign}${chg.toFixed(2)}%`}</small></span>
      <span className="row-chevron">›</span>
    </button>
  )
}
