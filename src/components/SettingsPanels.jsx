// src/components/SettingsPanels.jsx · 「我的」页设置面板
// ------------------------------------------------------------
// ThemeRow   深色模式开关（C6）
// AlertPanel 涨跌预警（C7）
// IoPanel    导入 / 导出 CSV（C10）
//
// 全部沿用「我的」页现有 card / fund-row 版式，不新增页面。

import { useRef, useState } from 'react'
import { loadThemeMode, applyThemeMode } from '../lib/theme.js'
import { loadAlertRules, saveAlertRules, checkAllAlerts } from '../lib/alerts.js'
import { realHoldingsCsv, simHoldingsCsv, downloadText, importRealHoldingsCsv } from '../lib/io.js'

/* ---------------- 深色模式 ---------------- */
export function ThemeRow() {
  const [mode, setMode] = useState(loadThemeMode)

  function toggle() {
    const next = applyThemeMode(mode === 'dark' ? 'light' : 'dark')
    setMode(next)
  }

  return (
    <div className="fund-row" style={{ cursor: 'default' }}>
      <div className="fund-main">
        <div className="fund-name fund-name-normal">深色模式</div>
        <div className="fund-meta">只切换配色，版式不变</div>
      </div>
      <button
        className={mode === 'dark' ? 'switch on' : 'switch'}
        onClick={toggle}
        aria-label="深色模式"
      />
    </div>
  )
}

/* ---------------- 预警中心 ---------------- */
export function AlertPanel({ holdings = [] }) {
  const [rules, setRules] = useState(loadAlertRules)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const codes = holdings.map((r) => r.code).filter(Boolean)

  function patch(p) {
    setRules(saveAlertRules(p))
  }

  function setNavTarget(code, v) {
    const next = { ...(rules.navTargets || {}) }
    if (String(v).trim() === '') delete next[code]
    else next[code] = Number(v)
    patch({ navTargets: next })
  }

  async function runCheck() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await checkAllAlerts({ codes, holdings })
      const lines = []
      if (r.price.length) lines.push(`涨跌 ${r.price.length} 只`)
      if (r.navTarget.length) lines.push(`净值到目标 ${r.navTarget.length} 只`)
      if (r.undervalued.length) lines.push(`估值洼地 ${r.undervalued.length} 只`)
      if (r.rebalance.length) lines.push(`再平衡偏离 ${r.rebalance.length} 只`)
      setMsg(
        lines.length
          ? { ok: true, text: '本次命中：' + lines.join('、') }
          : { ok: true, text: '本次检查没有命中任何预警。' },
      )
    } catch (e) {
      setMsg({ ok: false, text: e?.message || '检查失败' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="section-title">预警</div>
      <div className="card">
        {/* 涨跌 */}
        <div className="fund-row fund-row-static fund-row-noline">
          <div className="fund-main">
            <div className="fund-name fund-name-normal">涨跌预警</div>
            <div className="fund-meta">单日涨跌幅超过阈值</div>
          </div>
          <button
            className={rules.enabled ? 'switch on' : 'switch'}
            onClick={() => patch({ enabled: !rules.enabled })}
            aria-label="涨跌预警"
          />
        </div>
        {rules.enabled ? (
          <label className="field">
            <span>单日涨跌阈值（%）</span>
            <input
              type="number"
              inputMode="decimal"
              value={rules.movePct}
              onChange={(e) => patch({ movePct: Number(e.target.value) })}
            />
          </label>
        ) : null}

        {/* 净值目标 */}
        <div className="pp-sub">净值目标（最新净值 ≤ 目标时提醒）</div>
        {holdings.filter((r) => r.code).length === 0 ? (
          <p className="card-note">还没有带代码的真实持仓，无法设置净值目标。</p>
        ) : (
          holdings
            .filter((r) => r.code)
            .map((r) => (
              <div className="alert-nav-row" key={r.code}>
                <span className="alert-nav-name">{r.name || r.code}</span>
                <input
                  className="rb-input"
                  type="number"
                  inputMode="decimal"
                  placeholder="目标净值"
                  value={rules.navTargets?.[r.code] ?? ''}
                  onChange={(e) => setNavTarget(r.code, e.target.value)}
                />
              </div>
            ))
        )}

        {/* 估值洼地 */}
        <div className="fund-row fund-row-static fund-row-noline" style={{ marginTop: 'var(--space-3)' }}>
          <div className="fund-main">
            <div className="fund-name fund-name-normal">估值洼地提醒</div>
            <div className="fund-meta">累计净值历史分位低于阈值</div>
          </div>
          <button
            className={rules.undervaluedEnabled ? 'switch on' : 'switch'}
            onClick={() => patch({ undervaluedEnabled: !rules.undervaluedEnabled })}
            aria-label="估值洼地提醒"
          />
        </div>
        {rules.undervaluedEnabled ? (
          <label className="field">
            <span>分位阈值（%）</span>
            <input
              type="number"
              inputMode="decimal"
              value={rules.undervaluedPct}
              onChange={(e) => patch({ undervaluedPct: Number(e.target.value) })}
            />
          </label>
        ) : null}

        {/* 再平衡 */}
        <div className="fund-row fund-row-static fund-row-noline" style={{ marginTop: 'var(--space-3)' }}>
          <div className="fund-main">
            <div className="fund-name fund-name-normal">再平衡提醒</div>
            <div className="fund-meta">实际占比偏离目标超过阈值</div>
          </div>
          <button
            className={rules.rebalanceEnabled ? 'switch on' : 'switch'}
            onClick={() => patch({ rebalanceEnabled: !rules.rebalanceEnabled })}
            aria-label="再平衡提醒"
          />
        </div>
        {rules.rebalanceEnabled ? (
          <label className="field">
            <span>偏离阈值（百分点）</span>
            <input
              type="number"
              inputMode="decimal"
              value={rules.rebalanceDevPct}
              onChange={(e) => patch({ rebalanceDevPct: Number(e.target.value) })}
            />
          </label>
        ) : null}

        <button
          className="btn btn-block"
          style={{ marginTop: 'var(--space-3)' }}
          onClick={runCheck}
          disabled={busy || codes.length === 0}
        >
          {busy ? '检查中…' : codes.length === 0 ? '先导入持仓再检查' : '立即检查一次'}
        </button>

        {msg ? (
          <div className={'callout ' + (msg.ok ? 'teal' : 'danger')} style={{ marginTop: 'var(--space-3)' }}>
            {msg.text}
          </div>
        ) : null}

        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          同一只基金同一天同一类型只提醒一次；没开通知权限时只做检查、不发通知。
          估值洼地需逐只抓历史净值，检查会慢几秒。
        </p>
      </div>
    </>
  )
}

/* ---------------- 导入 / 导出 ---------------- */
export function IoPanel({ onImported }) {
  const fileRef = useRef(null)
  const [msg, setMsg] = useState(null)

  function exportReal() {
    const ok = downloadText(`真实持仓-${dateStamp()}.csv`, realHoldingsCsv())
    setMsg({ ok, text: ok ? '真实持仓 CSV 已生成，请在下载目录查看。' : '导出失败：当前环境不支持下载。' })
  }

  function exportSim() {
    const ok = downloadText(`模拟持仓-${dateStamp()}.csv`, simHoldingsCsv())
    setMsg({ ok, text: ok ? '模拟持仓 CSV 已生成，请在下载目录查看。' : '导出失败：当前环境不支持下载。' })
  }

  async function onFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      const text = await f.text()
      const r = importRealHoldingsCsv(text)
      if (r.error) {
        setMsg({ ok: false, text: '导入失败：' + r.error })
      } else {
        setMsg({ ok: true, text: `导入完成：写入 ${r.written} 条，当前共 ${r.total} 条。` })
        onImported?.()
      }
    } catch (err) {
      setMsg({ ok: false, text: '读取文件失败：' + (err?.message || err) })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <>
      <div className="section-title">导入 / 导出</div>
      <div className="card">
        <div className="fund-row fund-row-static fund-row-noline">
          <div className="fund-main">
            <div className="fund-name fund-name-normal">真实持仓</div>
            <div className="fund-meta">CSV（UTF-8，Excel 可直接打开）</div>
          </div>
          <button className="btn btn-sm" style={{ flex: 'none' }} onClick={exportReal}>
            导出
          </button>
        </div>
        <div className="fund-row fund-row-static fund-row-noline">
          <div className="fund-main">
            <div className="fund-name fund-name-normal">模拟持仓</div>
            <div className="fund-meta">练手记录，列结构与真实持仓一致</div>
          </div>
          <button className="btn btn-sm" style={{ flex: 'none' }} onClick={exportSim}>
            导出
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={onFile}
        />
        <button
          className="btn btn-block"
          style={{ marginTop: 'var(--space-3)' }}
          onClick={() => fileRef.current?.click()}
        >
          导入真实持仓 CSV
        </button>

        {msg ? (
          <div className={'callout ' + (msg.ok ? 'teal' : 'danger')} style={{ marginTop: 'var(--space-3)' }}>
            {msg.text}
          </div>
        ) : null}

        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          导入按「代码 / 名称」覆盖，不累加；缺少的数值列留空，不补 0。
        </p>
      </div>
    </>
  )
}

function dateStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}
