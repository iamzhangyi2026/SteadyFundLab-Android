// src/components/TabBar.jsx · 底部四 Tab
// ------------------------------------------------------------
// 持仓 / 自选 / 发现 / 我的。只负责展示与点击回调，不持有业务状态；
// 红点（dots）由 App 层算好传进来。二级页（详情/模拟账本/对比/大盘/筛选）
// 打开时不渲染本组件。

import { IconStar, IconCompass, IconWallet, IconUser } from './Icons.jsx'

const TABS = [
  { key: 'holdings', label: '持仓', Icon: IconWallet },
  { key: 'watch', label: '自选', Icon: IconStar },
  { key: 'discover', label: '发现', Icon: IconCompass },
  { key: 'me', label: '我的', Icon: IconUser },
]

/**
 * @param {string[]} [dots] - 哪些页签要显示红点（传 TABS 的 key 数组，如 ['me']）
 */
export default function TabBar({ active, onChange, dots = [] }) {
  return (
    <nav className="tabbar" role="tablist">
      {TABS.map(({ key, label, Icon }) => (
        <button
          key={key}
          role="tab"
          aria-selected={active === key}
          className={active === key ? 'tab-item on' : 'tab-item'}
          onClick={() => onChange(key)}
        >
          <span className="tab-icon">
            <Icon />
            {dots.includes(key) ? <i className="tab-dot" aria-label="有新消息" /> : null}
          </span>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}
