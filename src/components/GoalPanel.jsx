// src/components/GoalPanel.jsx · 目标规划（C17 完整版）
// ------------------------------------------------------------
// 多目标（退休 / 教育 / 目标投）+ 目标日期 + 增删改 + 持久化。
// 起始本金可空 = 自动用真实持仓最新市值（与持仓页同口径）。
// 每个目标输出：预计达成 / 达成率 / 缺口或超出 / 若要达成每月需投。
//
// 收益率是用户假设，不是承诺；只做数学推算，不预测市场。

import { useEffect, useState } from 'react'
import { goalReport, goalsWithProjection, upsertGoal, deleteGoal } from '../lib/goal.js'
import { plusYearsStr, todayStr } from '../lib/date.js'

const fmtMoney = (v) =>
  '¥' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })

const emptyForm = () => ({
  id: null,
  name: '',
  target_amount: '',
  target_date: plusYearsStr(5),
  annual_return: '6',
  monthly_saving: '',
  initial_amount: '',
})

export default function GoalPanel({ principal = null }) {
  const [rep, setRep] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true)
    try {
      setRep(
        principal != null ? goalsWithProjection(principal) : await goalReport(),
      )
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load()
    // principal 变化（模拟盘市值刷新）时重算
  }, [principal])

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }))
  const reset = () => {
    setForm(emptyForm())
    setErr('')
  }

  function submit() {
    const name = form.name.trim()
    if (!name) return setErr('请填目标名称')
    if (!(Number(form.target_amount) > 0)) return setErr('目标金额要大于 0')
    if (!form.target_date) return setErr('请选目标日期')

    setErr('')
    const id = upsertGoal({ ...form, id: form.id, name })
    if (!id) return setErr('保存失败：本机存储不可用')
    reset()
    load()
  }

  function edit(g) {
    setForm({
      id: g.id,
      name: g.name,
      target_amount: String(g.target_amount),
      target_date: String(g.target_date).slice(0, 10),
      annual_return: String(g.annual_return),
      monthly_saving: String(g.monthly_saving || ''),
      initial_amount: g.initial_amount == null ? '' : String(g.initial_amount),
    })
    setErr('')
  }

  function remove(id) {
    deleteGoal(id)
    load()
  }

  const goals = rep?.goals || []
  const initial = rep?.initial ?? 0

  return (
    <>
      <div className="section-title">目标规划</div>
      <div className="card">
        <p className="card-note" style={{ marginTop: 0 }}>
          给退休 / 教育 / 某个目标设目标金额与目标日期，按你假设的每年涨幅和每月定投，
          推算到时能攒多少、还差多少。<b>涨幅是你填的假设，不是承诺</b>，只做数学推算。
        </p>

        <div className="goal-principal">
          当前可用本金（真实持仓市值）：<b>{fmtMoney(initial)}</b>
          {initial <= 0 ? '（还没有真实持仓，可在目标里自填起始本金）' : ''}
        </div>

        <div className="goal-form">
          <label className="field">
            <span>目标名称</span>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="退休金 / 教育金"
            />
          </label>
          <label className="field">
            <span>目标金额（元）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.target_amount}
              onChange={(e) => set('target_amount', e.target.value)}
            />
          </label>
          <label className="field">
            <span>目标日期</span>
            <input
              type="date"
              value={form.target_date}
              onChange={(e) => set('target_date', e.target.value)}
            />
          </label>
          <label className="field">
            <span>假设每年涨幅（%）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.annual_return}
              onChange={(e) => set('annual_return', e.target.value)}
            />
          </label>
          <label className="field">
            <span>每月定投（元）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.monthly_saving}
              onChange={(e) => set('monthly_saving', e.target.value)}
            />
          </label>
          <label className="field">
            <span>起始本金（可空=用持仓）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.initial_amount}
              onChange={(e) => set('initial_amount', e.target.value)}
            />
          </label>
        </div>

        <div className="goal-form-actions">
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={submit} disabled={busy}>
            {form.id ? '保存修改' : '添加目标'}
          </button>
          {form.id ? (
            <button className="btn" onClick={reset} disabled={busy}>
              取消
            </button>
          ) : null}
        </div>

        {err ? (
          <div className="callout danger" style={{ marginTop: 'var(--space-3)' }}>
            {err}
          </div>
        ) : null}
      </div>

      <div className="section-title">我的目标（{goals.length}）</div>
      <div className="card">
        {goals.length === 0 ? (
          <p className="card-note" style={{ marginTop: 0 }}>
            还没有目标，上面填一个添加。
          </p>
        ) : (
          goals.map((g) => {
            const p = g.projection
            return (
              <div className="goal-item" key={g.id}>
                <div className="goal-item-head">
                  <strong>{g.name}</strong>
                  {p.on_track ? (
                    <span className="goal-ok">✓ 可达标</span>
                  ) : (
                    <span className="goal-bad">⚠ 有缺口</span>
                  )}
                </div>
                <div className="goal-item-meta">
                  目标 {fmtMoney(g.target_amount)} · {g.target_date}（还剩 {p.months} 个月）
                </div>
                <div className="goal-item-meta">
                  假设年化 {g.annual_return}% · 每月定投 {fmtMoney(g.monthly_saving)}
                  {g.initial_amount == null
                    ? ' · 本金用当前持仓'
                    : ` · 起始本金 ${fmtMoney(g.initial_amount)}`}
                </div>
                <div className="goal-item-nums">
                  预计达成 <b>{fmtMoney(p.future_value)}</b>（{p.achievement_pct}%）
                  {p.on_track ? (
                    <span className="down"> · 超出 {fmtMoney(-p.gap)}</span>
                  ) : (
                    <span className="up"> · 缺口 {fmtMoney(p.gap)}</span>
                  )}
                </div>
                {!p.on_track ? (
                  <div className="goal-item-nums">
                    若要达成，每月需投 <b>{fmtMoney(p.required_monthly)}</b>
                  </div>
                ) : null}
                <div className="goal-actions">
                  <button className="btn btn-sm" onClick={() => edit(g)} disabled={busy}>
                    编辑
                  </button>
                  <button className="btn btn-sm" onClick={() => remove(g.id)} disabled={busy}>
                    删除
                  </button>
                </div>
              </div>
            )
          })
        )}
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          月复利折算（年化 ÷ 12）；目标日期按整月计。收益率仅为假设，不构成收益承诺。
        </p>
      </div>
    </>
  )
}
