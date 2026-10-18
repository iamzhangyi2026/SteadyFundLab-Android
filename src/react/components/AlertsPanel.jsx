// AlertsPanel.jsx · 涨跌 / 净值预警提醒二级页
//
// 用户给基金设阈值（日涨跌% / 单位净值高低），App 打开或刷新净值后自动评估；
// 命中且过 24h 冷却 → 记触发记录（本地通知由 evaluate 阶段触发）。
// 触发值口径诚实稳健：日涨跌用 nav_daily 最近两行；净值用最新一行；数据不足跳过，不造假。

import { useState, useEffect, useCallback } from 'react'
import { fetchAlerts, fetchAlertHistory, jsAddAlert, jsDeleteAlert, jsEvaluateAlerts, clearAlertHistory, ALERT_KIND_META } from '../lib/dataAdapter'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'
import ConfirmDialog from './ConfirmDialog'

const KINDS = [
  { key: 'pct_down',  label: '一天跌够', unit: '%', hint: '今天的净值比昨天跌得够多，就提醒你' },
  { key: 'pct_up',    label: '一天涨够', unit: '%', hint: '今天的净值比昨天涨得够多，就提醒你' },
  { key: 'nav_below', label: '每份净值跌破', unit: '',  hint: '最新每份净值低于这个数，就提醒你' },
  { key: 'nav_above', label: '每份净值涨过', unit: '',  hint: '最新每份净值高于这个数，就提醒你' },
]

const fmtVal = (a, v) => (a.kind.startsWith('nav') ? Number(v).toFixed(4) : Number(v).toFixed(2) + '%')

function kindLabel(kind) { return ALERT_KIND_META?.[kind]?.label || kind }

export default function AlertsPanel() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [alerts, setAlerts] = useState([])
  const [history, setHistory] = useState([])
  const [evalMsg, setEvalMsg] = useState('')
  const [confirmClear, setConfirmClear] = useState(false) // 清空触发记录二次确认

  // 表单
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState('pct_down')
  const [threshold, setThreshold] = useState('')

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const a = await fetchAlerts()
      const h = await fetchAlertHistory()
      if (!a.ok) { setErr(a.error || '加载失败'); return }
      setAlerts(a.data || [])
      setHistory((h.ok ? h.data : []) || [])
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { load() }, [load])
  // 下拉刷新
  useEffect(() => registerPullRefresh(load), [load])

  const add = async () => {
    const fundCode = code.trim()
    if (!fundCode) { setErr('请填写基金代码'); return }
    const th = Number(threshold)
    if (!Number.isFinite(th) || th === 0) { setErr('提醒值必须填一个非零数字'); return }
    setBusy(true); setErr('')
    try {
      const r = await jsAddAlert({
        fund_code: fundCode,
        fund_name: name.trim() || null,
        kind,
        threshold: th,
      })
      if (!r.ok) { setErr(r.error || '添加失败'); return }
      if (r.ok && r.data == null) { setErr('该基金已有相同预警，未重复添加') }
      else { setCode(''); setName(''); setThreshold('') }
      await load()
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }

  const remove = async (id) => {
    setBusy(true)
    try { await jsDeleteAlert(id); await load() } catch (e) { setErr(e?.message || String(e)) } finally { setBusy(false) }
  }

  const evaluate = async () => {
    setBusy(true); setEvalMsg(''); setErr('')
    try {
      const r = await jsEvaluateAlerts()
      if (!r.ok) { setErr(r.error || '评估失败'); return }
      const n = (r.data || []).length
      setEvalMsg(n > 0
        ? `已评估：本次触发 ${n} 条预警（已记录并通知）`
        : '已评估：当前没有预警被触发')
      await load()
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }

  const k = KINDS.find(x => x.key === kind)

  return (
    <div>
      <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 14 }}>
        给基金设<b>涨跌提醒</b>或<b>净值高低提醒</b>，到条件就通知你（同一条件 24 小时内只提醒一次）。
      </div>

      {/* 添加表单 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead">新增预警</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <input
            className="inp" style={{ flex: '1 1 110px', minWidth: 110 }}
            placeholder="基金代码（如 000001）" value={code}
            onChange={e => setCode(e.target.value)} inputMode="numeric" />
          <input
            className="inp" style={{ flex: '1 1 110px', minWidth: 110 }}
            placeholder="基金名称（可空）" value={name}
            onChange={e => setName(e.target.value)} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <select className="inp" style={{ flex: '1 1 150px', minWidth: 150 }} value={kind} onChange={e => setKind(e.target.value)}>
            {KINDS.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          {k && <span className="muted cell-note" style={{ flex: '1 1 160px' }}>{k.hint}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: '1 1 120px' }}>
            <input
              className="inp" style={{ flex: 1, minWidth: 90 }}
              placeholder={`提醒值${k?.unit ? '（' + k.unit + '）' : ''}`} value={threshold}
              onChange={e => setThreshold(e.target.value)} onBlur={e => setThreshold(e.target.value)} inputMode="decimal" />
            {k?.unit ? <b style={{ minWidth: 14, textAlign: 'left' }}>{k.unit}</b> : null}
          </span>
          <button className="btn btn-primary" style={{ flex: '0 0 auto' }} disabled={busy} onClick={add}>添加</button>
        </div>
      </div>

      {err && <div className="text-danger cell-note" style={{ marginBottom: 10 }}>⚠ {err}</div>}

      {/* 当前预警列表 */}
      <div className="sub-card" style={{ marginBottom: 14, padding: 14 }}>
        <div className="subhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>我的预警（{alerts.length}）</span>
          <button className="btn-tiny" disabled={busy} onClick={evaluate}>立即评估</button>
        </div>
        {alerts.length === 0 ? (
          <div className="muted cell-note" style={{ marginTop: 8 }}>还没有预警。上面填一只基金、选个条件、填提醒值，点「添加」。每天打开应用会自动检查，不用手动。</div>
        ) : (
          <div style={{ marginTop: 8 }}>
            {alerts.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,.06)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    {a.fund_name || a.fund_code} <span className="muted cell-note">{a.fund_code}</span>
                  </div>
                  <div className="muted cell-note">
                    {kindLabel(a.kind)} {a.threshold}{(KINDS.find(x => x.key === a.kind)?.unit) || ''}
                    {a.enabled !== 0 ? '' : ' · 已关闭'} · 触发 {a.trigger_count} 次
                  </div>
                </div>
                <button className="btn-tiny text-danger" disabled={busy} onClick={() => remove(a.id)}>删除</button>
              </div>
            ))}
          </div>
        )}
        {evalMsg && <div className="cell-note" style={{ marginTop: 8, color: 'var(--down)' }}>{evalMsg}</div>}
      </div>

      {/* 触发记录 */}
      <div className="sub-card" style={{ padding: 14 }}>
        <div className="subhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>触发记录（{history.length}）</span>
          {history.length > 0 && (
            <button className="btn-tiny text-danger" disabled={busy} onClick={() => setConfirmClear(true)}>清空</button>
          )}
        </div>
        {history.length === 0 ? (
          <div className="muted cell-note" style={{ marginTop: 8 }}>还没有触发记录。条件达到后会出现在这里，并弹出系统通知。</div>
        ) : (
          <div style={{ marginTop: 8 }}>
            {history.map(h => (
              <div key={h.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,.06)' }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  {h.fund_name || h.fund_code} <span className="muted cell-note">{h.fund_code}</span>
                </div>
                <div className="muted cell-note">
                  {kindLabel(h.kind)} {h.threshold}{(KINDS.find(x => x.key === h.kind)?.unit) || ''}
                  {' → '}当前 {fmtVal(h, h.triggered_value)} · {h.triggered_at?.slice(0, 16)?.replace('T', ' ')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 清空触发记录二次确认（仅清记录，不动预警规则） */}
      <ConfirmDialog
        open={confirmClear}
        danger
        title="清空触发记录"
        message="确定清空所有预警触发记录吗？\n该操作不可撤销（预警规则本身不受影响）。"
        confirmText="清空"
        onConfirm={async () => { await clearAlertHistory(); await load() }}
        onClose={() => setConfirmClear(false)}
      />
    </div>
  )
}
