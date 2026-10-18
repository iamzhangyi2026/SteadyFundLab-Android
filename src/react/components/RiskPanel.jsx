// RiskPanel.jsx · 组合风险分析二级页
//
// 分析你的**真实持仓组合**（截图导入）：
//   ① 持仓集中度 —— 各基金市值占比：单一最大 / 前三大 / 等效持仓数 / HHI
//   ② 行业暴露   —— 各基金行业配置按市值加权聚合成组合级行业分布
// 数据缺失（无净值 / 无行业配置）→ 明确标「数据缺失」，并给「补全行业数据」按钮联网补抓，绝不编数据。

import { useState, useEffect, useCallback } from 'react'
import { jsRiskReport, jsFetchAndSaveHoldings } from '../lib/dataAdapter'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'

const fmtMoney = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })

function LevelBadge({ level }) {
  if (level === 'high') return <span style={{ color: 'var(--danger)', fontWeight: 600, fontSize: 13 }}>⚠ 偏高</span>
  if (level === 'warn') return <span style={{ color: 'var(--warn)', fontWeight: 600, fontSize: 13 }}>● 略集中</span>
  return <span style={{ color: 'var(--down)', fontWeight: 600, fontSize: 13 }}>✓ 较均衡</span>
}

function Bar({ pct, color }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ height: 8, background: 'rgba(0,0,0,.06)', borderRadius: 4, overflow: 'hidden', marginTop: 6 }}>
      <div style={{ width: `${w}%`, height: '100%', background: color || 'var(--accent)', borderRadius: 4 }} />
    </div>
  )
}

export default function RiskPanel() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [report, setReport] = useState(null)

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const r = await jsRiskReport()
      if (!r.ok) { setErr(r.error || '加载失败'); return }
      setReport(r.data)
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { load() }, [load])
  // 下拉刷新
  useEffect(() => registerPullRefresh(load), [load])

  // 补全行业数据：逐只抓行业配置 + 重仓股并落库，再重算
  const refreshIndustry = async () => {
    if (!report || !report.concentration?.positions?.length) { await load(); return }
    setBusy(true); setErr('')
    try {
      const codes = report.concentration.positions.map(p => p.fund_code)
      let done = 0
      for (const code of codes) {
        try { await jsFetchAndSaveHoldings(code) } catch { /* 单只失败跳过 */ }
        done++
      }
      await load()
      if (done > 0) setErr('')
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }

  // 无持仓 / 未初始化
  if (report && !report.ok) {
    return (
      <div>
        <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 14 }}>
          看的是你<b>真实持仓</b>（截图导入）的整体情况：钱压在几只基金上、分布在哪些行业。
        </div>
        <div className="sub-card" style={{ padding: 18 }}>
          <div className="text-danger cell-note" style={{ marginBottom: 8 }}>⚠ {report.reason}</div>
          <div className="muted cell-note">去底部导航的「持仓」页，点「＋ 导入真实持仓截图」把真实持仓导进来，再来这里看风险分析。</div>
        </div>
      </div>
    )
  }

  if (!report) {
    return (
      <div className="muted cell-note" style={{ padding: 20 }}>
        {busy ? '正在计算组合风险…' : (err || '加载中…')}
      </div>
    )
  }

  const c = report.concentration
  const ind = report.industry
  const t = report.thresholds

  return (
    <div>
      <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 14 }}>
        看的是你<b>真实持仓</b>（截图导入）的整体情况：钱压在几只基金上、分布在哪些行业。
      </div>

      {/* 组合概览 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead">组合概览</div>
        <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
          <div>
            <div className="muted cell-note">组合市值（元）</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtMoney(report.total_market_value)}</div>
          </div>
          <div>
            <div className="muted cell-note">持仓只数</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{report.positions_count}</div>
          </div>
        </div>
      </div>

      {/* 集中度 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>持仓集中度</span>
          <LevelBadge level={c.level} />
        </div>
        <div className="muted cell-note" style={{ marginTop: 6 }}>
          单只最多 <b>{c.top1_weight}%</b> · 前三只合计 <b>{c.top3_weight}%</b> · 相当于分散在 <b>{c.effective_n}</b> 只上 · 集中度指数 <b>{c.hhi}</b>
        </div>

        {c.flags.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {c.flags.map((f, i) => (
              <div key={i} className="text-danger cell-note" style={{ marginBottom: 2 }}>⚠ {f}</div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 10 }}>
          {c.positions.map(p => (
            <div key={p.fund_code} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {p.fund_name || p.fund_code} <span className="muted cell-note">{p.fund_code}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{p.weight_pct != null ? p.weight_pct + '%' : '—'}</div>
              </div>
              {p.weight_pct != null ? <Bar pct={p.weight_pct} color={p.weight_pct > t.single_max_pct ? 'var(--danger)' : 'var(--accent)'} /> : null}
            </div>
          ))}
        </div>
      </div>

      {/* 行业暴露 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>行业分布</span>
          <LevelBadge level={ind.level} />
        </div>
        <div className="muted cell-note" style={{ marginTop: 6 }}>
          行业配置已覆盖 <b>{ind.coverage?.with_data ?? 0}</b> / {ind.coverage?.total ?? 0} 只基金
          {ind.coverage?.with_data != null && ind.coverage.total > 0 && ind.coverage.with_data < ind.coverage.total
            ? '（其余基金未抓到行业配置，点击下方按钮补全）' : ''}
        </div>

        {ind.ok && ind.exposure.length > 0 ? (
          <>
            {ind.flags.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {ind.flags.map((f, i) => (
                  <div key={i} className="text-danger cell-note" style={{ marginBottom: 2 }}>⚠ {f}</div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              {ind.exposure.map(row => (
                <div key={row.industry} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,.06)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{row.industry}</div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{row.weight_pct}%</div>
                  </div>
                  <Bar pct={row.weight_pct} color={row.weight_pct > t.industry_max_pct ? 'var(--danger)' : 'var(--down)'} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="text-danger cell-note" style={{ marginTop: 8 }}>⚠ {ind.reason || '行业配置数据缺失'}</div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 12 }}
          disabled={busy}
          onClick={refreshIndustry}
        >
          {busy ? '正在补全…' : '补全行业数据（联网抓取）'}
        </button>
      </div>

      {err && <div className="text-danger cell-note" style={{ marginBottom: 10 }}>⚠ {err}</div>}
    </div>
  )
}
