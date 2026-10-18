// App.jsx · 根组件
//
// 结构（安卓常规：**底部 4 Tab + 列表驱动 + 二级页 push**）：
//   账户 → Overview   关键指标 + 持仓列表
//   交易 → Trade      搜索 + 自选列表
//   分析 → Analysis   入口列表 → 各主题二级页
//   设置 → More       分组列表 → 各功能二级页
//
// 二级页由 lib/nav.jsx 的页面栈驱动：push 进、pop 出，安卓返回键同走 pop。

import { useState, useEffect, lazy, Suspense } from 'react'
import MobileLayout from './MobileLayout.jsx'
import Overview from './views/Overview.jsx'
import Trade from './views/Trade.jsx'
import Analysis from './views/Analysis.jsx'
import More from './views/More.jsx'
import Toast from './components/Toast.jsx'
import AiChatWidget from './components/AiChatWidget.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import useNotify from './hooks/useNotify.jsx'
import { DataProvider } from './hooks/useData.jsx'
import { NavProvider, useNav } from './lib/nav.jsx'
import { setPendingTrade } from './lib/pendingAction'
import { jsEvaluateAlerts, isInitialized } from './lib/dataAdapter'
import { applyTheme, getStoredTheme, watchSystemTheme, subscribeTheme } from './lib/theme'

/**
 * 二级页注册表：key → { title, render(nav, params) }
 *
 * 通用页 `page`：正文由 push 时的 `params.body()` 提供
 * —— 各主题页的正文在页面组件里就地声明，无需为每个主题单独建文件。
 *
 * `fundDetail`：基金详情（净值曲线 / 指标 / 回撤修复 / 重仓 / 公告）。
 * 懒加载：它经 NetValueChart 引入 ECharts（~670 kB），只在打开详情时拉这个分块，
 * 不拖慢首屏。正文组件 FundDetailBody 不带 Modal 外壳，顶栏/返回由 MobileLayout 的 NavBar 提供。
 */
const FundDetailBody = lazy(() => import('./components/FundDetailModal'))

/**
 * 详情页「手动买入 / 手动赎回」接通交易页：写入一次性指令 → 切到交易 Tab
 * → 回 Tab 根 → 广播事件让交易页立即消费（选中该基金并展开金额输入区）。
 */
function gotoTradeWithFund(nav, ctx, code, action) {
  setPendingTrade({ code, action })
  if (ctx && ctx.setActiveTab) ctx.setActiveTab('trade')
  nav.reset()
  // Trade 若已挂载（Tab 未变）不会重新 mount，靠事件通道消费
  setTimeout(() => {
    try { window.dispatchEvent(new Event('fundapp:fund-trade')) } catch { /* 忽略 */ }
  }, 80)
}

const PAGES = {
  page: { title: '', render: (_nav, p) => (p && p.body ? p.body() : null) },
  fundDetail: {
    title: '',
    render: (nav, p, ctx) => (
      <Suspense fallback={<div className="loading">加载中…</div>}>
        <FundDetailBody
          code={p.code}
          name={p.name}
          // hideTrade：真实持仓入口（持仓页 / 导入面板）进来时不传买卖回调 →
          // 详情页不显示「手动买入 / 手动赎回」（真实持仓是账本，不引导去虚拟盘交易）；
          // 同时作为 realEntry 挂载持仓条与六段式深度分析。
          realEntry={!!p.hideTrade}
          onBuy={p.hideTrade ? undefined : () => gotoTradeWithFund(nav, ctx, p.code, 'buy')}
          onSell={p.hideTrade ? undefined : () => gotoTradeWithFund(nav, ctx, p.code, 'sell')}
        />
      </Suspense>
    ),
  },
}

function AppShell() {
  const nav = useNav()
  const [activeTab, setActiveTab] = useState('account')
  const [version] = useState('v1.0.0')
  const { open, toggle: onBellClick } = useNotify()

  const entry = nav.page ? PAGES[nav.page.key] : null

  // 切 Tab 时清空二级页栈（安卓常见行为：Tab 回到该页根）
  const handleTabChange = (t) => { nav.reset(); setActiveTab(t) }

  // AI 建议卡「去交易」按钮走这里（全局事件 → 切到交易 Tab，再由 Trade 消费预填指令）
  useEffect(() => {
    const gotoTrade = () => { nav.reset(); setActiveTab('trade') }
    window.addEventListener('fundapp:goto-trade', gotoTrade)
    return () => window.removeEventListener('fundapp:goto-trade', gotoTrade)
  }, [nav])

  // 涨跌/净值预警：数据层就绪后 + 每次从后台回到前台，自动评估一次（带 5 分钟冷却，避免重复打扰）
  useEffect(() => {
    let lastEval = 0
    let cancelled = false
    const runEval = () => {
      const now = Date.now()
      if (now - lastEval < 5 * 60 * 1000) return
      lastEval = now
      jsEvaluateAlerts().catch(() => {})
    }
    // initDataLayer 异步、约 28s 才把真库打开；mount 时 _db 仍是 null，
    // 直接评估会返回 app_not_initialized 静默失败 → 先等数据层就绪再评。
    const waitReady = async () => {
      for (let i = 0; i < 120 && !cancelled; i++) {
        if (isInitialized()) { runEval(); return }
        await new Promise((r) => setTimeout(r, 1000))
      }
      if (!cancelled) runEval() // 兜底：超时也试一次（由上层 cooldown 保护）
    }
    waitReady()
    import('@capacitor/app').then(({ App }) => {
      App.addListener('appStateChange', (s) => { if (s?.isActive) runEval() }).catch(() => {})
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // 全量抓取触发：充电 + WiFi + 夜间(23:00~07:00) + 每日一次 + App 在后台
  // （实现见 lib/autoRefresh.js，触发充电+WiFi+夜间+每日一次的后台全量抓取）
  useEffect(() => {
    import('./lib/autoRefresh.js')
      .then(({ startAutoRefreshTriggers }) => startAutoRefreshTriggers({}))
      .catch((e) => console.warn('[app] autoRefresh 启动失败:', e?.message || e))
  }, [])

  // 主题：启动即应用；「跟随系统」模式下监听系统深浅色变化。
  // 订阅主题变化 → 触发整树重渲染，让 canvas 图表（读不到 CSS 变量）重绘。
  const [, forceThemeTick] = useState(0)
  useEffect(() => {
    applyTheme(getStoredTheme())
    const offSys = watchSystemTheme(() => { if (getStoredTheme() === 'system') applyTheme('system') })
    const offSub = subscribeTheme(() => forceThemeTick((v) => v + 1))
    return () => { offSys(); offSub() }
  }, [])

  const renderView = () => {
    switch (activeTab) {
      case 'trade': return <Trade />
      case 'analysis': return <Analysis />
      case 'settings': return <More />
      default: return <Overview />
    }
  }

  return (
    <MobileLayout
      activeTab={activeTab}
      onTabChange={handleTabChange}
      onBellClick={onBellClick}
      version={version}
      notifyOpen={open}
      page={nav.page}
      pageTitle={entry?.title || nav.page?.params?.title || nav.page?.params?.name || ''}
      onPageBack={nav.pop}
    >
      <ErrorBoundary>
        <DataProvider onNavigate={setActiveTab}>
          {entry ? entry.render(nav, nav.page?.params || {}, { setActiveTab }) : renderView()}
          {/* AI 助手浮窗（金融小管家）：全站右下角常驻。
              AI 接管通道未接入时走本地兜底，不假装在线（见 AiChatWidget._askAi）。 */}
          <AiChatWidget />
        </DataProvider>
      </ErrorBoundary>
      <Toast />
    </MobileLayout>
  )
}

export default function App() {
  return (
    <NavProvider>
      <AppShell />
    </NavProvider>
  )
}
