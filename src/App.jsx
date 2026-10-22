/**
 * App 根组件
 * ------------------------------------------------------------
 * 职责：
 *   1. 两道启动门 —— 隐私政策（PrivacyGate）→ 通知权限（NotifyGate）
 *   2. 页签路由（自选 / 发现 / 持仓 / 我的）+ 基金详情下钻
 *   3. 红点的亮与灭（生命周期定义见 lib/notify.js）
 *
 * 全部功能都在本机：不检查版本、不联网上报任何设备/使用数据。
 */

import { useEffect, useRef, useState } from 'react'
import TabBar from './components/TabBar.jsx'
import PrivacyGate from './components/PrivacyGate.jsx'
import NotifyGate from './components/NotifyGate.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { IconBack, IconRefresh } from './components/Icons.jsx'
import { bindPullRefresh } from './lib/gestures.js'
import {
  requestPermission,
  sendTestNotification,
  onNotificationClick,
  dottedTabs,
  clearDotsOfTab,
  clearAllDots,
} from './lib/notify.js'
import {
  getConsent,
  setConsent,
  hasAskedNotify,
  markNotifyAsked,
} from './lib/consent.js'
import { autoPrefetch } from './lib/prefetch.js'
import Watch from './views/Watch.jsx'
import Discover from './views/Discover.jsx'
import Holdings from './views/Holdings.jsx'
import SimHoldings from './views/SimHoldings.jsx'
import Me from './views/Me.jsx'
import Detail from './views/Detail.jsx'
import Compare from './views/Compare.jsx'
import Market from './views/Market.jsx'
import Screener from './views/Screener.jsx'

/* 界面版本号（显示在标题栏与「我的」页）。改版本时与 build.gradle 的
   versionName 一起改。 */
const APP_VERSION = '2.5'

const HEADS = {
  watch: { t: '基金沙盒', s: '' },
  discover: { t: '发现', s: '找估值洼地' },
  holdings: { t: '持仓', s: '我的记录' },
  me: { t: '我的', s: '设置与关于' },
}

export default function App() {
  // 正规流程两道门，各只在首次问一次：① 隐私政策 → ② 通知权限
  const [agreed, setAgreed] = useState(() => !!getConsent())
  const [askNotify, setAskNotify] = useState(false)
  const [busy, setBusy] = useState(false)
  // 默认落在「持仓」—— 页签第一位是真实持仓，打开就看到自己的钱
  const [tab, setTab] = useState('holdings')
  // 红点：哪些页签有新消息（更新的 → 我的；以后涨跌提醒 → 自选，等等）
  const [dotTabs, setDotTabs] = useState(() => dottedTabs())
  const [detailCode, setDetailCode] = useState(null)
  /* 从哪儿点进来的：holding（真实持仓）/ watch（自选）/ discover（发现）。
     真实持仓是「已经买了的」，点开只看表现与资讯，不显示定投回测、
     费率试算、记录模拟买入这些「买之前才用得上」的工具。 */
  const [detailFrom, setDetailFrom] = useState('watch')
  function openDetail(code, from = 'watch') {
    setDetailFrom(from)
    setDetailCode(code)
  }
  // 模拟账本是独立页面（不进页签），从「自选」页的入口进
  const [simOpen, setSimOpen] = useState(false)
  /* 二级工具页（不进页签）：'compare' 多基金对比 / 'market' 大盘指数。
     从「发现」页进入，沿用详情页同一套返回逻辑，不新增底部 Tab。 */
  const [subPage, setSubPage] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const version = APP_VERSION
  const bodyRef = useRef(null)
  const pullRef = useRef(null)

  /* 系统返回键 / 全面屏返回手势 —— 交给系统，不在 Web 层仿一套。
     Android 的边缘返回手势会由系统转发成 Capacitor 的 backButton 事件：
     二级页（基金详情 / 模拟账本）返回上一级，一级页照常退出。
     自己再监听边缘滑动会与系统手势打架（页面跟着手指横移 + 系统同时返回）。 */
  useEffect(() => {
    let handle = null
    let alive = true
    ;(async () => {
      try {
        const { App } = await import('@capacitor/app')
        handle = await App.addListener('backButton', ({ canGoBack }) => {
          if (detailCode) {
            setDetailCode(null)
            return
          }
          if (simOpen) {
            setSimOpen(false)
            return
          }
          if (subPage) {
            setSubPage(null)
            return
          }
          if (canGoBack) {
            window.history.back()
            return
          }
          App.exitApp()
        })
        if (!alive) handle?.remove?.()
      } catch {
        // 浏览器环境没有返回键
      }
    })()
    return () => {
      alive = false
      try {
        handle?.remove?.()
      } catch {
        // 忽略
      }
    }
  }, [detailCode, simOpen, subPage])

  /* 下拉刷新：手势只在根容器上监听一次；
     「刷新什么」由当前页面通过全局事件 app:pull-refresh 决定（见 lib/usePullRefresh.js）。 */
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    return bindPullRefresh(el, pullRef.current, () => {
      window.dispatchEvent(new CustomEvent('app:pull-refresh'))
    })
  }, [])

  /* 后台分层预抓取：启动 8 秒后检查条件（开关 / WiFi / 充电 / 6 小时间隔），
     满足才跑，不阻塞首屏。结果写 navCache，页面下次打开直接有历史数据。 */
  useEffect(() => {
    if (!agreed) return
    const t = setTimeout(() => {
      autoPrefetch().catch((e) => console.warn('[prefetch] 自动预抓取失败：', e?.message || e))
    }, 8000)
    return () => clearTimeout(t)
  }, [agreed])

  // 点通知进来 → 跳到对应页签
  useEffect(() => {
    if (!agreed) return
    let remove = () => {}
    let disposed = false
    onNotificationClick((tab) => {
      setTab(tab)
      setDetailCode(null)
      // 他点了通知进来，等于看到了 → 灭掉这个页签的红点
      clearDotsOfTab(tab).then(() => setDotTabs(dottedTabs()))
    }).then((fn) => {
      remove = fn
      // 卸载发生在 promise resolve 之后：立刻摘掉，避免监听永久残留
      if (disposed) {
        try {
          fn()
        } catch {
          // 忽略
        }
      }
    })
    return () => {
      disposed = true
      remove()
    }
  }, [agreed])

  // 红点的另一条灭法：打开过 App 但没点进去，退出时也算已经看过
  useEffect(() => {
    if (!agreed) return
    let remove = () => {}
    ;(async () => {
      try {
        const { App } = await import('@capacitor/app')
        const h = await App.addListener('appStateChange', (state) => {
          if (state?.isActive) return
          setDotTabs([])
          clearAllDots()
        })
        remove = () => {
          try {
            h.remove()
          } catch {
            // 忽略
          }
        }
      } catch {
        // 浏览器环境没有前后台事件，忽略
      }
    })()
    return () => remove()
  }, [agreed])

  // 第一道门：隐私政策同意后，紧接着问通知权限（只在首次问一次）
  function handleAgree() {
    setConsent()
    setAgreed(true)
    if (!hasAskedNotify()) setAskNotify(true)
  }

  async function allowNotify() {
    setBusy(true)
    try {
      const r = await requestPermission()
      if (r === 'granted') await sendTestNotification()
    } catch (e) {
      console.warn('[notify] 请求权限失败：', e?.message || e)
    } finally {
      setBusy(false)
      markNotifyAsked()
      setAskNotify(false)
    }
  }

  function denyNotify() {
    markNotifyAsked()
    setAskNotify(false)
  }

  function switchTab(next) {
    setSimOpen(false)
    setSubPage(null)
    setTab(next)
    setDetailCode(null)
    // 点进某个页签 = 用户看到红点指向的东西了 → 灭掉它
    clearDotsOfTab(next).then(() => setDotTabs(dottedTabs()))
    document.querySelector('.app-body')?.scrollTo({ top: 0 })
  }

  // 第一道门：未同意隐私政策 —— 不进入 App，看不到任何界面
  if (!agreed) {
    return (
      <ErrorBoundary>
        <PrivacyGate onAgree={handleAgree} />
      </ErrorBoundary>
    )
  }

  // 第二道门：通知权限说明（只在首次问一次，不反复打扰）
  if (askNotify) {
    return (
      <ErrorBoundary>
        <NotifyGate onAllow={allowNotify} onDeny={denyNotify} busy={busy} />
      </ErrorBoundary>
    )
  }

  // 二级页（基金详情 / 模拟账本 / 对比 / 大盘）共用同一个返回按钮
  const SUB_HEADS = {
    compare: { t: '多基金对比', s: '并排看区间与风险' },
    market: { t: '大盘指数', s: '五大指数 · 实时' },
    screener: { t: '全市场筛选', s: '排行 + 位置/下跌三轨' },
  }
  const goBack = detailCode
    ? () => setDetailCode(null)
    : simOpen
      ? () => setSimOpen(false)
      : subPage
        ? () => setSubPage(null)
        : null

  const head = detailCode
    ? { t: '基金详情', s: detailCode }
    : simOpen
      ? { t: '模拟账本', s: `练手记录 · v${version}` }
      : subPage
        ? SUB_HEADS[subPage]
        : {
            ...HEADS[tab],
            s: HEADS[tab].s ? `${HEADS[tab].s} · v${version}` : `v${version}`,
          }

  return (
    <ErrorBoundary>
      <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          {goBack ? (
            <button className="header-btn" onClick={goBack} aria-label="返回">
              <IconBack />
            </button>
          ) : null}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="app-title">{head.t}</div>
            {head.s ? <div className="app-sub">{head.s}</div> : null}
          </div>

          {!detailCode && !simOpen && !subPage && tab === 'watch' ? (
            <button
              className="header-btn"
              onClick={() => setRefreshKey((k) => k + 1)}
              aria-label="刷新"
            >
              <IconRefresh />
            </button>
          ) : null}
        </div>
      </header>

      <main className="app-body" ref={bodyRef}>
        {/* 下拉刷新指示器：位置/位移由 lib/gestures.js 控制 */}
        <div className="pull-indicator" ref={pullRef}>
          <span className="pull-spinner" />
          <span className="pull-text">下拉刷新</span>
        </div>
        {detailCode ? (
          <Detail code={detailCode} from={detailFrom} />
        ) : simOpen ? (
          <SimHoldings />
        ) : subPage === 'compare' ? (
          <Compare onOpen={(c) => openDetail(c, 'compare')} />
        ) : subPage === 'market' ? (
          <Market />
        ) : subPage === 'screener' ? (
          <Screener onOpen={(c) => openDetail(c, 'discover')} />
        ) : tab === 'watch' ? (
          <Watch
            key={refreshKey}
            onOpen={(c) => openDetail(c, 'watch')}
            onDiscover={() => switchTab('discover')}
            onSimLedger={() => setSimOpen(true)}
          />
        ) : tab === 'discover' ? (
          <Discover onOpen={(c) => openDetail(c, 'discover')} onNavigate={setSubPage} />
        ) : tab === 'holdings' ? (
          <Holdings onOpenFund={(c) => openDetail(c, 'holding')} />
        ) : (
          <Me />
        )}
      </main>

      {!detailCode && !simOpen && !subPage && <TabBar active={tab} onChange={switchTab} dots={dotTabs} />}
      </div>
    </ErrorBoundary>
  )
}
