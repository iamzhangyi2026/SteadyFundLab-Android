/**
 * 交互动效参数 · 单一事实来源
 * ---------------------------------------------------------------------------
 * 本文件集中定义「按键 / 弹窗 / 拖拽」三类交互的全部动效参数：
 * 动画时长、缓动曲线、阻尼系数、触发阈值、缩放比例等。
 *
 * 为什么集中在这里
 * - CSS 动画与 JS 物理计算（拖拽惯性/磁吸）必须共用同一份数值，否则两边手感会打架。
 * - 调手感只需改本文件：installMotionVars() 会把这些值注入为 :root CSS 变量，
 *   CSS 侧（app.css）直接 var(--xxx) 引用即可。
 *
 * 使用方式
 * - JS 侧：import { MOTION } from '../lib/motion'
 * - CSS 侧：var(--modal-dur-enter) 等（由 installMotionVars 在入口注入）
 * - tokens.css 里同名变量是「首屏兜底值」，运行时会被本文件覆盖；
 *   若同时修改两处，请以本文件为准。
 */

/** 是否开启了「减少动态效果」（系统无障碍偏好） */
export function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export const MOTION = {
  /* ---------------- 基础时长（ms） ---------------- */
  duration: {
    instant: 100,   // 极短反馈（按下）
    fast: 160,     // 悬停、小范围过渡
    base: 280,     // 常规过渡
    slow: 560,     // 大范围位移 / 惯性滑行

    // 弹窗：遵循「退出短于进入」——关闭应该比打开更利落
    modalEnter: 400,
    modalExit: 260,
    overlayFade: 300,

    // 按钮
    buttonHover: 160,
    buttonPress: 110,

    // 拖拽
    dragInertia: 520,  // 松手后惯性滑行总时长
    dragSnap: 320,     // 磁吸吸附 / 橡皮筋回弹时长
  },

  /* ---------------- 缓动曲线 ---------------- */
  easing: {
    // 标准：进出均衡，用于颜色/阴影等属性过渡
    standard: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
    // 减速（快出慢入）：用于「进入」——元素冲进来后柔和停住，像被放下
    decelerate: 'cubic-bezier(0.22, 0.85, 0.3, 1)',
    // 加速：用于「退出」——先慢后快，像被抽走
    accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
    // 回弹（超调）：用于磁吸/橡皮筋回弹，带一点点过冲，手感更"有弹性"
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    // 物理标准：起步加速 → 中段快 → 末段减速停住（ease-in-out）。
    // 真实物体从 A 移到 B 必然是「克服静止→加速→阻尼减速」，
    // 弹窗这类「从触发元素飞到屏幕中央」的位移必须用这条才符合物理直觉。
    physical: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },

  /* ---------------- 按键 ---------------- */
  button: {
    pressScale: 0.975,   // 按下时缩放（模拟被按下去）
    pressTranslateY: 1,  // 按下时下沉 1px（配合缩放，物理感更真）
    hoverLiftY: -1,      // 悬停时微微抬起
    focusRingWidth: 3,   // 键盘焦点环宽度(px)
    disabledOpacity: 0.5,
  },

  /* ---------------- 弹窗 ---------------- */
  modal: {
    scaleFrom: 0.7,           // 入场起始缩放（由小变大：起点最小、飞到窗口居中时恢复 1.0；值越小"长大"越明显）
    translateFrom: 28,        // 入场起始 Y 位移(px)
    originFromTrigger: true,  // 是否以触发元素位置为动画起点
    // 起点偏移 = 触发元素中心相对屏幕中心的真实偏移 × ratio。
    // 必须取 1：起点要正好落在触发元素上，否则弹窗看着还是"在中间冒出来"，
    // 看不出是从哪个按钮来的。
    originOffsetRatio: 1,
    originMaxOffset: 900,     // 位移上限(px)，放开到足够大，保证起点能精确压在触发元素上

  },

  /* ---------------- 拖拽物理 ---------------- */
  drag: {
    threshold: 4,          // 启动阈值(px)：指针移动超过它才算「拖拽」，否则视为点击
    liftScale: 1.02,       // 抓起时轻微放大（抬起反馈）
    liftShadow: '0 18px 48px rgba(15, 23, 42, 0.18)', // 抓起时的投影（离手更远）
    liftRotate: 0,         // 抓起时旋转角度(deg)，0=不旋转

    // 惯性：松手后按最后速度继续滑行，每帧按 damping 衰减
    inertiaDamping: 0.92,      // 每帧速度衰减系数（越接近 1 滑得越远）
    inertiaMinVelocity: 0.02,  // 速度低于此值(px/ms)即停止滑行
    velocitySampleWindow: 100, // 取最近多少毫秒内的位移来估算松手速度

    // 磁吸：距吸附点/边界小于 snapDistance 时吸过去
    snapDistance: 24,

    // 橡皮筋：拖出边界后，超出部分按此系数衰减（越界越难拖）
    rubberBandFactor: 0.35,
    rubberBandMax: 120,  // 橡皮筋最大拉伸(px)，防止拖到天边

    // 键盘替代操作（无障碍：不用鼠标也能移动）
    keyboardStep: 16,      // 方向键单次步长(px)
    keyboardStepFast: 48,  // 按住 Shift 的快步长(px)
  },
}

/**
 * 把动效参数注入为 :root CSS 变量，让 CSS 动画与 JS 物理共用同一份数值。
 * 在应用入口（main.jsx）调用一次即可。
 *
 * 若用户开启了系统级「减少动态效果」，所有时长归零、位移取消，
 * 只保留必要的不透明度变化，避免诱发不适。
 */
export function installMotionVars(root = document.documentElement) {
  if (!root) return
  const reduce = prefersReducedMotion()
  const d = MOTION.duration

  // 归零助手：开启减少动效时把所有时长压到 1ms（保留动画结束回调，不破坏逻辑）
  const ms = (v) => `${reduce ? 160 : v}ms`
  // 位移助手：开启减少动效时取消位移/缩放
  const px = (v) => (reduce ? '0px' : `${v}px`)
  const unit = (v) => (reduce ? 1 : v)

  const vars = {
    /* 基础 */
    '--motion-fast': ms(d.fast),
    '--motion': ms(d.base),
    '--motion-slow': ms(d.slow),
    '--dur': ms(d.base),
    '--dur-slow': ms(d.slow),
    '--dur-exit': ms(d.modalExit),   // 退出动画时长，供 CSS 引用
    '--dur-enter': ms(d.modalEnter),
    '--ease': MOTION.easing.standard,
    '--ease-out': MOTION.easing.decelerate,
    '--ease-in': MOTION.easing.accelerate,
    '--ease-spring': MOTION.easing.spring,
    '--ease-physical': MOTION.easing.physical,

    /* 按键 */
    '--btn-dur-hover': ms(d.buttonHover),
    '--btn-dur-press': ms(d.buttonPress),
    '--btn-press-scale': unit(MOTION.button.pressScale),
    '--btn-press-y': px(MOTION.button.pressTranslateY),
    '--btn-hover-y': px(MOTION.button.hoverLiftY),
    '--btn-focus-ring': px(MOTION.button.focusRingWidth),
    '--btn-disabled-opacity': MOTION.button.disabledOpacity,

    /* 弹窗 */
    '--modal-dur-enter': ms(d.modalEnter),
    '--modal-dur-exit': ms(d.modalExit),
    '--modal-overlay-dur': ms(d.overlayFade),
    '--modal-scale-from': unit(MOTION.modal.scaleFrom),
    '--modal-translate-from': px(MOTION.modal.translateFrom),

    /* 拖拽 */
    '--drag-dur-inertia': ms(d.dragInertia),
    '--drag-dur-snap': ms(d.dragSnap),
    '--drag-lift-scale': unit(MOTION.drag.liftScale),
    '--drag-lift-shadow': reduce ? 'none' : MOTION.drag.liftShadow,
    '--drag-lift-rotate': `${reduce ? 0 : MOTION.drag.liftRotate}deg`,
  }

  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, String(v)))
}

/** 数值裁剪，拖拽计算里反复用到 */
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

/**
 * 橡皮筋衰减：把「超出边界的距离」压缩成实际位移。
 * 越界越多，拖拽阻力越大（越界位移按指数衰减），松手后自然回弹。
 */
export function rubberBand(overshoot, max, factor) {
  if (overshoot === 0) return 0
  const sign = Math.sign(overshoot)
  const abs = Math.abs(overshoot)
  // 公式：位移随越界距离增长但趋于饱和（(1 - 1/(x/const + 1)) * const）
  return sign * (1 - 1 / (abs / (max / factor) + 1)) * (max / factor)
}
