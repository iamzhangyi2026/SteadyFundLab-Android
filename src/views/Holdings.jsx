// src/views/Holdings.jsx · 持仓页（只放真实持仓）
// ------------------------------------------------------------
// 这一页只装自己的钱：真实持仓 + 截图导入入口。
// 模拟盘（练手）不在这里 —— 它是独立页面 views/SimHoldings.jsx，
// 从「自选」页的「模拟账本」进，避免真假持仓挤在同一屏。
//
// 展示走 components/RealHoldingsPanel（首页同款，口径唯一）。

import { useEffect, useRef, useState } from 'react'
import ImportPanel from '../components/ImportPanel.jsx'
import RealHoldingsPanel from '../components/RealHoldingsPanel.jsx'
import { addRealHoldings } from '../lib/realLedger.js'
import { usePullRefresh } from '../lib/usePullRefresh.js'

/**
 * 手动录入一只真实持仓（人控入口：没有截图也能记账）。
 * 只写本机账本，不动任何真实资产；按「代码」覆盖同名记录。
 */
function ManualEntryForm({ onSaved }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [shares, setShares] = useState('')
  const [cost, setCost] = useState('')
  const [msg, setMsg] = useState(null)

  const codeOk = /^\d{6}$/.test(code.trim())
  const sharesOk = Number(shares) > 0
  const costOk = Number(cost) > 0
  const valid = codeOk && sharesOk && costOk

  function save() {
    if (!valid) return
    const r = addRealHoldings([
      {
        code: code.trim(),
        name: name.trim() || null,
        shares: Number(shares),
        // 成本直接写 cost：calcHolding 优先用它算收益，比「市值 ÷ (1+收益率)」更准
        cost: Number(cost),
        amount: Number(cost),
        pct: 0,
        nav_at_import: null,
        nav_date_at_import: '',
      },
    ])
    if (r.written > 0) {
      setMsg({ ok: true, text: `已记录 ${code.trim()}：${Number(shares)} 份，成本 ¥${Number(cost)}` })
      setCode('')
      setName('')
      setShares('')
      setCost('')
      onSaved?.()
    } else {
      setMsg({ ok: false, text: '写入失败：本机存储不可用' })
    }
  }

  return (
    <div className="card" style={{ marginTop: 'var(--space-3)' }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        手动录入持仓
      </div>
      <p className="card-note" style={{ marginTop: 0 }}>
        没有截图也能记账：填代码、份额与成本即可。只写本机账本，不影响真实资产。
      </p>
      <label className="field">
        <span>基金代码（6 位）</span>
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="如 040001"
        />
      </label>
      <label className="field">
        <span>名称（可留空，自动带出）</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如 易方达蓝筹精选混合"
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>持有份额</span>
          <input
            type="number"
            inputMode="decimal"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            placeholder="如 1000"
          />
        </label>
        <label className="field">
          <span>成本金额（元）</span>
          <input
            type="number"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="如 15000"
          />
        </label>
      </div>
      <button className="btn btn-primary btn-block" disabled={!valid} onClick={save}>
        记入本机持仓
      </button>
      {msg ? (
        <div
          className={'callout ' + (msg.ok ? 'teal' : 'danger')}
          style={{ marginTop: 'var(--space-3)' }}
        >
          {msg.text}
        </div>
      ) : null}
      <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
        成本按投入金额记；市值与收益随后续净值自动算。录错了在持仓行里「编辑 / 删除」。
      </p>
    </div>
  )
}

export default function Holdings({ onOpenFund }) {
  const [importOpen, setImportOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [realKey, setRealKey] = useState(0)
  const panelRef = useRef(null)

  // 下拉刷新：重新读账本 + 重新抓行情（force 由面板自己控制）
  usePullRefresh(() => setRealKey((k) => k + 1))

  // 面板展开时滚入视口（导入面板较长，按钮会被底部页签遮住）
  useEffect(() => {
    if (importOpen && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [importOpen])

  return (
    <>
      <RealHoldingsPanel
        refreshKey={realKey}
        onOpenFund={onOpenFund}
        showImportCta={false}
        showTools
      />

      <div className="field-row" style={{ marginTop: 'var(--space-3)' }}>
        <button className="btn btn-block" onClick={() => setImportOpen((v) => !v)}>
          {importOpen ? '收起导入' : '＋ 导入截图'}
        </button>
        <button className="btn btn-block" onClick={() => setManualOpen((v) => !v)}>
          {manualOpen ? '收起录入' : '＋ 手动录入'}
        </button>
      </div>

      {importOpen ? (
        <div className="card" style={{ marginTop: 'var(--space-3)' }} ref={panelRef}>
          <ImportPanel onImported={() => setRealKey((k) => k + 1)} onOpenFund={onOpenFund} />
        </div>
      ) : null}

      {manualOpen ? <ManualEntryForm onSaved={() => setRealKey((k) => k + 1)} /> : null}
    </>
  )
}
