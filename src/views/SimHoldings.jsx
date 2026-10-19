// src/views/SimHoldings.jsx · 模拟账本（练手池）
// ------------------------------------------------------------
// 从持仓页拆出来的独立页面：持仓页只放真实持仓（自己的钱），
// 模拟盘属于练手，不该和真金白银挤在同一屏。
//
// 数据源：lib/simLedger.js（记录模拟买入的账本）。
// 组合分析（每日收益 / 基准 / 风险 / 重叠 / 分红 / 再平衡 / 目标）
// 与真实持仓共用 components/PortfolioToolbelt，口径只写一遍。

import { useEffect, useMemo, useState } from 'react'
import Stat from '../components/Stat.jsx'
import { fetchFund, latestNetWorth, dayChange } from '../lib/eastmoney.js'
import { fetchHoldingsLive } from '../lib/live.js'
import { simHoldingByCode } from '../lib/simLedger.js'
import { fromSimRow, decorate } from '../lib/holdingsModel.js'
import PortfolioToolbelt from '../components/PortfolioToolbelt.jsx'
import { RebalancePanel } from '../components/PortfolioPanels.jsx'
import GoalPanel from '../components/GoalPanel.jsx'
import { usePullRefresh } from '../lib/usePullRefresh.js'

const fmt2 = (n) =>
  n == null
    ? '—'
    : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function SimHoldings() {
  const [rows, setRows] = useState(null)
  const [liveMap, setLiveMap] = useState({})
  const [reloadKey, setReloadKey] = useState(0)

  usePullRefresh(() => setReloadKey((k) => k + 1))

  /* 账本 + 净值（明细行展示：份额/投入/净值/当日涨跌） */
  useEffect(() => {
    let alive = true
    const base = simHoldingByCode()
    if (base.length === 0) {
      setRows([])
      return
    }
    setRows(null)
    Promise.all(
      base.map(async (b) => {
        try {
          const d = await fetchFund(b.code)
          const last = latestNetWorth(d.netWorth)
          return {
            ...b,
            name: d.name || b.name,
            nav: last ? last.y : null,
            chg: dayChange(d.netWorth),
          }
        } catch {
          return { ...b, nav: null, chg: null }
        }
      }),
    ).then((rs) => alive && setRows(rs))
    return () => {
      alive = false
    }
  }, [reloadKey])

  /* 实时行情：组合分析用（有缓存，不重复请求） */
  const codesKey = (rows || []).map((r) => r.code).join(',')
  useEffect(() => {
    if (!codesKey) return
    let alive = true
    fetchHoldingsLive(codesKey.split(','), { force: false })
      .then((m) => alive && setLiveMap(m))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [codesKey])

  const loaded = rows || []
  const model = useMemo(
    () => decorate(loaded.map((r) => fromSimRow(r, liveMap[r.code] || null))),
    [loaded, liveMap],
  )

  const mv = model.reduce((s, r) => s + (r.mv ?? 0), 0)
  const input = model.reduce((s, r) => s + (r.cost ?? 0), 0)
  const pnl = mv - input
  const estAll = model.length > 0 && model.every((r) => r.estPnl != null)
  const today = estAll ? model.reduce((s, r) => s + r.estPnl, 0) : null

  const loading = rows == null
  const empty = rows != null && loaded.length === 0

  return (
    <>
      <div className="card">
        <div className="hero-label">模拟总市值（元）</div>
        <div className="hero-num">{loading ? '—' : fmt2(mv)}</div>
        <div className="stat-grid">
          <Stat k="模拟投入" v={loading ? '—' : fmt2(input)} />
          <Stat
            k="模拟收益"
            v={loading ? '—' : fmt2(pnl)}
            cls={pnl > 0 ? 'up' : pnl < 0 ? 'down' : undefined}
          />
          <Stat k="持仓基金" v={loading ? '—' : `${loaded.length} 只`} />
          <Stat
            k="今日盈亏"
            v={loading || today == null ? '—' : fmt2(today)}
            cls={today == null ? undefined : today > 0 ? 'up' : today < 0 ? 'down' : undefined}
          />
        </div>
      </div>

      {loading ? (
        <div className="card plain card-list">
          <div className="skeleton" style={{ height: 56 }} />
        </div>
      ) : empty ? (
        <div className="card">
          <div className="empty">
            <div className="empty-title">还没有模拟持仓</div>
            <div className="empty-note">
              在「自选」或「发现」里打开一只基金，在详情页点「记录模拟买入」，记录后就会出现在这里
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="section-title">持仓明细</div>
          <div className="card plain card-list">
            {model.map((r) => (
              <div className="fund-row fund-row-static" key={r.code}>
                <div className="fund-main">
                  <div className="fund-name">{r.name || r.code}</div>
                  <div className="fund-meta">
                    <span className="num">{r.code}</span>
                    {r.shares != null ? ` · ${r.shares.toFixed(2)} 份` : ''} · 投入 ¥
                    {fmt2(r.cost)}
                    {liveMap[r.code]?.nav != null
                      ? ` · 净值 ${liveMap[r.code].nav.toFixed(4)}`
                      : ''}
                  </div>
                </div>
                <div className="fund-num">
                  <div className="fund-nav">{r.mv != null ? fmt2(r.mv) : '—'}</div>
                  <div
                    className={`fund-chg ${
                      r.pnl == null || r.pnl === 0 ? 'flat' : r.pnl > 0 ? 'up' : 'down'
                    }`}
                  >
                    {r.pnl == null ? '—' : `${r.pnl > 0 ? '+' : ''}${r.pnl.toFixed(2)}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 组合分析（与真实持仓共用同一套组件与口径） */}
      {!empty && !loading ? (
        <>
          <PortfolioToolbelt model={model} />
          <RebalancePanel holdings={model} />
          <GoalPanel principal={!loading ? mv : null} />
        </>
      ) : null}
    </>
  )
}
