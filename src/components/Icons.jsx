/**
 * 图标组件
 * ------------------------------------------------------------
 * 统一线性风格：stroke 描边、1.7px 线宽、圆角端点。
 * 尺寸不在这里写死 —— 由使用处的 CSS 控制（如 .tab-item svg）。
 *
 * 只保留**当前实际用到**的图标。新增时按同样风格追加即可：
 *   1. 用 base 铺开公共属性，只覆盖差异部分
 *   2. 路径统一画在 24×24 的 viewBox 里，四周留 ~3px 安全边
 */

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

/** 自选 —— 星标（TabBar） */
export function IconStar(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.6l2.55 5.17 5.7.83-4.13 4.02.98 5.68L12 16.62l-5.1 2.68.98-5.68L3.75 9.6l5.7-.83z" />
    </svg>
  )
}

/** 发现 —— 指南针（TabBar） */
export function IconCompass(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M15.6 8.4l-1.9 5.3-5.3 1.9 1.9-5.3z" />
    </svg>
  )
}

/** 持仓 —— 钱包（TabBar） */
export function IconWallet(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3.4" y="6.2" width="17.2" height="12.4" rx="3" />
      <path d="M3.4 10.6h17.2" />
      <circle cx="16.6" cy="14.4" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 我的 —— 人像（TabBar） */
export function IconUser(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5.2 19.6c0-3.3 3-5.4 6.8-5.4s6.8 2.1 6.8 5.4" />
    </svg>
  )
}

/** 刷新（自选页顶栏） */
export function IconRefresh(props) {
  return (
    <svg {...base} {...props}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4.5V10h-5.5" />
    </svg>
  )
}

/** 返回（详情页顶栏） */
export function IconBack(props) {
  return (
    <svg {...base} {...props}>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  )
}
