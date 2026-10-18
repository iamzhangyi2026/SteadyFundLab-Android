import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MOTION, clamp } from '../lib/motion.js'
import { useDraggable } from '../lib/useDrag.js'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

// 弹窗与视口之间保留的安全边距(px)，拖拽时不允许把弹窗拖出这个范围
const EDGE_MARGIN = 16

// 判断一个元素能否当作入场起点：必须是真实可见的控件。
// 排除 body / html（它们的矩形是整个视口，会把起点算到屏幕角落），
// 也排除尺寸为 0 或已滚出视口的元素，避免未显式指定触发元素的弹窗起点乱飞。
function isUsableTrigger(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false
  const tag = (el.tagName || '').toUpperCase()
  if (tag === 'BODY' || tag === 'HTML') return false
  const r = el.getBoundingClientRect()
  if (!(r.width > 0 && r.height > 0)) return false
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false
  return true
}

// 通用弹窗。承担四件事：
// 1) 语义：role=dialog / aria-modal；
// 2) 键盘：Esc 关闭 + Tab 焦点循环；
// 3) 打开期间锁定页面滚动，避免背景跟着滚；
// 4) 打开时焦点移入弹窗，关闭后焦点回到触发元素。
//
// ---- 弹出方式 ----
// 弹窗始终停在软件窗口正中（屏幕居中）。入场以触发元素为起点：弹窗从它所在的方向"长出来"
// （轻微缩放 + 位移飞向中心），让你看得出它从哪来；出场沿原路返回，动画对称；遮罩同步淡入淡出。
// 所有时长 / 位移 / 缩放取自统一配置 lib/motion.js，不在这里写死数值。
//
// ---- 拖拽（可选）----
// draggable=true 时标题栏成为把手：抓取光标、抬起反馈、实时跟随、
// 松手惯性滑行、靠近中心磁吸、越界橡皮筋回弹，并可用方向键移动（键盘替代）。
// 拖拽位移由外层容器承担，与面板自身的入场动画互不干扰。
//
// 用法：把触发按钮的 ref 传给 triggerRef，即可获得"从按钮飞入正中"的效果；
//       不传则退化为轻微上移淡入（与旧行为一致，保证向后兼容）。
export default function Modal({ open, title, onClose, children, width, triggerRef, draggable = false }) {
  const panelRef = useRef(null)
  const lastActiveRef = useRef(null)
  const [render, setRender] = useState(open)
  const [closing, setClosing] = useState(false)
  // 入场起点偏移（px）：从触发元素指向屏幕中心的方向（弹窗停在正中，只是入场从按钮方向飞入）
  const [origin, setOrigin] = useState({ x: 0, y: MOTION.modal.translateFrom })

  // 拖拽位移的快照（供边界计算读取，避免回调里拿到过期值）
  const offsetRef = useRef({ x: 0, y: 0 })

  // 边界：弹窗整体必须留在视口内（留 EDGE_MARGIN 安全边距）
  const getBounds = useCallback(() => {
    const el = panelRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const left0 = r.left - offsetRef.current.x
    const top0 = r.top - offsetRef.current.y
    const minX = EDGE_MARGIN - left0
    const maxX = window.innerWidth - EDGE_MARGIN - r.width - left0
    const minY = EDGE_MARGIN - top0
    const maxY = window.innerHeight - EDGE_MARGIN - r.height - top0
    // 弹窗比视口还大时，区间会反向；夹一下保证至少包含 0（可回中）
    return {
      minX: Math.min(minX, 0),
      maxX: Math.max(maxX, 0),
      minY: Math.min(minY, 0),
      maxY: Math.max(maxY, 0),
    }
  }, [])

  const drag = useDraggable({
    enabled: draggable,
    getBounds,
    // 中心点作为吸附点：拖到接近居中时自动吸回去
    snapPoints: [{ x: 0, y: 0 }],
  })
  offsetRef.current = drag.offset

  // 计算入场起点：以触发元素中心相对屏幕中心的偏移为方向，
  // 按比例缩放并限制上限，避免触发点在屏幕角落时"飞"得太夸张。
  useEffect(() => {
    if (!open) return
    // 起点元素：优先显式传入的触发按钮；未传入时回退为「打开前最后聚焦的元素」
    // ——点击按钮会让它获得焦点，所以 ConfirmDialog / 简报 / 录入情报等未逐个指定触发元素的
    // 弹窗，也能从被点的按钮长出，无需改动各自的调用方。
    const el =
      triggerRef?.current ||
      (isUsableTrigger(document.activeElement) ? document.activeElement : null)
    if (!el || !MOTION.modal.originFromTrigger) {
      setOrigin({ x: 0, y: MOTION.modal.translateFrom })
      return
    }
    const r = el.getBoundingClientRect()
    const dx = r.left + r.width / 2 - window.innerWidth / 2
    const dy = r.top + r.height / 2 - window.innerHeight / 2
    const limit = MOTION.modal.originMaxOffset
    const ratio = MOTION.modal.originOffsetRatio
    // 严格「哪来哪去」：入场起点就是触发元素所在位置，
    // 弹窗从那里飞向屏幕正中（终点始终是居中）。
    setOrigin({
      x: clamp(dx * ratio, -limit, limit),
      y: clamp(dy * ratio, -limit, limit),
    })
  }, [open, triggerRef])

  // 打开 / 关闭：关闭时先播出场动画，播完再卸载（时长取自统一配置）
  useEffect(() => {
    if (open) {
      setRender(true)
      setClosing(false)
      return
    }
    if (render) {
      setClosing(true)
      // 多留一点余量，确保出场动画完整播完再卸载（否则最后一帧被截断，观感像瞬间消失）
      const t = setTimeout(() => {
        setRender(false)
        setClosing(false)
      }, MOTION.duration.modalExit + 60)
      return () => clearTimeout(t)
    }
  }, [open, render])

  // Esc 关闭 + Tab 焦点陷阱（仅在展开且非关闭动画期间挂载监听）
  useEffect(() => {
    if (!render || closing) return
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement
      )
      if (!nodes.length) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [render, closing, onClose])

  // 锁滚动 + 记住/归还焦点
  useEffect(() => {
    if (!render) return
    lastActiveRef.current = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // 优先聚焦标注了 data-autofocus 的元素，否则聚焦面板本身（避免焦点落在「×」上）
    const panel = panelRef.current
    const target = panel?.querySelector('[data-autofocus]') || panel
    target?.focus?.()
    return () => {
      document.body.style.overflow = prevOverflow
      // 优先还给触发元素，其次还给打开前处于焦点的元素
      const back = triggerRef?.current || lastActiveRef.current
      back?.focus?.()
    }
  }, [render, triggerRef])

  if (!render) return null

  const panel = (
    <div
      className={`modal ${closing ? 'closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
      tabIndex={-1}
      ref={panelRef}
      style={{
        // 居中模式：交给 CSS 动画，入场从该偏移处飞入（从按钮方向飞向正中），出场沿原路返回（对称）
        '--modal-origin-x': `${origin.x}px`,
        '--modal-origin-y': `${origin.y}px`,
        ...(width ? { maxWidth: width } : null),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header className="modal-head" {...(draggable ? drag.handleProps : {})}>
        <h3>{title}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="关闭弹窗">
          ×
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </div>
  )

  const overlay = (
    <div
      className={`modal-overlay ${closing ? 'closing' : ''}`}
      onMouseDown={() => {
        if (!closing) onClose?.()
      }}
    >
      {/* 拖拽位移由外层容器承担，避免与面板自身的入场动画抢 transform */}
      {draggable ? (
        <div className="modal-drag" style={drag.dragStyle}>
          {panel}
        </div>
      ) : (
        panel
      )}
    </div>
  )

  // 用 Portal 挂到 document.body：避免被组件树里某层祖先的 transform / filter /
  // backdrop-filter 当成 fixed 定位的包含块，从而保证弹窗稳定覆盖全视口、坐标精确对齐视口。
  return typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay
}
