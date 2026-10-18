import { useState, useRef, useEffect } from 'react'
import { Icon } from './components/Icons.jsx'
import { fetchDecisionLog } from './lib/scheduler'
import { NavBar } from './components/ui.jsx'
import PullToRefresh from './components/PullToRefresh.jsx'
import { runPullRefresh } from './lib/pullRefreshRegistry.js'

// 底部 Tab Bar — 4 Tab，以账户为主轴
const TABS = [
  { key: 'account',  label: '持仓', icon: 'overview' },
  { key: 'trade',    label: '交易', icon: 'trade'    },
  { key: 'analysis', label: '分析', icon: 'analysis' },
  { key: 'settings', label: '我的', icon: 'settings' },
]

const ACTION_LABEL = { buy: '买入', sell: '卖出', hold: '不动', alert: '告警', none: '不动' }

export default function MobileLayout({
  children, activeTab, onTabChange, headerRight, onBellClick, version, notifyOpen,
  page = null, pageTitle = '', onPageBack,
}) {
  const mainRef = useRef(null)
  const [scrolled, setScrolled] = useState(false)
  const [notices, setNotices] = useState(null)

  // 提醒面板：读真实决策日志（纪律线触发 / 每日决策都会落这里）
  useEffect(() => {
    if (!notifyOpen) return
    let alive = true
    setNotices(null)
    fetchDecisionLog(8)
      .then(r => {
        if (!alive) return
        const rows = r.ok ? (r.data || []) : []
        setNotices(rows.map(d => ({
          title: `${d.fund_name || d.fund_code || '账户'} · ${ACTION_LABEL[d.action] || d.action || '决策'}`,
          sub: `${String(d.ts || '').slice(5, 16)}　${d.reason || ''}`.trim(),
        })))
      })
      .catch(() => { if (alive) setNotices([]) })
    return () => { alive = false }
  }, [notifyOpen])

  // 滚动时 header 状态切换
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const onScroll = () => setScrolled(el.scrollTop > 8)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // ── 二级页（安卓 push）：整屏、自带 AppBar、隐藏底部 Tab ──
  if (page) {
    return (
      <div className="app-shell">
        <div className="app-body no-tab" ref={mainRef}>
          <NavBar title={pageTitle || page.key} onBack={onPageBack} />
          <div className="page-content">
            {/* 下拉刷新：二级页同样支持（滚动容器 = 外层 .app-body.no-tab） */}
            <PullToRefresh scrollRef={mainRef} onRefresh={runPullRefresh}>
              {children}
            </PullToRefresh>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {/* ── 顶部 Header ── */}
      <header className={`app-header${scrolled ? ' scrolled' : ''}`}>
        <div className="app-header-inner">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="app-title">{TAB_NAME_MAP[activeTab]?.title || '基金沙盒'}</div>
            <div className="app-sub">{TAB_NAME_MAP[activeTab]?.sub || `v${version}`}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {headerRight}
            {onBellClick && (
              <button
                onClick={onBellClick}
                aria-label="提醒"
                className="header-btn"
                style={{ width: 32, height: 32 }}
              >
                <Icon.bell style={{ width: 18, height: 18 }} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── 通知面板遮罩（点击外部关闭）── */}
      {notifyOpen && (
        <div className="notify-overlay" onClick={onBellClick}>
          <div className="notify-panel" onClick={(e) => e.stopPropagation()}>
            <div className="notify-panel-header">
              <span className="notify-panel-title">提醒</span>
              <button className="notify-close" onClick={onBellClick} aria-label="关闭">✕</button>
            </div>
            <div className="notify-panel-body">
              {notices === null ? (
                <div className="notify-empty">读取中…</div>
              ) : notices.length === 0 ? (
                <div className="notify-empty">暂无提醒<br /><span style={{ fontSize: 12, color: 'var(--text-mute)' }}>没到提醒条件时不会有提醒</span></div>
              ) : (
                <ul className="intel-list">
                  {notices.map((n, i) => (
                    <li key={i} className="intel-item">
                      <div className="intel-body">
                        <div className="intel-title" style={{ fontSize: 13 }}>{n.title}</div>
                        {n.sub && <div className="intel-meta">{n.sub}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 主内容区 ── */}
      <main ref={mainRef} className="app-body">
        {/* 下拉刷新：在页面顶部下拉 → 刷新当前页数据（各页注册到 pullRefreshRegistry） */}
        <PullToRefresh scrollRef={mainRef} onRefresh={runPullRefresh}>
          {children}
        </PullToRefresh>
      </main>

      {/* ── 底部 Tab Bar ── */}
      <nav className="tab-bar" role="tablist">
        {TABS.map(tab => {
          const isActive = tab.key === activeTab
          const IconComp = Icon[tab.icon]
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              className={`tab-item${isActive ? ' active' : ''}`}
              onClick={() => onTabChange?.(tab.key)}
            >
              {IconComp && <IconComp />}
              <span>{tab.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

const TAB_NAME_MAP = {
  account:  { title: '持仓',   sub: '真实持仓 · 实时涨跌' },
  trade:    { title: '交易', sub: '模拟盘 · 虚拟本金自设' },
  analysis: { title: '分析',   sub: '选基 · 持仓体检 · 看市场' },
  settings: { title: '我的',   sub: '账户 · 智能助手 · 数据' },
}
