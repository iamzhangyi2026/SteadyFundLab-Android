/**
 * 「我的」页 —— 版本 / 更新 / 通知 / 隐私 / 关于
 * ------------------------------------------------------------
 * 三块内容：
 *   ① 版本信息 —— 当前界面版本 + 本机安装包 build
 *   ② 更新 —— 界面更新（热更新，静默自动）与安装包（有新版才出现按钮）
 *   ③ 通知设置 / 隐私政策 / 免责声明
 *
 * ⚠️ 两条容易踩的约定：
 *   1. 凡是要显示「本机 build」的地方，一律用 installedBuild() 读真实 versionCode，
 *      不要用硬编码常量 —— 否则用户装了 build 7 却看到 build 1。
 *   2. 更新地址统一来自 lib/config.js，不在这里另写一份。
 */

import { useEffect, useState } from 'react'
import {
  APP_VERSION,
  currentBundle,
  checkHotUpdate,
  checkRemoteVersion,
  installedBuild,
} from '../lib/updater.js'
import { isNative } from '../lib/platform.js'
import { HOT_UPDATE_MANIFEST, REMOTE_VERSION_URL } from '../lib/config.js'
import {
  checkPermission,
  requestPermission,
  sendTestNotification,
  clearDotsOfTab,
} from '../lib/notify.js'
import {
  openInstallPermission,
  downloadAndInstallApk,
} from '../lib/apkUpdate.js'
import NotifyGate from '../components/NotifyGate.jsx'
import Privacy from './Privacy.jsx'
import { ThemeRow, AlertPanel, IoPanel } from '../components/SettingsPanels.jsx'
import { RebalancePanel } from '../components/PortfolioPanels.jsx'
import GoalPanel from '../components/GoalPanel.jsx'
import DingtouPlanPanel from '../components/DingtouPlanPanel.jsx'
import { LlmSettingsPanel } from '../components/AiPanel.jsx'
import { loadRealHoldings } from '../lib/realLedger.js'
import { fromRealRow, decorate } from '../lib/holdingsModel.js'

const NOTIFY_PREFS_KEY = 'notify_prefs'
/* 待安装的 APK 信息。
   必须持久化：检查热更新时会触发 set() 直接重启 App，
   内存里的状态会丢；重启后靠这个 key 把「有新版可用」的提示恢复出来。 */
const APK_PENDING_KEY = 'pending_apk_update'

/* 界面更新（热更新）不在这里暴露 —— 它默认就是自动的、静默的，
   不需要用户配置。这里只放用户真正需要选择的提醒类型。 */
const NOTIFY_ITEMS = [
  { key: 'priceMove', label: '基金涨跌提醒', desc: '自选基金单日涨跌超过设定幅度时提醒' },
  { key: 'undervalued', label: '估值洼地提醒', desc: '关注的基金跌进历史低分位时提醒' },
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
  const [bundle, setBundle] = useState(null)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [perm, setPerm] = useState('prompt')
  const [prefs, setPrefs] = useState(loadPrefs)
  /* 本机 APK 的 versionCode（App.getInfo().build）。
     ⚠️ 初始值给 0，**不要**给硬编码常量（本项目历史上叫 APP_BUILD，恒为 1）——
        那样装了 build 7 的 APK 却显示 build 1，用户会以为自己没装上。
        0 = 还没读到，界面上显示成「—」，等 installedBuild() 回来再填真值。 */
  const [installed, setInstalled] = useState(0)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [showNotifyGate, setShowNotifyGate] = useState(false)
  const [progress, setProgress] = useState(null)
  const [apkInfo, setApkInfo] = useState(null)
  const [apkBusy, setApkBusy] = useState(false)

  useEffect(() => {
    checkPermission().then(setPerm)

    /* 进页面就把当前界面包版本读出来。
       ⚠️ 以前只在点「检查」时才 setBundle，于是刚进页面时 bundle 是 null，
          `runningVersion` 回退到兜底常量 APP_VERSION（'1.0.0'）——
          结果顶部标题栏写着 v1.0.36，「当前版本」和「界面版本」却显示 1.0.0，
          自相矛盾。（ 截图发现） */
    currentBundle().then(setBundle)

    // 能进到这一页，说明红点已经把用户带到了它指向的地方 → 灭掉
    clearDotsOfTab('me')

    // 恢复「有待安装的 APK」提示。
    // 上次检查时热更新可能直接把 App 重启了，这个提示就没来得及显示。
    ;(async () => {
      const b = await installedBuild()
      if (b) setInstalled(b)
      try {
        const raw = localStorage.getItem(APK_PENDING_KEY)
        if (raw) {
          const info = JSON.parse(raw)
          setApkInfo(Number(info?.build) > b ? info : null)
        }
      } catch {
        // 忽略
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

  /* ---------------- 检查更新 ---------------- */
  async function doCheck() {
    setBusy(true)
    setMsg(null)
    setProgress(null)
    try {
      const b = await currentBundle()
      setBundle(b)

      if (!isNative()) {
        setMsg({ type: 'info', text: '浏览器预览环境，更新检查只在 App 内生效' })
        return
      }
      if (!HOT_UPDATE_MANIFEST && !REMOTE_VERSION_URL) {
        setMsg({ type: 'info', text: '还没配置更新地址' })
        return
      }

      const lines = []

      // ① 先查 APK 更新 —— 只是网络请求，不会重启 App。
      //    结果写进 localStorage，因为第 ② 步随时可能把 App 重启掉。
      if (REMOTE_VERSION_URL) {
        try {
          /* 版本比对统一在 checkRemoteVersion 里做 —— 直接用它的 hasNew，
             不要在这里再算一遍。规则只允许存在一处，否则迟早有地方漏掉
             「读不到 versionCode 时不能声称有新版本」这条判断。 */
          const r = await checkRemoteVersion(REMOTE_VERSION_URL)
          const curBuild = r.installed || 0
          if (curBuild) setInstalled(curBuild)
          const remoteBuild = r.remoteBuild || 0

          if (r.hasNew) {
            try {
              localStorage.setItem(APK_PENDING_KEY, JSON.stringify(r.remote))
            } catch {
              // 忽略
            }
            setApkInfo(r.remote)
            lines.push(`安装包有新版本（build ${remoteBuild}）`)
          } else {
            try {
              localStorage.removeItem(APK_PENDING_KEY)
            } catch {
              // 忽略
            }
            setApkInfo(null)
            // 读不到本机 versionCode 时不要假装「已是最新」—— 那是假信息
            lines.push(curBuild > 0 ? '安装包：已是最新' : '安装包：读不到本机版本号，无法判断')
          }
        } catch (e) {
          lines.push('安装包：检查失败（' + (e?.message || '网络问题') + '）')
        }
      }

      // ② 热更新放最后 —— 它可能触发 set() 立即重启 App，之后的代码不执行
      let blocked = false
      if (HOT_UPDATE_MANIFEST) {
        const r = await checkHotUpdate(HOT_UPDATE_MANIFEST, (p) => setProgress(p))
        blocked = !!r?.blocked
        lines.push(r.updated ? `界面更新：${r.reason}` : `界面：${r.reason}`)
      }

      // blocked = 本机原生版本太老，界面包装不上（跨版本升级）
      setMsg({ type: blocked ? 'error' : 'ok', text: lines.join('\n') })
    } catch (e) {
      setMsg({ type: 'error', text: e?.message || String(e) })
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 下载并安装 APK ---------------- */
  async function installApk() {
    if (!apkInfo?.apk) return
    setApkBusy(true)
    setMsg(null)
    try {
      const r = await downloadAndInstallApk(apkInfo.apk)
      if (r?.ok) {
        setMsg({
          type: 'ok',
          text:
            '安装包已下载，接下来会弹出系统安装界面，点「安装」即可。\n' +
            '⚠️ 安装时本 App 进程会被系统杀掉，装完需要你手动重新打开一次（微信也是这样）。',
        })
      } else if (r?.needPermission) {
        setMsg({
          type: 'info',
          text: '需要先允许「安装未知应用」。已帮你打开系统设置，开完回来再点一次下载。',
        })
        await openInstallPermission()
      } else {
        setMsg({ type: 'error', text: r?.message || '下载失败' })
      }
    } catch (e) {
      setMsg({ type: 'error', text: e?.message || String(e) })
    } finally {
      setApkBusy(false)
    }
  }

  const runningVersion = bundle?.version || APP_VERSION
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

  /* 通知权限引导弹窗。
     ⚠️ 这一段原先漏了 —— showNotifyGate 只被 set 过、从未被读取渲染，
        表现是「点『开启』按钮毫无反应」。补齐后才走通：
        点「开启」→ 弹本说明窗 → 用户点「开启」→ 才调系统权限框。 */
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

      {/* ---------------- ① 界面更新（热更新，静默） ---------------- */}
      <div className="section-title">界面更新</div>
      <div className="card">
        <div className="fund-row fund-row-static fund-row-noline">
          <div className="fund-main">
            <div className="fund-name fund-name-normal">
              界面版本 v{runningVersion}
            </div>
            <div className="fund-meta">打开 App 时自动更新，不用管</div>
          </div>
          <button
            className="btn btn-sm"
            style={{ flex: 'none' }}
            onClick={doCheck}
            disabled={busy}
          >
            {busy ? '检查中…' : '检查'}
          </button>
        </div>

        {progress !== null ? (
          <div className="progress-track">
            <div className="progress-rail">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="progress-cow" style={{ left: `${progress}%` }}>
              🐂
            </span>
          </div>
        ) : null}
      </div>

      {/* ---------------- ② 安装包（改了原生层才需要） ---------------- */}
      <div className="section-title">安装包</div>
      <div className="card">
        <div className="fund-row fund-row-static fund-row-noline">
          <div className="fund-main">
            <div className="fund-name fund-name-normal">
              安装包
              {apkInfo ? (
                <span className="new-tag">有新版本 build {apkInfo.build}</span>
              ) : null}
            </div>
            <div className="fund-meta">
              {apkInfo
                ? `build ${apkInfo.build} 已就绪，装完才有新图标 / 新权限`
                : installed
                  ? `当前 build ${installed} · 已是最新`
                  : '正在读取本机版本…'}
            </div>
          </div>
          {apkInfo ? (
            <button
              className="btn btn-primary btn-sm"
              style={{ flex: 'none' }}
              onClick={installApk}
              disabled={apkBusy}
            >
              {apkBusy ? '下载中…' : '下载并安装'}
            </button>
          ) : null}
        </div>

        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          只有改到原生层（图标 / 插件 / 权限）才需要装。覆盖安装，数据保留。
          装的时候系统会弹确认页 —— Android 不允许 App 自己偷偷装。
        </p>
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
          通知权限可以随时在系统设置里关闭。热更新本身
          <strong>不需要</strong>通知权限 —— 它是静默的，不打扰你。
        </div>
      </div>

      {/* ---------------- 显示 ---------------- */}
      <div className="section-title">显示</div>
      <div className="card plain card-list">
        <ThemeRow />
      </div>

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
          分位统计等功能<strong>仅用于学习与策略验证</strong>，
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
