import { useCallback, useEffect, useRef, useState } from 'react'
import { MOTION, clamp, rubberBand, prefersReducedMotion } from './motion.js'

// 一帧约 16.67ms：把"松手瞬间的速度(px/ms)"换算成惯性滑行的总距离
const FRAME = 1000 / 60

/**
 * 通用拖拽能力（符合人类直觉与物理规律）
 * ---------------------------------------------------------------------------
 * · 按下：光标变 grabbing，元素轻微抬起（放大 + 投影）
 * · 移动：实时跟随指针；越过阈值(threshold)才算拖拽，否则视为点击——避免误触发
 * · 越界：橡皮筋衰减，越拖越费劲
 * · 松手：按松手速度惯性滑行并缓动减速；靠近边界或吸附点时磁吸；越界则回弹
 * · 键盘：方向键可移动（无障碍替代操作），Shift 加速
 *
 * 所有物理参数（阈值 / 阻尼 / 磁吸距离 / 橡皮筋系数 / 步长）来自 lib/motion.js。
 *
 * @param {object}   options
 * @param {boolean}  options.enabled     是否启用拖拽
 * @param {string}   options.axis        'both' | 'x' | 'y'，限制拖动方向
 * @param {Function} options.getBounds   返回位移允许范围 {minX,maxX,minY,maxY}（相对起始点，px）
 * @param {Array}    options.snapPoints  吸附点 [{x,y}]，松手后靠近即吸过去
 * @param {Function} options.onDragStart
 * @param {Function} options.onDragEnd
 */
export function useDraggable({
  enabled = true,
  axis = 'both',
  getBounds,
  snapPoints = [],
  onDragStart,
  onDragEnd,
} = {}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  // idle 静止 | dragging 跟手中 | settling 惯性/回弹/磁吸动画中
  const [phase, setPhase] = useState('idle')

  const st = useRef({
    startPointer: null,   // 按下时的指针位置
    startOffset: { x: 0, y: 0 },
    active: false,        // 是否已越过阈值，真正进入拖拽
    samples: [],          // 速度采样点 [{t,x,y}]
    suppressClick: false, // 拖拽结束后是否要吃掉紧随的 click
    offset: { x: 0, y: 0 },
    timer: null,
  })
  st.current.offset = offset

  const readBounds = useCallback(() => getBounds?.() || null, [getBounds])

  /** 硬边界：把位移夹在允许范围内（松手后归位用） */
  const hardClamp = useCallback(
    (p) => {
      const b = readBounds()
      if (!b) return p
      return {
        x: axis === 'y' ? 0 : clamp(p.x, b.minX ?? -Infinity, b.maxX ?? Infinity),
        y: axis === 'x' ? 0 : clamp(p.y, b.minY ?? -Infinity, b.maxY ?? Infinity),
      }
    },
    [readBounds, axis]
  )

  /** 橡皮筋：越界部分按系数衰减，越拖越费劲（拖拽过程中用） */
  const withRubberBand = useCallback(
    (raw) => {
      const b = readBounds()
      if (!b) return raw
      const { rubberBandFactor, rubberBandMax } = MOTION.drag
      const out = { x: 0, y: 0 }
      const minX = b.minX ?? -Infinity
      const maxX = b.maxX ?? Infinity
      const minY = b.minY ?? -Infinity
      const maxY = b.maxY ?? Infinity

      if (axis === 'y') {
        out.x = 0
      } else if (raw.x < minX) {
        out.x = minX + rubberBand(raw.x - minX, rubberBandMax, rubberBandFactor)
      } else if (raw.x > maxX) {
        out.x = maxX + rubberBand(raw.x - maxX, rubberBandMax, rubberBandFactor)
      } else {
        out.x = raw.x
      }

      if (axis === 'x') {
        out.y = 0
      } else if (raw.y < minY) {
        out.y = minY + rubberBand(raw.y - minY, rubberBandMax, rubberBandFactor)
      } else if (raw.y > maxY) {
        out.y = maxY + rubberBand(raw.y - maxY, rubberBandMax, rubberBandFactor)
      } else {
        out.y = raw.y
      }
      return out
    },
    [readBounds, axis]
  )

  /** 用最近采样窗口内的位移估算松手速度（px/ms） */
  const estimateVelocity = useCallback(() => {
    const s = st.current.samples
    if (s.length < 2) return { x: 0, y: 0 }
    const now = performance.now()
    const win = MOTION.drag.velocitySampleWindow
    const recent = s.filter((p) => now - p.t <= win)
    const first = recent.length >= 2 ? recent[0] : s[s.length - 2]
    const last = s[s.length - 1]
    const dt = Math.max(1, last.t - first.t)
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt }
  }, [])

  /** 动画收尾：到点后回到 idle */
  const settle = useCallback((target, duration, easing) => {
    if (st.current.timer) clearTimeout(st.current.timer)
    setPhase('settling')
    setOffset(target)
    if (prefersReducedMotion()) {
      setPhase('idle')
      return
    }
    st.current.timer = setTimeout(() => setPhase('idle'), duration)
  }, [])

  /** 松手：惯性滑行 → 磁吸 → 回弹 */
  const finishDrag = useCallback(() => {
    const { inertiaDamping, inertiaMinVelocity, snapDistance } = MOTION.drag
    const cur = st.current.offset
    const v = estimateVelocity()
    const speed = Math.hypot(v.x, v.y)

    // 惯性：等比衰减的速度求和 → 总滑行距离
    let target = cur
    let duration = MOTION.duration.dragSnap
    let easing = MOTION.easing.spring

    if (speed >= inertiaMinVelocity) {
      const decay = inertiaDamping / (1 - inertiaDamping)
      target = { x: cur.x + v.x * FRAME * decay, y: cur.y + v.y * FRAME * decay }
      duration = MOTION.duration.dragInertia
      easing = MOTION.easing.decelerate
    }

    // 先夹回边界内（越界则自然形成回弹）
    const clamped = hardClamp(target)

    // 磁吸：靠近吸附点就吸过去
    let snapped = clamped
    if (Array.isArray(snapPoints) && snapPoints.length) {
      let best = null
      let bestDist = Infinity
      for (const p of snapPoints) {
        const d = Math.hypot(p.x - clamped.x, p.y - clamped.y)
        if (d < bestDist) {
          bestDist = d
          best = p
        }
      }
      if (best && bestDist <= snapDistance) {
        snapped = { x: best.x, y: best.y }
        duration = MOTION.duration.dragSnap
        easing = MOTION.easing.spring
      }
    }

    settle(snapped, duration, easing)
    onDragEnd?.(snapped)
  }, [estimateVelocity, hardClamp, settle, snapPoints, onDragEnd])

  /** 指针移动 */
  const onPointerMove = useCallback(
    (e) => {
      const s = st.current
      if (!s.startPointer) return
      const dx = e.clientX - s.startPointer.x
      const dy = e.clientY - s.startPointer.y

      // 未越过阈值：仍算"点击"，不动、不拦截
      if (!s.active) {
        if (Math.hypot(dx, dy) < MOTION.drag.threshold) return
        s.active = true
        setPhase('dragging')
        onDragStart?.()
      }

      const raw = {
        x: axis === 'y' ? 0 : s.startOffset.x + dx,
        y: axis === 'x' ? 0 : s.startOffset.y + dy,
      }
      s.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY })
      if (s.samples.length > 30) s.samples.shift()
      setOffset(withRubberBand(raw))
    },
    [axis, onDragStart, withRubberBand]
  )

  /** 指针抬起 */
  const onPointerUp = useCallback(() => {
    const s = st.current
    if (!s.startPointer) return
    s.startPointer = null
    const wasActive = s.active
    s.active = false

    if (wasActive) {
      // 真拖拽过：吃掉紧随的 click，避免松手时误触发元素上的点击
      s.suppressClick = true
      finishDrag()
    }
  }, [finishDrag])

  /** 指针按下 */
  const onPointerDown = useCallback(
    (e) => {
      if (!enabled) return
      if (e.button != null && e.button !== 0) return // 只响应鼠标主键
      const s = st.current
      s.startPointer = { x: e.clientX, y: e.clientY }
      s.startOffset = { ...s.offset }
      s.samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }]
      s.active = false
      if (st.current.timer) {
        clearTimeout(st.current.timer)
        st.current.timer = null
      }
      setPhase('idle')
    },
    [enabled]
  )

  // 拖拽期间在 window 上监听移动/抬起，指针移出元素也不会断
  useEffect(() => {
    if (!enabled) return
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [enabled, onPointerMove, onPointerUp])

  // 抑制"拖拽结束后那一次 click"
  useEffect(() => {
    const onClickCapture = (e) => {
      if (!st.current.suppressClick) return
      st.current.suppressClick = false
      e.stopPropagation()
      e.preventDefault()
    }
    document.addEventListener('click', onClickCapture, true)
    return () => document.removeEventListener('click', onClickCapture, true)
  }, [])

  /** 键盘替代操作：方向键移动，Shift 加速（无障碍） */
  const onKeyDown = useCallback(
    (e) => {
      if (!enabled) return
      const map = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }
      const dir = map[e.key]
      if (!dir) return
      e.preventDefault() // 阻止页面滚动
      const step = e.shiftKey ? MOTION.drag.keyboardStepFast : MOTION.drag.keyboardStep
      const cur = st.current.offset
      const next = hardClamp({
        x: axis === 'y' ? 0 : cur.x + dir[0] * step,
        y: axis === 'x' ? 0 : cur.y + dir[1] * step,
      })
      settle(next, MOTION.duration.dragSnap, MOTION.easing.decelerate)
    },
    [enabled, axis, hardClamp, settle]
  )

  /** 复位到起始位置 */
  const reset = useCallback(() => {
    settle({ x: 0, y: 0 }, MOTION.duration.dragSnap, MOTION.easing.spring)
  }, [settle])

  useEffect(() => () => { if (st.current.timer) clearTimeout(st.current.timer) }, [])

  const reduce = prefersReducedMotion()
  const isDragging = phase === 'dragging'

  /** 绑到"拖拽把手"（如弹窗标题栏）上的属性 */
  const handleProps = {
    onPointerDown,
    onKeyDown,
    tabIndex: enabled ? 0 : undefined,
    'aria-label': enabled ? '可拖动，也可用方向键移动' : undefined,
    style: {
      cursor: enabled ? (isDragging ? 'grabbing' : 'grab') : undefined,
      touchAction: 'none', // 触屏上禁用默认滚动，保证跟手
    },
  }

  /** 应用到被拖动元素上的样式 */
  const dragStyle = {
    transform: `translate3d(${offset.x}px, ${offset.y}px, 0)${
      isDragging && !reduce ? ` scale(${MOTION.drag.liftScale})` : ''
    }`,
    transition:
      phase === 'dragging'
        ? 'none' // 跟手阶段不做补间，实时跟随指针
        : phase === 'settling'
          ? `transform ${MOTION.duration.dragInertia}ms ${MOTION.easing.decelerate}`
          : `transform ${MOTION.duration.dragSnap}ms ${MOTION.easing.decelerate}`,
    boxShadow: isDragging && !reduce ? MOTION.drag.liftShadow : undefined,
    touchAction: 'none',
    willChange: phase === 'idle' ? undefined : 'transform',
  }

  return { offset, phase, isDragging, dragStyle, handleProps, reset, onKeyDown }
}
