/**
 * App 根组件
 * ------------------------------------------------------------
 * 职责：
 *   1. 两道启动门 —— 隐私政策（PrivacyGate）→ 通知权限（NotifyGate）
 *   2. 页签路由（自选 / 发现 / 持仓 / 我的）+ 基金详情下钻
 *   3. 启动时自动检查更新（热更新静默装；APK 只发横幅通知，由用户自己装）
 *   4. 红点的亮与灭（生命周期定义见 lib/notify.js）
 *   5. 上报开关 —— 同意隐私政策之后才打开
 *
 * 约定：凡是「同意之后才允许发生」的副作用，effect 依赖都挂 `agreed`，
 *      这样同意前不会发出任何请求，也不会打开任何上报。
 */

import { useEffect, useRef, useState } from 'react'
import TabBar from './components/TabBar.jsx'
import PrivacyGate from './components/PrivacyGate.jsx'
import NotifyGate from './components/NotifyGate.jsx'
import { IconBack, IconRefresh } from './components/Icons.jsx'
import { currentBundle, APP_VERSION, enableStats } from './lib/updater.js'
import { bindPullRefresh } from './lib/gestures.js'
import {
  HOT_UPDATE_MANIFEST,
  REMOTE_VERSION_URL,
  STATS_URL,
} from './lib/config.js'
import {
  requestPermission,
  sendTestNotification,
  autoCheckUpdate,
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
import { startUsageTracking } from './lib/usage.js'
import Watch from './views/Watch.jsx'
import Discover from './views/Discover.jsx'
import Holdings from './views/Holdings.jsx'
import SimHoldings from './views/SimHoldings.jsx'
import Me from './views/Me.jsx'
import Detail from './views/Detail.jsx'
import Compare from './views/Compare.jsx'
import Market from './views/Market.jsx'
import Screener from './views/Screener.jsx'

/* 更新与上报的地址统一在 lib/config.js 里维护 —— 换域名只改那一个文件。
   （以前这里和 Me.jsx 各写一份，靠注释提醒「两处都要改」，迟早会漏） */

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
  const [version, setVersion] = useState(APP_VERSION)
  const [updatedTo, setUpdatedTo] = useState(null)
  /* 跨版本升级被卡住：本机原生版本太老，最新界面装不上（见 updater.js 的 minBuild）。
     必须让用户看见 —— 静默跳过的话，他只会觉得「怎么一直不更新」。 */
  const [blocked, setBlocked] = useState(null)
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

  // 启动后对比「这次运行的版本」与「上次记录的版本」。
  // 不一致 = 刚经历了一次热更新 —— 给用户一个明确提示，
  // 否则用户根本不知道自己已经用上新版了。
  useEffect(() => {
    if (!agreed) return
    currentBundle().then((b) => {
      /* ⚠️ 只认「插件真的读到了」的版本，也就是 raw.bundle.version。
         不能拿 b.version —— 它在插件还没准备好时会回退到兜底常量
         APP_VERSION（'1.0.0'）。一旦把这个兜底值写进 seen_bundle_version，
         下次启动一比对就误报「已更新到 vX」：用户什么都没更新却看到更新提示。 */
      // 显示照旧有兜底，保证界面上不会出现空白
      setVersion(b.version || APP_VERSION)

      // 但持久化基线只认真实值：没读到就什么都别记，下次再说
      const real = b?.raw?.bundle?.version
      if (!real) return

      let seen = null
      try {
        seen = localStorage.getItem('seen_bundle_version')
        localStorage.setItem('seen_bundle_version', real)
      } catch {
        // 某些环境 localStorage 不可用，忽略即可
      }
      if (seen && seen !== real) setUpdatedTo(real)
    })
      .catch((e) => {
        // 读版本失败不影响使用 —— 界面上顶多显示兜底版本号，不必打扰用户
        console.warn('[app] 读取当前界面版本失败：', e?.message || e)
      })
  }, [agreed])

  /* 「已更新到 vX」提示条：最多 5 秒自动关掉。
     它只是「你已经在用新版了」的一句告知，不值得占着屏幕等用户来点。
     手动点「知道了」仍然可以立即关。
     ⚠️ 5 秒是上限，不是「等 5 秒」—— 淡出动画从 4.6 秒开始（见 app.css
        的 .callout.auto-hide），到 5 秒正好消失。 */
  useEffect(() => {
    if (!updatedTo) return
    const t = setTimeout(() => setUpdatedTo(null), 5000)
    return () => clearTimeout(t)
  }, [updatedTo])

  // 启动时自动更新：
  //   ① 热更新 —— 发现新版直接下载并切换（set 立即重启），用户什么都不用点
  //   ② APK 大版本 —— Android 不允许静默安装，只能发横幅通知让用户自己点
  useEffect(() => {
    if (!agreed) return
    autoCheckUpdate({
      hotManifestUrl: HOT_UPDATE_MANIFEST,
      remoteVersionUrl: REMOTE_VERSION_URL,
    }).then((r) => {
      /* ⚠️ 必须回头刷一次：红点状态在 App 挂载时就定了，
         而 autoCheckUpdate 是挂载之后才发通知的 —— 不刷的话，
         这次启动弹的横幅要等到**下次启动**才在页签上显示红点。
         （autoCheckUpdate 若触发热更新重启，这行不会执行，无妨） */
      setDotTabs(dottedTabs())
      if (r?.blocked) setBlocked(r)
    })
      .catch((e) => {
        // 检查更新失败不该影响使用 —— 网络差、COS 抖动都可能发生
        console.warn('[app] 启动检查更新失败：', e?.message || e)
      })
  }, [agreed])

  // 点「有新版本」横幅 → 直接跳「我的」页，省得用户自己找「检查更新」
  useEffect(() => {
    if (!agreed) return
    let remove = () => {}
    onNotificationClick((tab) => {
      setTab(tab)
      setDetailCode(null)
      // 他点了通知进来，等于看到了 → 灭掉这个页签的红点
      clearDotsOfTab(tab).then(() => setDotTabs(dottedTabs()))
    }).then((fn) => {
      remove = fn
    })
    return () => remove()
  }, [agreed])

  // 红点的另一条灭法：打开过 App 但没点进去，退出时也算「过了」。
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

  /* ⚠️ 上报开关必须**每次启动**都开一次，不能只在首次同意时开。
     插件会把 url 持久化，重复调用没有副作用。 */
  useEffect(() => {
    if (!agreed) return
    enableStats(STATS_URL)
  }, [agreed])

  // 使用时长 + 电量采集：同意之后才开始记账，退后台时把累计值报上去
  useEffect(() => {
    if (!agreed) return
    startUsageTracking(STATS_URL)
  }, [agreed])

  // 第一道门：隐私政策同意后，紧接着问通知权限（只在首次问一次）
  function handleAgree() {
    setConsent()
    // 同意之后才开启上报（合规：同意前不收集）
    enableStats(STATS_URL)
    setAgreed(true)
    if (!hasAskedNotify()) setAskNotify(true)
  }

  // 点「忍心拒绝」—— 与正常 App 表现一致，直接结束进程
  async function handleDecline() {
    try {
      const { App } = await import('@capacitor/app')
      await App.exitApp()
    } catch (e) {
      console.warn('[privacy] 结束进程失败：', e?.message || e)
    }
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
    return <PrivacyGate onAgree={handleAgree} onDecline={handleDecline} />
  }

  // 第二道门：通知权限说明（只在首次问一次，不反复打扰）
  if (askNotify) {
    return <NotifyGate onAllow={allowNotify} onDeny={denyNotify} busy={busy} />
  }

  // 二级页（基金详情 / 模拟账本 / 对比 / 大盘）共用同一个返回按钮
  const SUB_HEADS = {
    compare: { t: '多基金对比', s: '并排看区间与风险' },
    market: { t: '大盘指数', s: '五大指数 · 实时' },
    screener: { t: '全市场筛选', s: '排行 + 分位/回撤三轨' },
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
        {/* 有新版本一律走系统横幅通知（见 notify.js），不在 App 内堆提示条 */}

        {blocked ? (
          <div className="callout warn callout-row">
            <span>
              这个界面版本需要更新的安装包（build {blocked.needBuild} 以上），
              先装好安装包才会继续更新界面。
            </span>
            <button
              className="btn btn-primary btn-sm"
              style={{ flex: 'none' }}
              onClick={() => switchTab('me')}
            >
              去升级
            </button>
          </div>
        ) : null}

        {updatedTo ? (
          <div className="callout teal auto-hide callout-row">
            <span>已更新到 v{updatedTo}</span>
            <button
              className="btn btn-ghost btn-sm"
              style={{ flex: 'none' }}
              onClick={() => setUpdatedTo(null)}
            >
              知道了
            </button>
          </div>
        ) : null}

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
  )
}
