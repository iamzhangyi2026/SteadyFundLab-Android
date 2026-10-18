import { useCallback, useEffect, useState } from 'react'
import Modal from './Modal'

// 统一的危险 / 重要操作二次确认弹窗。
// danger=true 时确认按钮用危险样式；confirmText 可自定义。
// 替代散落的 window.confirm 与无确认的危险操作，统一交互与视觉。
//
// ---- 键盘与焦点规范 ----
// · Esc 关闭：由 Modal 统一处理。
// · Enter 确认：焦点停在弹窗面板时按 Enter 即确认；焦点已在某个按钮或输入控件上时
//   不干预，交给原生 click / 换行行为，避免"按回车却触发了别的按钮"。
// · 默认焦点：危险操作默认落在「取消」（防止顺手一个回车就删了东西），
//   普通操作默认落在主操作按钮。
export default function ConfirmDialog({
  open, title, message, confirmText = '确认', cancelText = '取消', danger = false, onConfirm, onClose, loadingText = '处理中…',
}) {
  const [loading, setLoading] = useState(false)
  // 弹窗复用同一实例（open=false 时 return null 并不卸载，useState 持久）。
  // 若上次 onConfirm 成功直接 onClose 而未复位 loading，下次打开会残留 true 卡在"处理中…"。
  // 每次打开时强制复位，保证按钮可点。
  useEffect(() => {
    if (open) setLoading(false)
  }, [open])

  const handleConfirm = useCallback(async () => {
    if (!onConfirm) { onClose(); return }
    try {
      setLoading(true)
      await onConfirm()
      setLoading(false) // 成功路径也复位，避免残留
      onClose()
    } catch {
      // 回调内部已自行 toast 报错；保持弹窗打开，按钮恢复可点，便于重试
      setLoading(false)
    }
  }, [onConfirm, onClose])

  // Enter 触发主操作（焦点在按钮或输入类控件时不干预）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e) => {
      if (e.key !== 'Enter') return
      const tag = (e.target?.tagName || '').toUpperCase()
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      handleConfirm()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, handleConfirm])

  if (!open) return null
  return (
    <Modal open={open} title={title} onClose={onClose} width={420}>
      <p style={{ margin: '0 0 4px', color: 'var(--text-soft, #4a5160)', fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-line' }}>
        {message}
      </p>
      {/* 平台惯例排布：取消在左、主操作在右（间距走 token） */}
      <div className="btn-row" style={{ marginTop: 18 }}>
        <button
          className="btn"
          onClick={onClose}
          disabled={loading}
          {...(danger ? { 'data-autofocus': true } : {})}
        >
          {cancelText}
        </button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          disabled={loading}
          aria-busy={loading}
          onClick={handleConfirm}
          {...(!danger ? { 'data-autofocus': true } : {})}
        >
          {loading && <span className="btn-spin" style={{ marginRight: 8 }} />}
          {loading ? loadingText : confirmText}
        </button>
      </div>
    </Modal>
  )
}
