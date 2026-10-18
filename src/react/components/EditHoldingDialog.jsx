import { useEffect, useState } from 'react'
import Modal from './Modal'
import { useStore } from '../store/useStore'
import { updateRealHolding } from '../lib/dataAdapter'

// 真实持仓手工纠错：OCR 读错时，用户在持仓页手动改 基金代码 / 份额 / 成本 / 买入日期。
// 只改 `source='real' AND buy_order_id LIKE 'ocr-import-%'` 批次，不碰交易盘、不碰其它来源（隔离不变）。
export default function EditHoldingDialog({ open, position, onClose, onSaved }) {
  const notify = useStore((s) => s.notify)
  const [code, setCode] = useState('')
  const [shares, setShares] = useState('')
  const [cost, setCost] = useState('')
  const [buyDate, setBuyDate] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次打开用当前持仓值回填（读错的字段改掉即可，未读错的不动）
  useEffect(() => {
    if (!open || !position) return
    setCode(position.fund_code || '')
    // 缺字段按 0 落库的行，回填留空（提示用户补全），不显示刺眼的「0」
    setShares(position.total_shares > 0 ? String(position.total_shares) : '')
    setCost(position.total_cost > 0 ? String(position.total_cost) : '')
    setBuyDate(
      position.lots && position.lots[0]?.buy_date
        ? String(position.lots[0].buy_date).slice(0, 10)
        : '',
    )
    setBusy(false)
  }, [open, position])

  const handleSave = async () => {
    if (!position) return
    setBusy(true)
    const r = await updateRealHolding(position.fund_code, {
      fund_code: code.trim(),
      shares,
      cost_amount: cost,
      buy_date: buyDate.trim(),
    })
    setBusy(false)
    if (!r.ok) { notify(r.error || '保存失败', 'error'); return }
    notify('已保存修改', 'success')
    onSaved?.()
    onClose?.()
  }

  if (!open) return null
  return (
    <Modal open={open} title="修改真实持仓" onClose={onClose} width={420}>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-soft)', lineHeight: 1.55 }}>
        这里改的是截图导入的持仓，哪个数字不对就改哪个。
      </p>
      {(position?.total_shares === 0 || position?.total_cost === 0) && (
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--warn)', lineHeight: 1.55 }}>
          ⚠ 该行导入时缺字段（份额或成本金额），请补全后再保存。
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label>基金代码（6 位）</label>
          <input
            className="inp"
            value={code}
            inputMode="numeric"
            maxLength={6}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="muted cell-note" style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5 }}>6 位数字，如 008888</div>
        </div>
        <div className="field">
          <label>持有份额（份）</label>
          <input
            className="inp"
            type="number"
            inputMode="decimal"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
          />
          <div className="muted cell-note" style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5 }}>支付宝 / 天天基金「持有份额」那一栏的数字</div>
        </div>
        <div className="field">
          <label>买入总成本（元，含手续费）</label>
          <input
            className="inp"
            type="number"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
          <div className="muted cell-note" style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5 }}>
            为这只基金<b>一共花了多少钱</b>（不是每份的单价）。例：花 1000 元买它 → 填 1000；若只知道每份成本 1.80 元、持有 346 份 → 填 1.80×346≈622.8。
          </div>
        </div>
        <div className="field">
          <label>买入日期</label>
          <input
            className="inp"
            type="date"
            value={buyDate}
            onChange={(e) => setBuyDate(e.target.value)}
          />
          <div className="muted cell-note" style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5 }}>默认按导入当天算</div>
        </div>
      </div>
      <div className="btn-row" style={{ marginTop: 20 }}>
        <button className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={busy} data-autofocus>
          {busy && <span className="btn-spin" style={{ marginRight: 8 }} />}
          {busy ? '保存中…' : '保存修改'}
        </button>
      </div>
    </Modal>
  )
}
