// src/components/SettingsPanels.jsx · 「我的」页设置面板
// ------------------------------------------------------------
// ThemeRow   深色模式开关（C6）
// AlertPanel 涨跌预警
// IoPanel    导入 / 导出 CSV（C10）
//
// 全部沿用「我的」页现有 card / fund-row 版式，不新增页面。

import { useRef, useState } from 'react'
import { loadThemeMode, applyThemeMode } from '../lib/theme.js'
import { loadAlertRules, saveAlertRules, checkAllAlerts } from '../lib/alerts.js'
import { realHoldingsCsv, simHoldingsCsv, downloadText, importRealHoldingsCsv } from '../lib/io.js'
import {
  loadPrefetchPrefs,
  savePrefetchPrefs,
  lastPrefetch,
  runPrefetch,
} from '../lib/prefetch.js'

/* 阈值兜底：输入框被清空时 Number('') === 0，
   会让「涨跌 ≥0%」这类规则命中全部基金、不停弹预警。
   这里把非法值夹回区间，空值退回该字段的默认值。 */
function clampPct(v, fallback, min, max) {
  const s = String(v ?? '').trim()
  if (s === '') return fallback
  const n = Number(s)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

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
              onChange={(e) => patch({ movePct: clampPct(e.target.value, 3, 0.01, 100) })}
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
              onChange={(e) => patch({ undervaluedPct: clampPct(e.target.value, 30, 0.01, 100) })}
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
              onChange={(e) => patch({ rebalanceDevPct: clampPct(e.target.value, 10, 0.1, 50) })}
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

  async function exportReal() {
    const r = await downloadText(`真实持仓-${dateStamp()}.csv`, realHoldingsCsv())
    setMsg({
      ok: r.ok,
      text: r.ok ? '已生成 CSV，在分享面板里选择保存或发送方式。' : '导出失败：' + (r.error || '当前环境不支持'),
    })
  }

  async function exportSim() {
    const r = await downloadText(`模拟持仓-${dateStamp()}.csv`, simHoldingsCsv())
    setMsg({
      ok: r.ok,
      text: r.ok ? '已生成 CSV，在分享面板里选择保存或发送方式。' : '导出失败：' + (r.error || '当前环境不支持'),
    })
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

/* ---------------- 数据预抓取（M1 后台分层抓） ---------------- */
export function PrefetchPanel() {
  const [prefs, setPrefs] = useState(loadPrefetchPrefs)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [msg, setMsg] = useState(null)
  const [last, setLast] = useState(lastPrefetch)

  function toggle(key) {
    setPrefs(savePrefetchPrefs({ [key]: !prefs[key] }))
  }

  async function runNow() {
    setBusy(true)
    setMsg(null)
    setProgress({ done: 0, total: 0 })
    try {
      const r = await runPrefetch({
        force: true,
        onProgress: (p) => setProgress(p),
      })
      setLast(r)
      setMsg({
        ok: r.fail === 0,
        text:
          r.total === 0
            ? r.skipped > 0
              ? `无需抓取：${r.skipped} 只都在 24 小时内抓过`
              : '没有需要抓取的基金（持仓与自选为空？）'
            : `抓取完成：成功 ${r.ok} 只，失败 ${r.fail} 只（共 ${r.total} 只）` +
              (r.skipped > 0 ? `，跳过 ${r.skipped} 只（24h 内已抓）` : ''),
      })
    } catch (e) {
      setMsg({ ok: false, text: '抓取失败：' + (e?.message || e) })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <>
      <div className="section-title">数据预抓取</div>
      <div className="card">
        <div className="fund-row fund-row-static">
          <div className="fund-main">
            <div className="fund-name fund-name-normal">自动预抓取</div>
            <div className="fund-meta">
              进 App 后在后台分层抓净值历史：① 持仓 ② 自选 + 候选池 ③ 全市场排行（可选）
            </div>
          </div>
          <button
            className={prefs.enabled ? 'switch on' : 'switch'}
            onClick={() => toggle('enabled')}
            aria-label="自动预抓取"
          />
        </div>

        <div className="fund-row fund-row-static" style={{ opacity: prefs.enabled ? 1 : 0.5 }}>
          <div className="fund-main">
            <div className="fund-name fund-name-normal">仅 WiFi 时抓取</div>
            <div className="fund-meta">移动网络下不抓，避免耗流量</div>
          </div>
          <button
            className={prefs.wifiOnly ? 'switch on' : 'switch'}
            onClick={() => toggle('wifiOnly')}
            disabled={!prefs.enabled}
            aria-label="仅 WiFi"
          />
        </div>

        <div className="fund-row fund-row-static" style={{ opacity: prefs.enabled ? 1 : 0.5 }}>
          <div className="fund-main">
            <div className="fund-name fund-name-normal">仅充电时抓取</div>
            <div className="fund-meta">更省电，但数据可能不够新</div>
          </div>
          <button
            className={prefs.chargingOnly ? 'switch on' : 'switch'}
            onClick={() => toggle('chargingOnly')}
            disabled={!prefs.enabled}
            aria-label="仅充电"
          />
        </div>

        <div className="fund-row fund-row-static" style={{ opacity: prefs.enabled ? 1 : 0.5 }}>
          <div className="fund-main">
            <div className="fund-name fund-name-normal">预热全市场排行前 30</div>
            <div className="fund-meta">给筛选与对比预热，抓取量更大</div>
          </div>
          <button
            className={prefs.includeMarket ? 'switch on' : 'switch'}
            onClick={() => toggle('includeMarket')}
            disabled={!prefs.enabled}
            aria-label="预热全市场"
          />
        </div>

        <div className="fund-row fund-row-static fund-row-noline">
          <div className="fund-main">
            <div className="fund-name fund-name-normal">立即抓取一次</div>
            <div className="fund-meta">
              {busy && progress
                ? progress.total
                  ? `进行中 ${progress.done}/${progress.total}（${pct}%）`
                  : '正在统计待抓清单…'
                : last?.at
                  ? `上次 ${new Date(last.at).toLocaleString()} · 成功 ${last.ok} / 失败 ${last.fail}` +
                    (last.skipped > 0 ? ` · 跳过 ${last.skipped}` : '')
                  : '还没抓过'}
            </div>
          </div>
          <button className="btn btn-sm" style={{ flex: 'none' }} onClick={runNow} disabled={busy}>
            {busy ? '抓取中…' : '开始'}
          </button>
        </div>

        {busy && progress?.total ? (
          <div className="progress-track" style={{ marginTop: 'var(--space-2)' }}>
            <div className="progress-rail">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}

        {msg ? (
          <div
            className={'callout ' + (msg.ok ? 'teal' : 'danger')}
            style={{ marginTop: 'var(--space-3)' }}
          >
            {msg.text}
          </div>
        ) : null}

        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          只抓净值历史、存本机，不改任何持仓记录。自动抓取每 6 小时最多一次；
          已抓过的 24 小时内不重复抓。
        </p>
      </div>
    </>
  )
}
