// RebalancePanel.jsx · 组合再平衡提醒二级页
//
// 用户为模拟持仓（交易盘虚拟盘）设目标权重；实时算实际占比 vs 目标占比的偏离，给出调仓建议
// （买/卖多少）；任一基金 |偏离| ≥ 阈值 → 判定需要再平衡。保存的目标用于
// App 打开时自动评估提醒（jsEvaluateRebalance）。数据缺失（无净值）明确标缺，不编数据。

import { useState, useEffect, useCallback } from 'react'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'
import {
  jsRebalanceReport, jsRebalanceTargetsSave, jsRebalanceHistory, jsEvaluateRebalance,
} from '../lib/dataAdapter'

const r2 = (x) => Math.round(x * 100) / 100
const fmtMoney = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })

function Bar({ pct, color }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ height: 8, background: 'rgba(0,0,0,.06)', borderRadius: 4, overflow: 'hidden', marginTop: 6 }}>
      <div style={{ width: `${w}%`, height: '100%', background: color || 'var(--accent)', borderRadius: 4 }} />
    </div>
  )
}

export default function RebalancePanel() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [report, setReport] = useState(null)
  const [targetsEdit, setTargetsEdit] = useState({})   // fund_code → 输入框字符串
  const [history, setHistory] = useState([])
  const [evalMsg, setEvalMsg] = useState('')

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const r = await jsRebalanceReport()
      if (!r.ok) { setErr(r.error || '加载失败'); return }
      const rep = r.data
      setReport(rep)
      // 用已保存目标初始化输入框
      const init = {}
      for (const row of (rep.rows || [])) init[row.fund_code] = row.target_weight != null ? String(row.target_weight) : ''
      setTargetsEdit(init)
      const h = await jsRebalanceHistory()
      setHistory((h.ok ? h.data : []) || [])
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { load() }, [load])
  // 下拉刷新
  useEffect(() => registerPullRefresh(load), [load])

  const onTargetChange = (code, val) => {
    setTargetsEdit(prev => ({ ...prev, [code]: val }))
  }

  const saveTargets = async () => {
    if (!report) return
    const rows = report.rows.map(r => ({
      fund_code: r.fund_code,
      target_weight: Number(targetsEdit[r.fund_code] ?? ''),  // 空/NaN → 0（saveTargets 会过滤）
    }))
    setBusy(true); setErr('')
    try {
      const r = await jsRebalanceTargetsSave(rows)
      if (!r.ok) { setErr(r.error || '保存失败'); return }
      await load()
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }

  const evaluate = async () => {
    setBusy(true); setEvalMsg(''); setErr('')
    try {
      const r = await jsEvaluateRebalance()
      const d = r.data || {}
      if (!r.ok) { setErr(r.error || '评估失败'); return }
      if (d.triggered) {
        setEvalMsg(`已记录一次调仓提醒：最多偏离 ${d.report?.max_drift ?? '?'}%（超过 ${d.report?.drift_threshold ?? '?'}% 的提醒线）`)
      } else if (d.report?.need_rebalance) {
        setEvalMsg('现在需要调仓，但 24 小时内已提醒过，不再重复')
      } else if (!d.report?.has_target) {
        setEvalMsg('还没设目标比例，先给持仓设好目标比例再评估')
      } else {
        setEvalMsg('已检查：当前各基金偏离都不大，暂时不用调仓')
      }
      await load()
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }

  // 无持仓 / 未初始化 / 数据缺失
  if (report && !report.ok) {
    return (
      <div>
        <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 14 }}>
          本页帮你盯住<b>模拟持仓的比例</b>（交易盘虚拟盘）：给每只基金设一个目标占比，App 会盯着实际占比，
          偏离太多就提醒你调仓。
        </div>
        <div className="sub-card" style={{ padding: 18 }}>
          <div className="text-danger cell-note" style={{ marginBottom: 8 }}>⚠ {report.reason}</div>
          <div className="muted cell-note">去底部导航的「交易」页，搜索基金下单买入，建立模拟持仓。</div>
        </div>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="muted cell-note" style={{ padding: 20 }}>
        {busy ? '正在计算…' : (err || '加载中…')}
      </div>
    )
  }

  // 实时算偏离 / 建议（基于编辑态 targetsEdit）
  const total = report.total_market_value
  const threshold = report.drift_threshold
  const liveRows = (report.rows || []).map(r => {
    const t = Number(targetsEdit[r.fund_code])
    const valid = Number.isFinite(t) && t > 0
    const drift = valid ? r2(r.actual_weight - t) : null
    const suggest = valid ? r2(r.market_value - total * t / 100) : null
    return { ...r, target_weight: valid ? t : null, drift, suggest_amount: suggest }
  })
  const maxDrift = Math.max(0, ...liveRows.map(r => Math.abs(r.drift ?? 0)))
  const hasTarget = liveRows.some(r => r.target_weight != null)
  const need = hasTarget && maxDrift >= threshold
  const sumTarget = r2(liveRows.reduce((s, r) => s + (r.target_weight || 0), 0))

  return (
    <div>
      <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 14 }}>
        给模拟持仓的每只基金设<b>目标占比</b>（合计建议 100%）。实际占比偏离目标超过
        <b> {threshold}%</b> 就判定需要调仓，App 打开时自动提醒（本地通知 + 下方记录）。
      </div>

      {/* 结论卡片 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>调仓状态</span>
          {need
            ? <span style={{ color: 'var(--danger)', fontWeight: 600, fontSize: 13 }}>⚠ 需要调仓</span>
            : <span style={{ color: 'var(--down)', fontWeight: 600, fontSize: 13 }}>✓ 比例正常</span>}
        </div>
        <div className="muted cell-note" style={{ marginTop: 6 }}>
          组合市值 <b>{fmtMoney(total)}</b> · 最多偏离 <b>{maxDrift}%</b> · 提醒线 <b>{threshold}%</b>
        </div>
      </div>

      {/* 目标设定 + 对比 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>目标比例与调仓建议</span>
          <button className="btn-tiny" disabled={busy} onClick={saveTargets}>保存目标</button>
        </div>
        <div className="muted cell-note" style={{ marginTop: 6 }}>
          目标合计 <b style={{ color: Math.abs(sumTarget - 100) > 0.5 ? 'var(--warn)' : 'var(--down)' }}>{sumTarget}%</b>
          {Math.abs(sumTarget - 100) > 0.5 ? '（建议调整到 100%）' : ''}
        </div>

        <div style={{ marginTop: 10 }}>
          {liveRows.length === 0 ? (
            <div className="muted cell-note">模拟持仓还没有净值，算不出市值。先去「我的 → 数据」页补全净值。</div>
          ) : (
            liveRows.map(r => (
              <div key={r.fund_code} style={{ padding: '10px 0', borderBottom: '1px solid rgba(0,0,0,.06)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {r.fund_name || r.fund_code} <span className="muted cell-note">{r.fund_code}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {r.actual_weight}% <span className="muted cell-note">实际</span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <span className="muted cell-note" style={{ flex: '0 0 auto' }}>目标</span>
                  <input
                    className="inp" style={{ flex: '0 0 80px', minWidth: 80 }}
                    placeholder="0"
                    inputMode="decimal"
                    value={targetsEdit[r.fund_code] ?? ''}
                    onChange={e => onTargetChange(r.fund_code, e.target.value)}
                    onBlur={e => onTargetChange(r.fund_code, e.target.value)} />
                  <span className="muted cell-note">%</span>
                  {r.drift != null && (
                    <span className="cell-note" style={{ flex: 1, textAlign: 'right', color: Math.abs(r.drift) >= threshold ? 'var(--danger)' : 'var(--text-soft)' }}>
                      偏离 {r.drift > 0 ? '+' : ''}{r.drift}%
                    </span>
                  )}
                </div>

                {r.suggest_amount != null && (
                  <div className="cell-note" style={{ marginTop: 4, color: r.suggest_amount >= 0 ? 'var(--accent)' : 'var(--down)' }}>
                    {r.suggest_amount >= 0
                      ? `建议加仓 ${fmtMoney(r.suggest_amount)}（需预备现金）`
                      : `建议赎回 ${fmtMoney(-r.suggest_amount)}（落到现金）`}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {err && <div className="text-danger cell-note" style={{ marginBottom: 10 }}>⚠ {err}</div>}

      {/* 立即评估 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>调仓提醒</span>
          <button className="btn-tiny" disabled={busy} onClick={evaluate}>立即检查</button>
        </div>
        <div className="muted cell-note" style={{ marginTop: 6 }}>
          检查当前是否需要调仓；需要且距上次提醒超过 24 小时，就记一条（App 打开时也会自动检查）。
        </div>
        {evalMsg && <div className="cell-note" style={{ marginTop: 8, color: 'var(--down)' }}>{evalMsg}</div>}
      </div>

      {/* 提醒记录 */}
      <div className="sub-card" style={{ padding: 14 }}>
        <div className="subhead">提醒记录（{history.length}）</div>
        {history.length === 0 ? (
          <div className="muted cell-note" style={{ marginTop: 8 }}>还没有调仓提醒。偏离超过提醒线、且距上次超过 24 小时后，会出现在这里。</div>
        ) : (
          <div style={{ marginTop: 8 }}>
            {history.map(h => (
              <div key={h.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,.06)' }}>
                <div className="muted cell-note">
                  {h.triggered_at?.slice(0, 16)?.replace('T', ' ')} · 最多偏离 {h.max_drift}%
                  {h.need_rebalance ? ' · 需调仓' : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
