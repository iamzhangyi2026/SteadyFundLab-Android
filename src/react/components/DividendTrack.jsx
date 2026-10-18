// DividendTrack.jsx · 分红跟踪二级页
//
// 自动记录持有基金的现金分红到账与红利再投（依据净值除息识别，刷新净值时自动入账，不重复计）。
// 汇总取真实落账（cash_ledger / orders），不是估算。

import { useState, useEffect, useCallback } from 'react'
import { jsRefreshDividends, jsDividendReport } from '../lib/dataAdapter'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'

const cellStyle = { padding: '5px 8px', borderBottom: '1px solid rgba(0,0,0,.06)' }

const fmtMoney = (x) =>
  (x == null || x === 0) ? '—' : '¥' + Number(x).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtShares = (x) =>
  (x == null || x === 0) ? '—' : Number(x).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 份'

function groupByFund(rows) {
  const m = new Map()
  for (const r of rows) {
    if (!m.has(r.fund_code)) {
      m.set(r.fund_code, { fund_code: r.fund_code, fund_name: r.fund_name, events: [] })
    }
    m.get(r.fund_code).events.push(r)
  }
  return [...m.values()]
}

export default function DividendTrack() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [summary, setSummary] = useState(null)
  const [groups, setGroups] = useState([])

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      await jsRefreshDividends()
      const r = await jsDividendReport()
      if (!r.ok) { setErr(r.error || '加载失败'); return }
      setSummary(r.data.summary)
      setGroups(groupByFund(r.data.rows))
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { load() }, [load])
  // 下拉刷新
  useEffect(() => registerPullRefresh(load), [load])

  return (
    <div>
      <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 14 }}>
        自动记录你持有基金的<b>现金分红到账</b>与<b>分红再买入</b>，刷新净值时自动入账。
      </div>

      {summary && (
        <div className="sub-card" style={{ marginBottom: 14, padding: 14, lineHeight: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="muted">累计现金分红</span>
            <b style={{ color: 'var(--up)' }}>{fmtMoney(summary.cash_total)}</b>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="muted">分红再买入的份额</span>
            <b>{fmtShares(summary.reinvest_shares_total)}</b>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="muted">分红次数 / 涉及基金</span>
            <b>{(summary.event_count ?? 0)} 次 / {(summary.fund_count ?? 0)} 只</b>
          </div>
        </div>
      )}

      <button className="btn-primary btn-block" style={{ width: '100%' }} disabled={busy} onClick={load}>
        {busy ? '刷新中…' : '刷新分红记录'}
      </button>

      {err && <div className="error-banner" style={{ marginTop: 12 }}>⚠ {err}</div>}

      {!busy && groups.length === 0 && !err && (
        <div className="muted cell-note" style={{ marginTop: 16 }}>
          暂无分红记录。点上方「刷新分红记录」同步。
        </div>
      )}

      {groups.map((g) => (
        <div key={g.fund_code} className="sub-card" style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {g.fund_name}
            <span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{g.fund_code}</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-soft)' }}>
                <th style={cellStyle}>分红日</th>
                <th style={cellStyle}>每份分红</th>
                <th style={cellStyle}>方式</th>
                <th style={cellStyle}>我的</th>
              </tr>
            </thead>
            <tbody>
              {g.events.map((e, i) => (
                <tr key={i}>
                  <td style={cellStyle}>{e.ex_date}</td>
                  <td style={cellStyle}>¥{Number(e.dividend_per_share).toFixed(4)}</td>
                  <td style={cellStyle}>{e.reinvest ? '分红再买入' : '现金分红'}</td>
                  <td style={cellStyle}>{e.reinvest ? fmtShares(e.reinvest_shares) : fmtMoney(e.cash_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
