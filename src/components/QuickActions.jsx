// src/components/QuickActions.jsx · 行内快捷操作表单（定投 / 加仓）
// ------------------------------------------------------------
// 持仓页与自选页共用：每只基金行点「定投」「加仓」就地展开表单，
// 不跳页、不打断浏览。落地函数与「我的」页完整面板完全一致
// （dingtou_plan.upsertPlan / realLedger.appendRealHolding），口径只写一遍。

import { useState } from 'react'
import { upsertPlan } from '../lib/dingtou_plan.js'
import { appendRealHolding, loadRealHoldings } from '../lib/realLedger.js'
import { todayStr } from '../lib/date.js'

/**
 * 快速建定投计划（预填基金）。
 * @param {{code:string, name?:string, onSaved?:function}} props
 */
export function QuickDingtouForm({ code, name, onSaved }) {
  const [amount, setAmount] = useState('1000')
  const [frequency, setFrequency] = useState('monthly')
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [weekday, setWeekday] = useState('1')
  const [startDate, setStartDate] = useState(todayStr())
  const [msg, setMsg] = useState(null)

  const amtOk = Number(amount) > 0
  const dayOk = frequency === 'weekly' ? true : Number(dayOfMonth) >= 1 && Number(dayOfMonth) <= 28
  const valid = amtOk && dayOk && !!startDate

  function save() {
    if (!valid) return
    const id = upsertPlan({
      id: null,
      code,
      name: name || '',
      amount: Number(amount),
      frequency,
      weekday: String(weekday),
      day_of_month: String(dayOfMonth),
      start_date: startDate,
    })
    if (id) {
      setMsg({ ok: true, text: `已建定投：每${frequency === 'weekly' ? '周' : '月'} ¥${Number(amount)}` })
      onSaved?.()
    } else {
      setMsg({ ok: false, text: '保存失败：本机存储不可用' })
    }
  }

  return (
    <div className="rh-edit quick-form">
      <div className="quick-form-head">
        <b>定投 {code}</b>
        <small>{name || ''}</small>
      </div>
      <div className="field-row">
        <label className="field">
          <span>每期金额（元）</span>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1000"
          />
        </label>
        <label className="field">
          <span>频率</span>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="monthly">每月</option>
            <option value="weekly">每周</option>
          </select>
        </label>
      </div>
      <div className="field-row">
        {frequency === 'monthly' ? (
          <label className="field">
            <span>每月几号（1–28）</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="28"
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
            />
          </label>
        ) : (
          <label className="field">
            <span>每周几</span>
            <select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              <option value="1">周一</option>
              <option value="2">周二</option>
              <option value="3">周三</option>
              <option value="4">周四</option>
              <option value="5">周五</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>开始日期</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
      </div>
      <div className="goal-form-actions">
        <button className="btn btn-primary" style={{ flex: 1 }} disabled={!valid} onClick={save}>
          建定投计划
        </button>
      </div>
      {msg ? (
        <div className={'callout ' + (msg.ok ? 'teal' : 'danger')} style={{ marginTop: 8 }}>
          {msg.text}
        </div>
      ) : null}
      <p className="card-note" style={{ marginTop: 8 }}>
        计划到点后由「我的 → 定投计划」按设置自动追加到本机持仓；不自动扣款、不动真钱。
      </p>
    </div>
  )
}

/**
 * 快速加仓（份额 + 投入）。
 * 该基金必须已在本机真实持仓里（appendRealHolding 不自动建仓）；
 * 不在持仓时给出明确提示，引导先「记入持仓」。
 *
 * @param {{code:string, name?:string, nav?:number, navDate?:string, onSaved?:function}} props
 */
export function QuickBuyForm({ code, name, nav, navDate, onSaved }) {
  const [shares, setShares] = useState('')
  const [amount, setAmount] = useState('')
  const [msg, setMsg] = useState(null)

  const held = loadRealHoldings().some((r) => r.code === code)
  /* 输入框里填 1e999 会得到 Infinity，而 Infinity > 0 为真 ——
     不挡住就会把「∞ 份 / ∞ 元」写进账本，汇总里显示「∞」。 */
  const sn = Number(shares)
  const an = Number(amount)
  const valid = Number.isFinite(sn) && sn > 0 && Number.isFinite(an) && an > 0

  function save() {
    if (!valid) return
    const base = Number(nav)
    if (!(base > 0)) {
      setMsg({ ok: false, text: '拿不到该基金净值，暂不能加仓，请稍后重试' })
      return
    }
    const ok = appendRealHolding({
      code,
      name: name || '',
      deltaShares: Number(shares),
      amountCost: Number(amount),
      nav: base,
      navDate: navDate || '',
    })
    if (ok) {
      setMsg({ ok: true, text: `已加仓：+${Number(shares)} 份 / ¥${Number(amount)}` })
      onSaved?.()
    } else {
      setMsg({ ok: false, text: '加仓失败：该基金不在本机持仓里，请先在「持仓」手动录入' })
    }
  }

  if (!held) {
    return (
      <div className="rh-edit quick-form">
        <div className="quick-form-head">
          <b>加仓 {code}</b>
          <small>{name || ''}</small>
        </div>
        <p className="card-note" style={{ marginTop: 0 }}>
          这只基金还没在本机持仓里。请到「持仓」页用「＋ 手动录入」记入份额与成本，之后就能在这里加仓。
        </p>
      </div>
    )
  }

  return (
    <div className="rh-edit quick-form">
      <div className="quick-form-head">
        <b>加仓 {code}</b>
        <small>{name || ''}</small>
      </div>
      <div className="field-row">
        <label className="field">
          <span>新增份额</span>
          <input
            type="number"
            inputMode="decimal"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            placeholder="如 500"
          />
        </label>
        <label className="field">
          <span>本次投入（元）</span>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="如 8000"
          />
        </label>
      </div>
      <div className="goal-form-actions">
        <button className="btn btn-primary" style={{ flex: 1 }} disabled={!valid} onClick={save}>
          确认加仓
        </button>
      </div>
      {msg ? (
        <div className={'callout ' + (msg.ok ? 'teal' : 'danger')} style={{ marginTop: 8 }}>
          {msg.text}
        </div>
      ) : null}
      <p className="card-note" style={{ marginTop: 8 }}>
        按当前净值基准折算：份额 += 新增份额，成本 += 本次投入。只改本机账本。
      </p>
    </div>
  )
}
