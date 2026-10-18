// ui.jsx · 安卓风格基础组件（列表 / 分组 / 二级页顶栏）
//
// 目的：提供安卓常见的「分组列表 + 二级页」基础组件。
// 设计对齐 Material：一行一项、左主文案右值、右侧箭头提示可点。
import { Icon } from './Icons.jsx'

/** 二级页顶栏：返回箭头 + 标题（+ 可选右侧动作） */
export function NavBar({ title, onBack, right }) {
  return (
    <div className="navbar">
      <button className="navbar-back" onClick={onBack} aria-label="返回">
        <Icon.back style={{ width: 22, height: 22 }} />
      </button>
      <div className="navbar-title">{title}</div>
      <div className="navbar-right">{right}</div>
    </div>
  )
}

/** 分组：小标题 + 一组列表项（安卓「设置」页的标准长相） */
export function ListGroup({ title, children, footer }) {
  return (
    <div className="list-group">
      {title && <div className="list-group-title">{title}</div>}
      <div className="list-group-body">{children}</div>
      {footer && <div className="list-group-footer">{footer}</div>}
    </div>
  )
}

/** 列表项：左主文案(+副文案) / 右值 / 右侧箭头 */
export function ListItem({ title, sub, value, valueClass = '', icon, onClick, chevron = true, disabled = false }) {
  return (
    <button
      type="button"
      className={`list-item${onClick ? ' tappable' : ''}${disabled ? ' disabled' : ''}`}
      onClick={disabled ? undefined : onClick}
    >
      {icon && <span className="li-icon">{icon}</span>}
      <span className="li-main">
        <span className="li-title">{title}</span>
        {sub && <span className="li-sub">{sub}</span>}
      </span>
      {value != null && value !== '' && <span className={`li-value ${valueClass}`}>{value}</span>}
      {onClick && chevron && <span className="li-arrow" aria-hidden>›</span>}
    </button>
  )
}

/** 区块标题（页内小节，非卡片） */
export function SectionTitle({ title, right }) {
  return (
    <div className="section-title">
      <span>{title}</span>
      {right && <span className="section-title-right">{right}</span>}
    </div>
  )
}
