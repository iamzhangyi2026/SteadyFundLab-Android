// src/components/DingtouPlanPanel.jsx · 定投计划（完整版）
// ------------------------------------------------------------
// 计划管理：新增 / 编辑 / 暂停 / 恢复 / 删除。
// 每个计划显示：每期金额、频率、扣款日、下次扣款、已投期数、累计投入。
// ⚠️ 只做计划与提醒，不自动扣款（App 没有交易通道）。

import { useEffect, useState } from 'react'
import {
  loadPlans,
  upsertPlan,
  deletePlan,
  togglePlan,
  planStats,
  WEEKDAYS,
  FREQ_LABEL,
  loadAutoApply,
  saveAutoApply,
} from '../lib/dingtou_plan.js'

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const emptyForm = () => ({
  id: null,
  code: '',
  name: '',
  amount: '',
  frequency: 'monthly',
  weekday: '1',
  day_of_month: '1',
  start_date: today(),
})

export default function DingtouPlanPanel() {
  const [plans, setPlans] = useState(() => loadPlans())
  const [form, setForm] = useState(emptyForm)
  const [err, setErr] = useState('')
  const [auto, setAuto] = useState(() => loadAutoApply())

  function reload() {
    setPlans(loadPlans())
  }

  useEffect(() => {
    reload()
  }, [])

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }))
  const reset = () => {
    setForm(emptyForm())
    setErr('')
  }

  function submit() {
    const code = form.code.trim()
    if (!code) return setErr('请填基金代码')
    if (!(Number(form.amount) > 0)) return setErr('每期金额要大于 0')
    setErr('')
    const id = upsertPlan({ ...form, id: form.id, code })
    if (!id) return setErr('保存失败：本机存储不可用')
    reset()
    reload()
  }

  function edit(p) {
    setForm({
      id: p.id,
      code: p.code,
      name: p.name || '',
      amount: String(p.amount),
      frequency: p.frequency,
      weekday: String(p.weekday),
      day_of_month: String(p.day_of_month),
      start_date: p.start_date || today(),
    })
    setErr('')
  }

  function remove(p) {
    if (!window.confirm(`删除定投计划「${p.name || p.code}」？`)) return
    deletePlan(p.id)
    reload()
  }

  function toggle(p) {
    togglePlan(p.id)
    reload()
  }

  return (
    <>
      <div className="section-title">定投计划</div>
      <div className="card">
        <div className="fund-row fund-row-static fund-row-noline">
          <div className="fund-main">
            <div className="fund-name fund-name-normal">到期自动追加到持仓</div>
            <div className="fund-meta">打开 App 时把已到期未投的期数按最新净值折算份额，写进本机持仓</div>
          </div>
          <button
            className={auto.enabled ? 'switch on' : 'switch'}
            onClick={() => setAuto(saveAutoApply({ enabled: !auto.enabled }))}
            aria-label="到期自动追加"
          />
        </div>
        <p className="card-note" style={{ marginTop: 0 }}>
          只改 App 里的本机记录，<b>不发起任何真实交易</b>。只对已在持仓里的基金追加；
          补投按当前净值折算份额。关掉开关则只提醒、不动账本。
        </p>

        <div className="goal-form">
          <label className="field">
            <span>基金代码</span>
            <input value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="如 040001" />
          </label>
          <label className="field">
            <span>基金名称（可空）</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="易方达蓝筹精选" />
          </label>
          <label className="field">
            <span>每期金额（元）</span>
            <input
              type="number"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => set('amount', e.target.value)}
            />
          </label>
          <label className="field">
            <span>频率</span>
            <select value={form.frequency} onChange={(e) => set('frequency', e.target.value)}>
              <option value="weekly">每周</option>
              <option value="biweekly">每两周</option>
              <option value="monthly">每月</option>
            </select>
          </label>
          {form.frequency === 'monthly' ? (
            <label className="field">
              <span>每月几号（1–28）</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="28"
                value={form.day_of_month}
                onChange={(e) => set('day_of_month', e.target.value)}
              />
            </label>
          ) : (
            <label className="field">
              <span>每周几</span>
              <select value={form.weekday} onChange={(e) => set('weekday', e.target.value)}>
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>开始日期</span>
            <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
          </label>
        </div>

        <div className="goal-form-actions">
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={submit}>
            {form.id ? '保存修改' : '添加计划'}
          </button>
          {form.id ? (
            <button className="btn" onClick={reset}>
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

      <div className="section-title">我的计划（{plans.length}）</div>
      <div className="card">
        {plans.length === 0 ? (
          <p className="card-note" style={{ marginTop: 0 }}>
            还没有定投计划，上面填一个添加。
          </p>
        ) : (
          plans.map((p) => {
            const s = planStats(p)
            return (
              <div className="goal-item" key={p.id}>
                <div className="goal-item-head">
                  <strong>
                    {p.name || p.code}
                    {p.enabled ? '' : <span className="dt-paused"> · 已暂停</span>}
                  </strong>
                  <span className={s.due ? 'goal-bad' : 'goal-item-meta'}>
                    {s.due ? '今天该投' : `下次 ${s.nextDate}`}
                  </span>
                </div>
                <div className="goal-item-meta">
                  每期 ¥{p.amount} · {FREQ_LABEL[p.frequency]}
                  {p.frequency === 'monthly' ? ` ${p.day_of_month} 号` : ` ${WEEKDAYS[p.weekday]}`}
                  {' · '}
                  <span className="fund-code">{p.code}</span>
                </div>
                <div className="goal-item-nums">
                  已投 <b>{s.periods}</b> 期 · 累计投入 <b>¥{s.invested.toLocaleString('zh-CN')}</b>
                </div>
                {p.auto_applied_periods > 0 ? (
                  <div className="goal-item-meta">
                    已自动追加 {p.auto_applied_periods} 期
                    {p.last_auto_at ? ` · 最近 ${p.last_auto_at.slice(0, 10)}` : ''}
                  </div>
                ) : null}
                <div className="goal-actions">
                  <button className="btn btn-sm" onClick={() => toggle(p)}>
                    {p.enabled ? '暂停' : '恢复'}
                  </button>
                  <button className="btn btn-sm" onClick={() => edit(p)}>
                    编辑
                  </button>
                  <button className="btn btn-sm" onClick={() => remove(p)}>
                    删除
                  </button>
                </div>
              </div>
            )
          })
        )}
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          已投期数按「开始日期到今天的扣款日」计算；暂停期间不累计。到期提醒每期只发一次。
        </p>
      </div>
    </>
  )
}
