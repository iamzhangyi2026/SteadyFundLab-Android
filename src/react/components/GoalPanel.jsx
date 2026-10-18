// GoalPanel.jsx · 目标规划二级页（退休 / 教育 / 目标投）
//
// 用户设目标金额 + 目标日期 + 预期年化（假设）+ 每月定投；基于当前本金
// （真实持仓市值，或自填起始本金）按复利估算到目标日的达成额，算缺口 /
// 达成率 / 若要达成每月需投多少。收益率是用户假设，不是承诺。

import { useState, useEffect, useCallback } from 'react'
import { jsGoalReport, jsGoalUpsert, jsGoalDelete } from '../lib/dataAdapter'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'

const fmtMoney = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
const plusYears = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() + n); return d.toISOString().slice(0, 10) }
const emptyForm = () => ({
  id: null, name: '', target_amount: '', target_date: plusYears(5),
  annual_return: '6', monthly_saving: '', initial_amount: '',
})

export default function GoalPanel() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [rep, setRep] = useState(null)
  const [form, setForm] = useState(emptyForm())

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const r = await jsGoalReport()
      if (!r.ok) { setErr(r.error || '加载失败'); return }
      setRep(r.data)
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { load() }, [load])
  // 下拉刷新
  useEffect(() => registerPullRefresh(load), [load])

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }))
  const reset = () => setForm(emptyForm())

  const submit = async () => {
    const name = form.name.trim()
    const ta = Number(form.target_amount)
    if (!name) { setErr('请填目标名称'); return }
    if (!(ta > 0)) { setErr('目标金额要大于 0'); return }
    if (!form.target_date) { setErr('请选目标日期'); return }
    setBusy(true); setErr('')
    try {
      const r = await jsGoalUpsert({
        id: form.id,
        name,
        target_amount: ta,
        target_date: form.target_date,
        annual_return: Number(form.annual_return) || 0,
        monthly_saving: Number(form.monthly_saving) || 0,
        initial_amount: form.initial_amount === '' ? null : Number(form.initial_amount),
      })
      if (!r.ok) { setErr(r.error || '保存失败'); return }
      reset(); await load()
    } catch (e) { setErr(e?.message || String(e)) } finally { setBusy(false) }
  }

  const edit = (g) => {
    setForm({
      id: g.id, name: g.name, target_amount: String(g.target_amount),
      target_date: String(g.target_date).slice(0, 10), annual_return: String(g.annual_return),
      monthly_saving: String(g.monthly_saving || ''), initial_amount: g.initial_amount == null ? '' : String(g.initial_amount),
    })
    setErr('')
  }

  const remove = async (id) => {
    setBusy(true); setErr('')
    try { await jsGoalDelete(id); await load() }
    catch (e) { setErr(e?.message || String(e)) } finally { setBusy(false) }
  }

  const goals = rep?.goals || []
  const initial = rep?.initial ?? 0

  return (
    <div>
      <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 14 }}>
        给退休 / 教育 / 某个目标设一个<b>目标金额</b>和<b>目标日期</b>，按你假设的<b>每年涨幅</b>
        和<b>每月定投</b>推算到时能攒多少、还差多少。<b>涨幅是你填的假设，不是承诺</b>，只做数学推算。
      </div>

      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="muted cell-note">
          当前可用本金（真实持仓市值）：<b>{fmtMoney(initial)}</b>
          {initial <= 0 ? '（还没有真实持仓，可在下方目标里自填「起始本金」）' : ''}
        </div>
      </div>

      {/* 新增 / 编辑表单 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead">{form.id ? '编辑目标' : '新增目标'}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <input className="inp" style={{ flex: '1 1 150px', minWidth: 150 }}
            placeholder="目标名称（如 退休金 / 教育金）" value={form.name}
            onChange={e => set('name', e.target.value)} />
          <input className="inp" style={{ flex: '1 1 120px', minWidth: 120 }}
            placeholder="目标金额（元）" inputMode="decimal" value={form.target_amount}
            onChange={e => set('target_amount', e.target.value)} onBlur={e => set('target_amount', e.target.value)} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <input className="inp" style={{ flex: '1 1 140px', minWidth: 140 }} type="date"
            value={form.target_date} onChange={e => set('target_date', e.target.value)} />
          <input className="inp" style={{ flex: '1 1 110px', minWidth: 110 }}
            placeholder="每年涨 %（假设）" inputMode="decimal" value={form.annual_return}
            onChange={e => set('annual_return', e.target.value)} onBlur={e => set('annual_return', e.target.value)} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <input className="inp" style={{ flex: '1 1 130px', minWidth: 130 }}
            placeholder="每月定投（元）" inputMode="decimal" value={form.monthly_saving}
            onChange={e => set('monthly_saving', e.target.value)} onBlur={e => set('monthly_saving', e.target.value)} />
          <input className="inp" style={{ flex: '1 1 130px', minWidth: 130 }}
            placeholder="起始本金（可空）" inputMode="decimal" value={form.initial_amount}
            onChange={e => set('initial_amount', e.target.value)} onBlur={e => set('initial_amount', e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={busy} onClick={submit}>
            {form.id ? '保存修改' : '添加目标'}
          </button>
          {form.id ? <button className="btn-tiny" disabled={busy} onClick={reset}>取消</button> : null}
        </div>
      </div>

      {err && <div className="text-danger cell-note" style={{ marginBottom: 10 }}>⚠ {err}</div>}

      {/* 目标列表 */}
      <div className="sub-card" style={{ padding: 14 }}>
        <div className="subhead">我的目标（{goals.length}）</div>
        {goals.length === 0 ? (
          <div className="muted cell-note" style={{ marginTop: 8 }}>还没有目标，上面填一个添加。</div>
        ) : (
          <div style={{ marginTop: 8 }}>
            {goals.map(g => {
              const p = g.projection
              return (
                <div key={g.id} style={{ padding: '10px 0', borderBottom: '1px solid rgba(0,0,0,.06)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{g.name}</div>
                    {p.on_track
                      ? <span style={{ color: 'var(--down)', fontWeight: 600, fontSize: 13 }}>✓ 可达标</span>
                      : <span style={{ color: 'var(--danger)', fontWeight: 600, fontSize: 13 }}>⚠ 有缺口</span>}
                  </div>
                  <div className="muted cell-note" style={{ marginTop: 4 }}>
                    目标 {fmtMoney(g.target_amount)} · {String(g.target_date).slice(0, 10)}（还剩 {p.months} 个月）
                  </div>
                  <div className="muted cell-note">
                    假设年化 {g.annual_return}% · 每月定投 {fmtMoney(g.monthly_saving)}
                    {g.initial_amount == null ? ' · 本金用当前持仓' : ` · 起始本金 ${fmtMoney(g.initial_amount)}`}
                  </div>
                  <div className="cell-note" style={{ marginTop: 6 }}>
                    预计达成 <b>{fmtMoney(p.future_value)}</b>（{p.achievement_pct}%）
                    {p.on_track
                      ? <span style={{ color: 'var(--down)' }}> · 超出 {fmtMoney(-p.gap)}</span>
                      : <span style={{ color: 'var(--danger)' }}> · 缺口 {fmtMoney(p.gap)}</span>}
                  </div>
                  {!p.on_track && (
                    <div className="cell-note" style={{ marginTop: 2 }}>
                      若要达成，每月需投 <b>{fmtMoney(p.required_monthly)}</b>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button className="btn-tiny" disabled={busy} onClick={() => edit(g)}>编辑</button>
                    <button className="btn-tiny text-danger" disabled={busy} onClick={() => remove(g.id)}>删除</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
