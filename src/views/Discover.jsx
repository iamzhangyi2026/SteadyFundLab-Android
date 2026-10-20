/**
 * 发现页 —— 估值洼地筛选
 * ------------------------------------------------------------
 * 对一篮子候选基金算两个指标，再按「分位从低到高」排序：
 *   分位 —— 当前净值在自身历史中的位置（越低越接近历史低位）
 *   趋势 —— 近 60 个交易日的涨跌（用来看方向）
 * 两者同时命中会额外打一个「双条件命中」标签。
 *
 * ⚠️ CANDIDATES 是**硬编码的候选池**，不是全市场扫描 ——
 *    全市场两万多只接口量大、需分批，暂未做。
 * ⚠️ 本页只是统计展示，不构成任何买入建议。
 */

import { useEffect, useState } from 'react'
import { fetchFund, latestNetWorth, dayChange } from '../lib/eastmoney.js'
import { drawdownRecovery } from '../lib/navlab.js'
import RowSkeleton from '../components/RowSkeleton.jsx'

const CANDIDATES = ['040001', '110010', '000021', '100038', '001594', '519674']

/* 分位与趋势都用**累计净值**：单位净值会因分红跳空，
   一次分红就被误读成一次下跌，分位和趋势随之失真 */

/** 当前累计净值在自身历史中的分位（%）—— 越低越"洼地" */
function percentile(series) {
  if (!series || series.length < 30) return null
  const vals = series.map((d) => Number(d.y)).filter(Number.isFinite)
  if (vals.length < 30) return null
  const last = vals[vals.length - 1]
  const below = vals.filter((v) => v <= last).length
  return (below / vals.length) * 100
}

/** 近 60 个交易日趋势（%），按累计净值 */
function trend(series, n = 60) {
  if (!series || series.length < n + 1) return null
  const vals = series.map((d) => Number(d.y)).filter(Number.isFinite)
  const a = vals[vals.length - 1 - n]
  const b = vals[vals.length - 1]
  if (!a || !Number.isFinite(a) || !Number.isFinite(b)) return null
  return ((b - a) / a) * 100
}

/** 把累计净值序列转成 navlab 需要的 {date, nav, acc_nav} 结构 */
function toSeries(accWorth) {
  if (!Array.isArray(accWorth)) return []
  return accWorth.map((p) => {
    const d = new Date(p.x)
    const pad = (n) => String(n).padStart(2, '0')
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      nav: Number(p.y),
      acc_nav: Number(p.y),
    }
  })
}

export default function Discover({ onOpen, onNavigate }) {
  const [state, setState] = useState({ status: 'loading', items: [] })

  useEffect(() => {
    let alive = true
    Promise.all(
      CANDIDATES.map(async (code) => {
        try {
          const d = await fetchFund(code)
          return { code, d, error: null }
        } catch (e) {
          return { code, d: null, error: e.message }
        }
      })
    ).then((items) => alive && setState({ status: 'ok', items }))
    return () => {
      alive = false
    }
  }, [])

  const rows = state.items
    .filter((it) => it.d)
    .map((it) => ({
      ...it,
      pct: percentile(it.d.accWorth),
      tr: trend(it.d.accWorth),
      dd: drawdownRecovery(toSeries(it.d.accWorth))?.maxDrawdown ?? null,
      chg: dayChange(it.d.netWorth),
      last: latestNetWorth(it.d.netWorth),
    }))
    .sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999))

  return (
    <>
      <div className="section-title">工具</div>
      <div className="quick-actions">
        <button className="quick-card" onClick={() => onNavigate?.('compare')}>
          <span className="quick-icon">⇄</span>
          <span className="quick-title">多基金对比</span>
          <span className="quick-caption">并排看区间与回撤</span>
          <span className="quick-arrow">↗</span>
        </button>
        <button className="quick-card" onClick={() => onNavigate?.('market')}>
          <span className="quick-icon">◎</span>
          <span className="quick-title">大盘指数</span>
          <span className="quick-caption">五大指数实时与 K 线</span>
          <span className="quick-arrow">↗</span>
        </button>
        <button className="quick-card" onClick={() => onNavigate?.('screener')}>
          <span className="quick-icon">⌕</span>
          <span className="quick-title">全市场筛选</span>
          <span className="quick-caption">1.8 万只排行 + 三轨</span>
          <span className="quick-arrow">↗</span>
        </button>
      </div>

      <div className="section-title">标签图例</div>
      <div className="card">
        <div className="chip-row">
          <span className="chip teal">洼地 · 分位 &lt; 50%</span>
          <span className="chip info">趋势向上 · 60 日 &gt; 0</span>
          <span className="chip warn">双条件命中</span>
        </div>
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          下面是候选池，按历史分位从低到高排；达标的会打上对应标签，未打标即未满足。
          分位 = 当前净值在自身历史中的位置，越低越接近历史低位。仅作统计展示，不构成买入建议。
        </p>
      </div>

      <div className="section-title">候选池 · 按分位排序</div>

      {state.status === 'loading' ? (
        <div className="card plain card-list">
          {CANDIDATES.slice(0, 4).map((c) => (
            <RowSkeleton key={c} />
          ))}
        </div>
      ) : (
        <div className="card plain card-list">
          {rows.map((r) => (
            <CandidateRow key={r.code} r={r} onClick={() => onOpen(r.code)} />
          ))}
        </div>
      )}

      <p className="card-note" style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
        共 {CANDIDATES.length} 只候选 · 按分位从低到高排序，达标项已打标
      </p>
    </>
  )
}

function CandidateRow({ r, onClick }) {
  const low = r.pct != null && r.pct < 50
  const upTrend = r.tr != null && r.tr > 0
  return (
    <div className="fund-row" onClick={onClick}>
      <div className="fund-main">
        <div className="fund-name">{r.d.name}</div>
        <div className="fund-meta">
          分位 <span className="num">{r.pct == null ? '—' : `${r.pct.toFixed(1)}%`}</span>
          {' · '}
          <span className={upTrend ? 'down' : 'up'}>
            60日 {r.tr == null ? '—' : `${r.tr > 0 ? '+' : ''}${r.tr.toFixed(1)}%`}
          </span>
          {' · '}
          <span className="down">回撤 {r.dd == null ? '—' : `${r.dd.toFixed(1)}%`}</span>
        </div>
        <div className="chip-row" style={{ marginTop: 6 }}>
          {low && <span className="chip teal">洼地</span>}
          {upTrend && <span className="chip info">趋势向上</span>}
          {low && upTrend && <span className="chip warn">双条件命中</span>}
        </div>
      </div>
      <div className="fund-num">
        <div className="fund-nav num">{r.last ? r.last.y.toFixed(4) : '—'}</div>
        <div
          className={`fund-chg num ${
            r.chg == null || r.chg === 0 ? 'flat' : r.chg > 0 ? 'up' : 'down'
          }`}
        >
          {r.chg == null ? '—' : `${r.chg > 0 ? '+' : ''}${r.chg.toFixed(2)}%`}
        </div>
      </div>
    </div>
  )
}

