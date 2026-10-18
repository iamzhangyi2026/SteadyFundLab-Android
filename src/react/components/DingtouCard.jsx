// DingtouCard.jsx · 定投计划卡片
//   · 「我的 → 定投计划」与「交易 → 定投」两处指向同一个组件，不重复实现。
//   · 含 G2「收益模拟」折叠区（纯公式，无外部依赖）。
//
// 定投金额用户自设、无上限；唯一真实约束 = 该基金起购金额（min_purchase，查不到不兜 1）。
//       余额不足 / 基金暂停申购 → 本期跳过 + 留痕，协议不变。
import { useState, useEffect, useCallback } from 'react'
import Card from './Card'
import ConfirmDialog from './ConfirmDialog'
import { money } from '../lib/format'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'
import { useStore } from '../store/useStore'
import {
  fetchWatchlist,
  fetchPositions,
  jsDingtouList,
  jsDingtouUpsert,
  jsDingtouToggle,
  jsDingtouDelete,
  jsRunDingtou,
} from '../lib/dataAdapter'

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五']

// ─── G2 定投收益模拟（纯公式，无外部数据依赖）──────────────────────
//   口径：每期**期初**投入 X，期利率 r = 年化 / 每年期数（周投 52 / 月投 12）。
//   期末总额 = X·((1+r)^N − 1)/r·(1+r)（期初付年金终值）；r=0 时退化为 X·N。
//   不含申购费、不含净值波动 —— 只是量级参考，不是承诺。
function simulate(amount, frequency, periods, annualPct) {
  const X = Number(amount)
  const N = Math.max(0, Math.floor(Number(periods)))
  const R = Number(annualPct)
  if (!Number.isFinite(X) || X <= 0 || !Number.isFinite(N) || N <= 0) return null
  const ppy = frequency === 'monthly' ? 12 : 52
  const r = Number.isFinite(R) ? R / 100 / ppy : 0
  const invested = X * N
  const fv = r === 0 ? invested : X * ((Math.pow(1 + r, N) - 1) / r) * (1 + r)
  return { invested, fv, profit: fv - invested, ppy }
}

function DingtouSim() {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ amount: '1000', frequency: 'monthly', periods: '36', annualPct: '6' })
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const sim = simulate(form.amount, form.frequency, form.periods, form.annualPct)
  const years = sim ? (Number(form.periods) / sim.ppy) : 0

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o) } }}
      >
        <div style={{ fontWeight: 700, fontSize: 14 }}>收益模拟</div>
        <span className="muted cell-note">{open ? '收起 ▲' : '展开 ▼'}</span>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          <div className="muted cell-note" style={{ lineHeight: 1.7, marginBottom: 10 }}>
            算的是「<b>每期投多少、投多少期，到期大概能变成多少</b>」。按固定年化复利推算，
            <b>不含申购费、不含净值波动</b>，只是量级参考，不是承诺收益。
          </div>

          <div className="dt-form">
            <div className="field">
              <label>每期金额（元）</label>
              <input type="number" value={form.amount} onChange={set('amount')} onBlur={set('amount')} />
            </div>
            <div className="field">
              <label>频率</label>
              <select value={form.frequency} onChange={set('frequency')}>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
              </select>
            </div>
            <div className="field">
              <label>投多少期</label>
              <input type="number" value={form.periods} onChange={set('periods')} onBlur={set('periods')} />
            </div>
            <div className="field">
              <label>预期每年涨（%）</label>
              <input type="number" value={form.annualPct} onChange={set('annualPct')} onBlur={set('annualPct')} />
            </div>
          </div>

          {!sim ? (
            <div className="muted cell-note">请填写大于 0 的每期金额与期数。</div>
          ) : (
            <div className="dt-sim-out">
              <div className="dt-sim-row"><span>总投入</span><b>{money(sim.invested)}</b></div>
              <div className="dt-sim-row"><span>期末总额（推算）</span><b>{money(sim.fv)}</b></div>
              <div className="dt-sim-row">
                <span>净收益（推算）</span>
                <b className={sim.profit >= 0 ? 'pos' : 'neg'}>
                  {sim.profit >= 0 ? '+' : ''}{money(sim.profit)}
                </b>
              </div>
              <div className="muted cell-note" style={{ marginTop: 6 }}>
                约 {years.toFixed(1)} 年 · 共 {Number(form.periods) || 0} 期 · 按{form.frequency === 'monthly' ? '每月' : '每周'}投入
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function DingtouCard() {
  const notify = useStore((s) => s.notify)
  const [plans, setPlans] = useState([])
  const [candidates, setCandidates] = useState([])
  const [form, setForm] = useState({ fund_code: '', amount: '100', frequency: 'weekly', weekday: '0', day_of_month: '1' })
  const [busy, setBusy] = useState(false)
  const [delConfirm, setDelConfirm] = useState(null)

  const load = useCallback(async () => {
    const [p, w, pos] = await Promise.all([jsDingtouList(), fetchWatchlist(), fetchPositions()])
    if (p.ok) setPlans(p.data ?? [])
    const cand = []
    for (const f of (pos.ok ? pos.data : [])) cand.push({ code: f.fund_code, name: f.fund_name, min_purchase: f.min_purchase ?? null })
    for (const f of (w.ok ? w.data : [])) if (!cand.some(c => c.code === f.fund_code)) cand.push({ code: f.fund_code, name: f.fund_name, min_purchase: f.min_purchase ?? null })
    setCandidates(cand)
  }, [])
  useEffect(() => {
    load()
    const timers = [4000, 15000, 30000].map(ms => setTimeout(load, ms))
    const hasWin = typeof window !== 'undefined'
    if (hasWin) window.addEventListener('fundapp:cycle-done', load)
    return () => { timers.forEach(clearTimeout); if (hasWin) window.removeEventListener('fundapp:cycle-done', load) }
  }, [load])
  // 下拉刷新
  useEffect(() => registerPullRefresh(load), [load])

  const add = async () => {
    if (!form.fund_code) { notify('请选择基金', 'error'); return }
    const amt = Number(form.amount)
    if (!amt || amt <= 0) { notify('请输入正确的每期金额', 'error'); return }
    // 定投金额无上限；唯一保留的真实约束 = 该基金的起购金额
    const cand = candidates.find(c => c.code === form.fund_code)
    if (cand?.min_purchase && amt < Number(cand.min_purchase)) {
      notify(`低于该基金起购 ${Number(cand.min_purchase)} 元`, 'error'); return
    }
    setBusy(true)
    try {
      const r = await jsDingtouUpsert({
        fund_code: form.fund_code,
        fund_name: cand?.name || null,
        amount: amt,
        frequency: form.frequency,
        weekday: Number(form.weekday),
        day_of_month: Number(form.day_of_month),
        enabled: 1,
      })
      if (!r.ok) { notify(`保存失败：${r.error}`, 'error'); return }
      notify('定投协议已保存，到扣款日自动执行', 'success')
      await load()
    } finally { setBusy(false) }
  }

  const toggle = async (p) => {
    const r = await jsDingtouToggle(p.id, !p.enabled)
    if (!r.ok) { notify(`操作失败：${r.error}`, 'error'); return }
    notify(p.enabled ? '定投已暂停' : '定投已恢复', 'success')
    await load()
  }

  const confirmDel = async () => {
    const p = delConfirm
    setDelConfirm(null)
    const r = await jsDingtouDelete(p.id)
    if (!r.ok) { notify(`终止失败：${r.error}`, 'error'); return }
    notify('已终止定投协议', 'success')
    await load()
  }

  const runNow = async () => {
    setBusy(true)
    try {
      const r = await jsRunDingtou()
      if (!r.ok) { notify(`执行失败：${r.error}`, 'error'); return }
      const d = r.data
      notify(
        `定投执行：到期 ${d.due} 只，下单 ${d.placed}${d.failed ? `，失败 ${d.failed}` : ''}`,
        d.failed ? 'warning' : 'success',
      )
      await load()
    } finally { setBusy(false) }
  }

  return (
    <Card className="wide" title="定投计划">
      <div className="muted cell-note" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        定投 = 你签一份协议：哪只基金、每期多少钱、什么频率，金额自己定、<b>无上限</b>。
        到扣款日自动下单（周末、节假日顺延）；余额不足时本期跳过。
      </div>
      {plans.length === 0 ? (
        <div className="muted cell-note">暂无定投协议，在下方签一份：</div>
      ) : (
        plans.map(p => (
          <div className="dt-plan-row" key={p.id}>
            <div className="dt-plan-info">
              <div className="dt-plan-name">
                {p.fund_name || p.fund_code} <span className="muted cell-note">{p.fund_code}</span>
              </div>
              <div className="dt-plan-meta">
                每期 ¥{p.amount} · {p.frequency === 'monthly' ? `每月 ${p.day_of_month} 号` : `每${WEEKDAYS[p.weekday] || '周一'}`}
                {p.enabled ? '' : ' · 已暂停'}
                {p.last_invested_period ? ' · 本期已投' : ' · 待扣'}
              </div>
              {p.last_result && (
                <div className="dt-plan-meta" style={{ color: 'var(--warn)' }}>{p.last_result}</div>
              )}
            </div>
            <div className="dt-plan-actions">
              <button className="btn btn-sm" onClick={() => toggle(p)}>{p.enabled ? '暂停' : '恢复'}</button>
              <button className="btn btn-sm btn-danger" onClick={() => setDelConfirm(p)}>终止</button>
            </div>
          </div>
        ))
      )}

      <div className="dt-form">
        <div className="field full">
          <label>基金</label>
          <select value={form.fund_code} onChange={e => setForm(f => ({ ...f, fund_code: e.target.value }))}>
            <option value="">选择基金（持仓 / 关注）</option>
            {candidates.map(c => <option key={c.code} value={c.code}>{c.name || c.code}（{c.code}）</option>)}
          </select>
        </div>
        <div className="field">
          <label>每期金额（元）</label>
          <input type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} onBlur={e => setForm(f => ({ ...f, amount: e.target.value }))} />
        </div>
        <div className="field">
          <label>频率</label>
          <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
          </select>
        </div>
        {form.frequency === 'weekly' ? (
          <div className="field">
            <label>星期</label>
            <select value={form.weekday} onChange={e => setForm(f => ({ ...f, weekday: e.target.value }))}>
              {WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}</option>)}
            </select>
          </div>
        ) : (
          <div className="field">
            <label>每月几号</label>
            <select value={form.day_of_month} onChange={e => setForm(f => ({ ...f, day_of_month: e.target.value }))}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d} 号</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="set-actions">
        <button className="btn-primary" style={{ flex: 1 }} disabled={busy} onClick={add}>保存计划</button>
        <button className="btn" disabled={busy} onClick={runNow} title="手动执行一次到期定投（幂等）">立即执行</button>
      </div>

      {/* G2 收益模拟（纯公式） */}
      <DingtouSim />

      <ConfirmDialog
        open={!!delConfirm}
        danger
        title="终止定投协议"
        message={delConfirm ? `终止后「${delConfirm.fund_name || delConfirm.fund_code}」不再自动扣款，已持仓份额不受影响。确认终止？` : ''}
        confirmText="终止"
        onConfirm={confirmDel}
        onClose={() => setDelConfirm(null)}
      />
    </Card>
  )
}
