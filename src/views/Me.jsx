/**
 * 「我的」页 —— 版本 / 通知 / 隐私 / 关于 / 各类设置
 * ------------------------------------------------------------
 * 内容：
 *   ① 版本信息 —— 界面版本 + 本机安装包 build（读 Capacitor App.getInfo）
 *   ② 通知设置 / 隐私政策 / 关于
 *   ③ 显示（深色）/ 预警 / 定投 / 再平衡 / 目标 / AI 设置 / 导入导出
 *
 * 本页不联网检查版本，版本号仅作展示。
 */

import { useEffect, useState } from 'react'
import { App } from '@capacitor/app'
import { isNative } from '../lib/platform.js'
import {
  checkPermission,
  requestPermission,
  sendTestNotification,
  clearDotsOfTab,
} from '../lib/notify.js'
import NotifyGate from '../components/NotifyGate.jsx'
import Privacy from './Privacy.jsx'
import About from './About.jsx'
import { ThemeRow, AlertPanel, IoPanel, PrefetchPanel } from '../components/SettingsPanels.jsx'
import { RebalancePanel } from '../components/PortfolioPanels.jsx'
import GoalPanel from '../components/GoalPanel.jsx'
import DingtouPlanPanel from '../components/DingtouPlanPanel.jsx'
import { LlmSettingsPanel } from '../components/AiPanel.jsx'
import { loadRealHoldings } from '../lib/realLedger.js'
import { fromRealRow, decorate } from '../lib/holdingsModel.js'

/* 界面版本（纯展示，不参与任何更新判断）。改版本时与 build.gradle 的
   versionName 一起改。 */
const APP_VERSION = '2.5'

const NOTIFY_PREFS_KEY = 'notify_prefs'

/* 这里只放用户真正需要选择的提醒类型。 */
const NOTIFY_ITEMS = [
  { key: 'priceMove', label: '基金涨跌提醒', desc: '自选基金单日涨跌超过设定幅度时提醒' },
  { key: 'undervalued', label: '估值洼地提醒', desc: '关注的基金跌进历史低位置时提醒' },
]

function loadPrefs() {
  try {
    const raw = localStorage.getItem(NOTIFY_PREFS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // 忽略
  }
  return { priceMove: true, undervalued: true }
}

export default function Me() {
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [perm, setPerm] = useState('prompt')
  const [prefs, setPrefs] = useState(loadPrefs)
  /* 本机安装包信息（App.getInfo 的 version / build）。
     0 / '' = 还没读到，界面显示「—」，不拿硬编码值冒充。 */
  const [installed, setInstalled] = useState(0)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showNotifyGate, setShowNotifyGate] = useState(false)

  useEffect(() => {
    checkPermission().then(setPerm)

    // 能进到这一页，说明红点已经把用户带到了它指向的地方 → 灭掉
    clearDotsOfTab('me')

    // 读本机安装包真实 versionCode（Capacitor 官方 API，不涉及任何更新检查）
    ;(async () => {
      try {
        const info = await App.getInfo()
        const b = Number(info?.build) || 0
        if (b) setInstalled(b)
      } catch (e) {
        console.warn('[me] 读取本机版本失败：', e?.message || e)
      }
    })()
  }, [])

  function togglePref(key) {
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    try {
      localStorage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(next))
    } catch {
      // 忽略
    }
  }

  /* ---------------- 通知权限 ---------------- */
  async function enableNotify() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await requestPermission()
      setPerm(r)
      if (r === 'granted') {
        await sendTestNotification()
        setMsg({ type: 'ok', text: '通知已开启，几秒后会收到一条测试通知' })
      } else {
        setMsg({
          type: 'info',
          text: '没有拿到通知权限。Android 13 及以上如果拒绝过两次，系统就不再弹窗，需要去「系统设置 → 应用 → 基金沙盒 → 通知」里手动打开。',
        })
      }
    } finally {
      setBusy(false)
    }
  }

  async function testNotify() {
    await sendTestNotification()
    setMsg({ type: 'ok', text: '测试通知已发出' })
  }

  const runningVersion = APP_VERSION
  const alertHoldings = decorate(loadRealHoldings().map(fromRealRow))

  const permText =
    perm === 'granted'
      ? '已开启'
      : perm === 'denied'
        ? '已被拒绝（需去系统设置里手动开）'
        : perm === 'unsupported'
          ? '浏览器环境不支持'
          : '未开启'

  const notifyOn = perm === 'granted'

  if (showPrivacy) {
    return <Privacy onBack={() => setShowPrivacy(false)} />
  }

  if (showAbout) {
    return <About onBack={() => setShowAbout(false)} />
  }

  /* 通知权限引导弹窗：点「开启」先弹本说明窗，用户确认后才调系统权限框 */
  if (showNotifyGate) {
    return (
      <NotifyGate
        busy={busy}
        onAllow={async () => {
          await enableNotify()
          setShowNotifyGate(false)
        }}
        onDeny={() => setShowNotifyGate(false)}
      />
    )
  }

  return (
    <>
      <div className="section-title">版本</div>
      <div className="card plain card-list">
        <Row k="当前版本" v={`${runningVersion}（build ${installed || '—'}）`} />
        <Row k="运行环境" v={isNative() ? 'App' : '浏览器'} />
        <Row k="包名" v="com.fundapp" />
        <Row k="最低系统" v="Android 7.0" />
      </div>

      {msg && (
        <div
          className={
            'callout' +
            (msg.type === 'error' ? ' danger' : msg.type === 'ok' ? ' teal' : '')
          }
          style={{ whiteSpace: 'pre-line' }}
        >
          {msg.text}
        </div>
      )}

      {/* ---------------- 通知设置 ---------------- */}
      <div className="section-title">通知设置</div>

      <div className="card plain card-list">
        <div
          className={'fund-row fund-row-static' + (notifyOn ? '' : ' fund-row-noline')}
        >
          <div className="fund-main">
            <div className="fund-name fund-name-normal">
              通知权限
            </div>
            <div className="fund-meta">{permText}</div>
          </div>
          {notifyOn ? (
            <button className="btn btn-sm" style={{ flex: 'none' }} onClick={testNotify}>
              发测试通知
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              style={{ flex: 'none' }}
              onClick={() => setShowNotifyGate(true)}
              disabled={busy || perm === 'unsupported'}
            >
              开启
            </button>
          )}
        </div>

        {NOTIFY_ITEMS.map((it, i) => (
          <div
            className="fund-row"
            key={it.key}
            style={{
              cursor: 'default',
              borderBottom: i === NOTIFY_ITEMS.length - 1 ? 0 : undefined,
              opacity: notifyOn ? 1 : 0.5,
            }}
          >
            <div className="fund-main">
              <div className="fund-name fund-name-normal">
                {it.label}
              </div>
              <div className="fund-meta" style={{ whiteSpace: 'normal' }}>
                {it.desc}
              </div>
            </div>
            <button
              className={prefs[it.key] && notifyOn ? 'switch on' : 'switch'}
              onClick={() => togglePref(it.key)}
              disabled={!notifyOn}
              aria-label={it.label}
            />
          </div>
        ))}
      </div>

      <div className="card">
        <div className="callout">
          通知权限可以随时在系统设置里关闭。本 App 不上传任何数据，
          通知只用于你开启的提醒（涨跌 / 估值洼地 / 定投到期）。
        </div>
      </div>

      {/* ---------------- 显示 ---------------- */}
      <div className="section-title">显示</div>
      <div className="card plain card-list">
        <ThemeRow />
      </div>

      {/* ---------------- 数据预抓取 ---------------- */}
      <PrefetchPanel />

      {/* ---------------- 预警 ---------------- */}
      <AlertPanel holdings={alertHoldings} />

      {/* ---------------- 组合工具 ---------------- */}
      <DingtouPlanPanel />
      <RebalancePanel holdings={alertHoldings} />
      <GoalPanel />

      {/* ---------------- AI 设置（密钥用户自填） ---------------- */}
      <LlmSettingsPanel />

      {/* ---------------- 导入 / 导出 ---------------- */}
      <IoPanel />

      {/* ---------------- 其他 ---------------- */}
      <div className="section-title">其他</div>
      <div className="card plain card-list">
        <div
          className="fund-row"
          style={{ cursor: 'pointer' }}
          onClick={() => setShowAbout(true)}
        >
          <div className="fund-main">
            <div className="fund-name fund-name-normal">关于</div>
          </div>
          <div className="fund-meta fund-meta-end">应用信息 ›</div>
        </div>
        <div
          className="fund-row"
          style={{ cursor: 'pointer', borderBottom: 0 }}
          onClick={() => setShowPrivacy(true)}
        >
          <div className="fund-main">
            <div className="fund-name fund-name-normal">隐私政策</div>
          </div>
          <div className="fund-meta fund-meta-end">全文 ›</div>
        </div>
      </div>

      <div className="card">
        <div className="callout teal">
          不需要注册、不需要登录。它只做一件事：用你的手机网络去公开接口取数据，存在本机。
        </div>
      </div>

      {/* ---------------- 免责声明 ---------------- */}
      <div className="card">
        <div className="callout warn" style={{ lineHeight: 1.7 }}>
          <strong>免责声明</strong>：本 App 提供的基金数据来自公开接口，费率试算、
          位置统计等功能<strong>仅用于学习与策略验证</strong>，
          不构成任何投资建议。据此操作，风险自负。
        </div>
      </div>

      <p className="card-note" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        基金沙盒 · 纯客户端版
      </p>
    </>
  )
}

function Row({ k, v }) {
  return (
    <div className="fund-row fund-row-static">
      <div className="fund-main">
        <div className="fund-name fund-name-normal">
          {k}
        </div>
      </div>
      <div className="fund-meta fund-meta-end">
        {v}
      </div>
    </div>
  )
}
