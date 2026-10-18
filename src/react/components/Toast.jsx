import { useStore } from '../store/useStore'

// 操作反馈（队列）。内容来自 store.toasts。
// 两类：
//   普通提示 —— 自动消失（默认 2.4s，调用方可用 notify 的第 3 个参数调整时长）；
//   常驻提示 —— sticky（duration<=0），**不自动消失**，必须点 × 关闭，
//              用于重大事件强推、风控提醒这类「一闪而过就漏看」的内容。
// 多条用 .toast-stack 纵向排列，连续操作互不覆盖。
// 用 aria-live 包裹，让读屏软件在不抢焦点的前提下播报结果。
export default function Toast() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  if (!toasts?.length) return null
  return (
    <div className="toast-stack" aria-live="polite" role="status" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.type}${t.sticky ? ' sticky' : ''}`}
          // 悬停显示全文：标题过长时也能看全，不用去别处找
          title={t.message}
        >
          <span>{t.message}</span>
          <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="关闭提示">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
