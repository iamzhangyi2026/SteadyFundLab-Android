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
import {
  loadSimHoldings,
  removeSimHolding,
  clearSimHoldings,
  simHoldingByCode,
} from '../lib/simLedger.js'
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
  const [records, setRecords] = useState(null) // 明细（每笔一条，可删）
  const [rows, setRows] = useState(null) // 聚合（组合分析用）
  const [liveMap, setLiveMap] = useState({})
  const [reloadKey, setReloadKey] = useState(0)

  usePullRefresh(() => setReloadKey((k) => k + 1))

  /* 明细 + 聚合一起刷新；删除后调 reload 即可 */
  useEffect(() => {
    let alive = true
    const all = loadSimHoldings()
    const base = simHoldingByCode()
    if (base.length === 0) {
      setRecords([])
      setRows([])
      return
    }
    setRecords(null)
    setRows(null)
    const codes = [...new Set(all.map((r) => r.code))]
    Promise.all(
      codes.map(async (code) => {
        try {
          const d = await fetchFund(code)
          const last = latestNetWorth(d.netWorth)
          return { code, name: d.name, nav: last ? last.y : null, chg: dayChange(d.netWorth) }
        } catch {
          return { code, name: '', nav: null, chg: null }
        }
      }),
    ).then((navByCode) => {
      if (!alive) return
      const m = new Map(navByCode.map((n) => [n.code, n]))
      setRecords(
        all.map((r) => {
          const n = m.get(r.code) || {}
          return { ...r, name: n.name || r.name, nav: n.nav ?? null, chg: n.chg ?? null }
        }),
      )
      setRows(
        base.map((b) => {
          const n = m.get(b.code) || {}
          return { ...b, name: n.name || b.name, nav: n.nav ?? null, chg: n.chg ?? null }
        }),
      )
    })
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

  /* 删除单笔：先确认，删完刷新明细与汇总 */
  function removeRec(rec) {
    if (!window.confirm(`删除「${rec.name || rec.code}」的这笔模拟买入？\n仅删本机记录，不影响真实资产。`)) return
    // removeSimHolding 在缺少 id 时返回 false —— 不判返回值的话，
    // 用户点了删除但记录还在，界面毫无提示，像是没生效。
    if (!removeSimHolding(rec.id)) {
      window.alert('删除失败：这条记录缺少标识，请重新导入或重启 App 后再试。')
      return
    }
    setReloadKey((k) => k + 1)
  }

  function clearAll() {
    if (!window.confirm(`清空全部 ${records?.length || 0} 笔模拟买入记录？\n此操作不可恢复。`)) return
    clearSimHoldings()
    setReloadKey((k) => k + 1)
  }

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
          <div className="section-title">
            持仓明细
            <button className="text-action" style={{ marginLeft: 'auto' }} onClick={clearAll}>
              清空全部
            </button>
          </div>
          <div className="card plain card-list">
            {(records || []).map((r) => (
              <div className="fund-row fund-row-static" key={r.id || `${r.code}-${r.created_at}`}>
                <div className="fund-main">
                  <div className="fund-name fund-name-normal">{r.name || r.code}</div>
                  <div className="fund-meta">
                    <span className="num">{r.code}</span>
                    {r.shares != null ? ` · ${Number(r.shares).toFixed(2)} 份` : ''} · 投入 ¥
                    {fmt2(Number(r.amount) || 0)}
                    {r.nav_date ? ` · 净值日 ${r.nav_date}` : ''}
                  </div>
                </div>
                <div className="fund-num">
                  {r.nav != null ? <div className="fund-nav">{r.nav.toFixed(4)}</div> : null}
                  <button className="btn btn-sm" onClick={() => removeRec(r)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 组合分析（与真实持仓共用同一套组件与口径） */}
      {!empty && !loading ? (
        <>
          <PortfolioToolbelt model={model} showDaily />
          <RebalancePanel holdings={model} />
          <GoalPanel principal={!loading ? mv : null} />
        </>
      ) : null}
    </>
  )
}
