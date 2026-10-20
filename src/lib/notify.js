/**
 * 本地通知
 * ------------------------------------------------------------
 * 用途：App 没打开时主动提醒（例如基金涨跌到阈值、关注的分位进入低估区）。
 *
 * ⚠️ 两条原则：
 *
 * 1. 通知权限必须在「用户主动点击」时请求，不要一打开 App 就弹。
 *    一上来就弹权限框，用户大概率点拒绝，而且拒绝后就很难再要回来
 *    （Android 13+ 拒绝两次后系统不再弹窗，只能去设置里手动开）。
 *
 * 2. 热更新不需要通知权限。它在启动时自动下载并切换，
 *    不弹任何东西 —— 这是热更新最大的优势：不打扰用户。
 */

// 静态导入：autoCheckUpdate 需要用到，动态导入会和别处的静态导入冲突（打包器会警告）
// installedBuild 不在这里用 —— 版本比对统一在 checkRemoteVersion 里做，避免两处各算一套
import { checkRemoteVersion, checkHotUpdate } from './updater.js'
import { isNative } from './platform.js'

/* ------------------------------------------------------------------
   通知渠道 —— Android 8+ 必须走渠道
   ------------------------------------------------------------------
   插件默认渠道 importance = 3（IMPORTANCE_DEFAULT）：
   通知只进抽屉、不弹横幅、没声音 —— 用户根本看不见。
   要「像正常通知一样横条幅弹出」，必须自己建 importance = 4 的渠道
   （IMPORTANCE_HIGH：heads-up 横幅 + 声音）。
   ------------------------------------------------------------------ */
const CHANNEL_ID = 'fund_default'

async function ensureChannel() {
  if (!isNative()) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: '基金提醒',
      description: '新版本提醒与自选基金变动提醒',
      importance: 4, // IMPORTANCE_HIGH —— 横幅弹出
      visibility: 1,
      sound: 'default',
      vibration: true,
    })
  } catch (e) {
    console.warn('[notify] 创建通知渠道失败：', e?.message || e)
  }
}

/** 查当前权限状态：granted / denied / prompt */
export async function checkPermission() {
  if (!isNative()) return 'unsupported'
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const r = await LocalNotifications.checkPermissions()
    return r.display
  } catch (e) {
    console.warn('[notify] checkPermissions 失败：', e?.message || e)
    return 'unknown'
  }
}

/** 请求权限 —— 只能在用户点击时调用 */
export async function requestPermission() {
  if (!isNative()) return 'unsupported'
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  const r = await LocalNotifications.requestPermissions()
  return r.display
}

/**
 * 发一条通知（用于验证权限是否真的生效）
 * ------------------------------------------------------------
 * ⚠️ 这里刻意**不做任何定时**。
 *
 * 「什么时候该推送」和「系统定时」是两件事：
 *   - 定时抓取数据：App 内部的 JS 逻辑（setTimeout / 后台任务），跟通知 API 无关
 *   - 推送通知：条件满足了，就立刻发这一条 —— 是即时动作
 *
 * 如果用 schedule / at，插件会走系统的 AlarmManager，
 * Flyme、ColorOS 这类 ROM 就会弹「闹钟和提醒」授权页，跟用户预期完全不符。
 */
export async function sendTestNotification() {
  if (!isNative()) return false
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  await ensureChannel()

  const base = {
    id: 1,
    title: '基金沙盒',
    body: '通知已开启。以后有重要变化会在这里提醒你。',
    channelId: CHANNEL_ID,
    isExactNotification: false,
  }

  try {
    // 首选：不带 schedule，立即发
    await LocalNotifications.schedule({ notifications: [base] })
    return true
  } catch (e) {
    // 降级：某些版本要求必须带 at。给一个「立刻」的时间点，
    // 同样不带精确闹钟，不会触发「闹钟和提醒」授权页。
    try {
      await LocalNotifications.schedule({
        notifications: [{ ...base, schedule: { at: new Date(Date.now() + 300) } }],
      })
      return true
    } catch (e2) {
      console.warn('[notify] 发送测试通知失败：', e2?.message || e2)
      return false
    }
  }
}

/* ------------------------------------------------------------------
   启动时自动更新
   ------------------------------------------------------------------
    改版：打开 App 就刷新，看有没有热更新。

     ① 热更新（改界面 / 逻辑）—— 自动下载并切换，用户什么都不用点。
        切换必须用 set()（立即生效并重启）：next() 在无效
        （插件日志仍显示 Built-in bundle is active）。
        重启发生在启动早期、用户还没开始操作时，几乎无感；
        重启后版本已一致，不会再重启 —— 不会死循环。

     ② APK 大版本（改图标 / 插件 / 权限）—— Android 不允许 App 静默安装
        （除非系统签名或设备管理器权限，普通 App 没有）。
        所以只能提示：发横幅通知，点通知直接进「我的」页，
        由用户自己点下载 + 在系统安装页点确认。

   ⚠️ 不再做 1 小时节流 —— 每次启动都检查。
      代价是每次启动多两个小请求（latest.json / version.json）。
   ------------------------------------------------------------------ */

/* APK 更新结果持久化：Me.jsx 读同一个 key 显示「安装包有新版本」 */
const APK_PENDING_KEY = 'pending_apk_update'
/* 已经弹过横幅的 APK build —— 只在「读不到本机 versionCode」时兜底。
   ⚠️ 为什么不能拿硬编码常量去比（本项目历史上用 APP_BUILD = 1）：
      硬编码值恒为 1，而 version.json 里的 build 是手动递增的（3/4/5…），
      checkRemoteVersion 的 hasNew 永远为 true。取消启动节流之后，
      照它判断就是每次启动都弹一条横幅 —— 那是骚扰。

   ⚠️ 主判据是**本机真实 versionCode**（installedBuild），不是这个 key：
      用「本机已装的 build」比对有个关键好处 —— 它是自愈的。
      如果拿「上次提示过」比对，用户划掉了横幅、或者下载装到一半失败，
      标记已经写下去了，之后就再也不会提醒，这个大版本等于漏掉。
      拿 versionCode 比：装成功 → 号码追平 → 自然不再提示；
      没装成 → 号码没追平 → 下次启动继续提醒。
      （通知 id 是固定的，重复提醒会覆盖同一条，不会堆成一排） */
const APK_NOTIFIED_KEY = 'apk_notified_build'
/* ------------------------------------------------------------------
   红点（App 内指示器）—— 通用机制，不只对「更新」生效
   ------------------------------------------------------------------
   ：「红点不一定只是更新才有哦，其它通知，同样的规则。」

   生命周期（对所有类型一视同仁）：
     新通知产生 → 对应页签亮红点
     用户点进那个页签 → 灭
     用户打开 App 但没点，退出 App → 也灭
     下次新通知 → 再亮

   加一种新通知只需要两件事：
     1. 在 DOT_TARGET 里登记「类型 → 该跳去哪个页签」
     2. 在 NOTIFICATION_ID 里给它一个固定的通知 id（同类通知互相覆盖，不堆）
   然后发通知时调 markDot(type) 即可，红点逻辑自动跟上。
   ------------------------------------------------------------------ */

/** 通知类型 → 点进去该跳到哪个页签 */
const DOT_TARGET = {
  update: 'me', // 有新版 → 我的
  priceMove: 'watch', // 自选基金涨跌 → 自选
  undervalued: 'discover', // 估值洼地 → 发现
}

/** 通知类型 → 固定通知 id（同一类复用一个 id，反复检查不会堆通知） */
const NOTIFICATION_ID = {
  update: 100,
  priceMove: 200,
  undervalued: 300,
}

/* 持久化到 localStorage：红点要跨启动存在 ——
   系统把通知划掉了不代表用户看过，得自己记。 */
const DOT_KEY = 'pending_dots'

function readDots() {
  try {
    const raw = JSON.parse(localStorage.getItem(DOT_KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function writeDots(list) {
  try {
    if (list.length) localStorage.setItem(DOT_KEY, JSON.stringify(list))
    else localStorage.removeItem(DOT_KEY)
  } catch {
    // 忽略
  }
}

/** 发通知之后调用：给这个类型点亮红点 */
function markDot(type) {
  if (!DOT_TARGET[type]) return
  const list = readDots()
  if (!list.includes(type)) {
    list.push(type)
    writeDots(list)
  }
}

/** 当前有哪些页签该显示红点 */
export function dottedTabs() {
  const tabs = readDots().map((t) => DOT_TARGET[t]).filter(Boolean)
  return [...new Set(tabs)]
}

/** 关掉指定 id 的系统通知（桌面角标随之消失） */
async function cancelNotifications(ids) {
  if (!isNative() || !ids.length) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.cancel({
      notifications: ids.map((id) => ({ id })),
    })
  } catch (e) {
    console.warn('[notify] 清除通知失败：', e?.message || e)
  }
}

/**
 * 用户点进了某个页签 → 灭掉它的红点 + 关掉对应通知
 * @param {string} tab - 页签 key，如 'me'
 */
export async function clearDotsOfTab(tab) {
  const all = readDots()
  const hit = all.filter((t) => DOT_TARGET[t] === tab)
  writeDots(all.filter((t) => DOT_TARGET[t] !== tab))
  await cancelNotifications(hit.map((t) => NOTIFICATION_ID[t]).filter(Boolean))
}

/** 退出 App 时调用：打开过就算看过了，全部灭掉 */
export async function clearAllDots() {
  const all = readDots()
  writeDots([])
  await cancelNotifications(all.map((t) => NOTIFICATION_ID[t]).filter(Boolean))
}

/**
 * 启动时自动更新
 * @param {string} hotManifestUrl - 热更新清单地址
 * @param {string} remoteVersionUrl - APK 版本清单地址（可选）
 * @returns {Promise<{blocked?: boolean, needBuild?: number, reason?: string}>}
 *          blocked = 本机原生版本太低，界面已拒绝更新，必须先装新 APK
 */
export async function autoCheckUpdate({ hotManifestUrl, remoteVersionUrl } = {}) {
  if (!isNative()) return {}
  if (typeof localStorage === 'undefined') return {}

  let hot = null

  try {
    // ① 先查 APK —— 只是网络请求，不会重启 App。
    //    结果写进 localStorage，因为第 ② 步随时可能把 App 重启掉。
    if (remoteVersionUrl) {
      try {
        const r = await checkRemoteVersion(remoteVersionUrl)
        // 远端 build 与本机 versionCode 都由 checkRemoteVersion 算好一并返回
        const remote = r?.remoteBuild || 0
        const installed = r?.installed || 0

        let notified = 0
        try {
          notified = parseInt(localStorage.getItem(APK_NOTIFIED_KEY) || '0', 10) || 0
        } catch {
          // 忽略
        }
        // 读不到 versionCode 时（插件异常）才退回「上次提示过的 build」，
        // 否则以 versionCode 为准 —— 装成功就不提示，没装成就继续提示。
        const base = installed || notified

        if (remote > 0 && remote > base) {
          /* ⚠️ pending 只在「确实有新版待装」时才写。
             以前是无条件写，于是装完之后这个 key 还留着旧 build ——
             虽然 Me.jsx 会拿它跟 versionCode 比一遍、不会误显示，
             但一旦 versionCode 读不到（返回 0），陈旧值就会被当成「有新版本」，
             把用户引到一个装了也没用的安装页。 */
          try {
            localStorage.setItem(APK_PENDING_KEY, JSON.stringify(r.remote))
            localStorage.setItem(APK_NOTIFIED_KEY, String(remote))
          } catch {
            // 忽略
          }
          await sendUpdateNotification({ apkNew: r.remote })
        } else {
          // 没有待装的新版 → 清掉陈旧标记
          try {
            localStorage.removeItem(APK_PENDING_KEY)
          } catch {
            // 忽略
          }
        }
      } catch (e) {
        console.warn('[notify] 检查安装包版本失败：', e?.message || e)
      }
    }

    // ② 热更新放最后 —— 它可能触发 set() 立即重启 App，之后的代码不执行。
    //    checkHotUpdate 内部会先比对版本号，不比本机新就不装（含挡住降级），不会重复重启。
    if (hotManifestUrl) {
      hot = await checkHotUpdate(hotManifestUrl)
    }
  } catch (e) {
    console.warn('[notify] 自动更新失败：', e?.message || e)
  }

  /* ⚠️ blocked 只在「没触发重启」时才传得回来 —— 而 blocked 本身就意味着没装、
     不会重启，所以这个返回值是可靠的。
     交给 App.jsx 显示提示条：光静默跳过的话，用户只觉得「怎么一直不更新」。 */
  return {
    blocked: !!hot?.blocked,
    needBuild: hot?.needBuild || 0,
    reason: hot?.reason || '',
  }
}

/**
 * 发「安装包有新版本」横幅通知
 * ------------------------------------------------------------
 * 只管 APK —— 热更新已经静默装了，不需要打扰用户。
 */
async function sendUpdateNotification({ apkNew }) {
  if (!isNative() || !apkNew) return
  /* ⚠️ 关键：没授权就别发。
     否则 schedule() 会触发系统权限弹窗，跟 App 内的通知说明弹窗撞在一起 ——
     变成「用户还没点 App 上的允许，系统框先弹了」，顺序是错的。
     正确顺序：App 内说明 → 用户点「开启」→ 才调系统权限框；
     点「暂不开启」→ 系统框根本不该出现。 */
  const perm = await checkPermission()
  if (perm !== 'granted') return

  const { LocalNotifications } = await import('@capacitor/local-notifications')
  await ensureChannel()

  await LocalNotifications.schedule({
    notifications: [
      {
        id: NOTIFICATION_ID.update,
        title: '基金沙盒有新版本',
        /* ⚠️ 用 build 号，不要用 version 字段 ——
           version.json 的 version 恒为 "1.0"（那是内置包版本），
           真正递增的是 build。写 version 会显示成「安装包 v1.0 已就绪」，
           看着像在说「版本 1.0」，其实要装的是 build 7，误导。 */
        body: `安装包 build ${apkNew.build} 已就绪，点这里去更新`,
        channelId: CHANNEL_ID,
        // 点了直接跳「我的」页 —— 省得用户自己找「检查更新」
        extra: { go: DOT_TARGET.update },
        // 不带 schedule —— 立即发；不精确闹钟，不会弹 Flyme 的「闹钟和提醒」
        isExactNotification: false,
      },
    ],
  })

  // 通知发出去了 → 红点亮起（App 内要能指出是哪个功能）
  markDot('update')
}

/** 按通知 id 反查它是哪种类型 */
function dotTypeOfId(id) {
  return Object.keys(NOTIFICATION_ID).find((t) => NOTIFICATION_ID[t] === id)
}

/**
 * 监听「通知被点击」—— 回调里拿到该跳去的页签
 * ------------------------------------------------------------
 * 通用：不管哪种通知，点进来都交给调用方跳对应页签，
 * 这样以后加新通知类型不用改这里。
 *
 * @param {(tab: string) => void} handler - 收到该跳去的页签 key
 * @returns {Promise<() => void>} 取消监听的函数
 */
export async function onNotificationClick(handler) {
  const noop = () => {}
  if (!isNative()) return noop
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    /* ⚠️ 事件名必须是 'localNotificationActionPerformed'。
       曾经写成 'actionPerformed' —— 那个名字插件根本不认，
       监听器永远不会被调用，表现为「点通知毫无反应、红点也不灭」。
       （ 发现，翻插件定义确认：
         node_modules/@capacitor/local-notifications/dist/esm/definitions.d.ts）

       插件端 notifyListeners(..., retainUntilConsumed = true)，
       所以 App 没运行时点通知、事件发生在 JS 加载之前，也会保留下来补发。 */
    const handle = await LocalNotifications.addListener('localNotificationActionPerformed', (ev) => {
      const n = ev?.notification
      if (!n) return
      // 优先用通知自带的 go，没有就按 id 反查
      const tab = n.extra?.go || DOT_TARGET[dotTypeOfId(n.id)]
      if (tab) handler(tab)
    })
    return () => {
      try {
        handle.remove()
      } catch {
        // 忽略
      }
    }
  } catch (e) {
    console.warn('[notify] 监听通知点击失败：', e?.message || e)
    return noop
  }
}

/**
 * 发一条业务提醒（涨跌 / 估值洼地）
 * ------------------------------------------------------------
 * 与「测试通知」分开：这里用固定 id，同类提醒互相覆盖，不会堆成一排。
 * 没授权就静默返回 false —— 绝不在用户没点过「开启」时弹系统权限框。
 *
 * @param {{type?: 'priceMove'|'undervalued', title?: string, body?: string}} p
 */
export async function sendFundAlert({ type = 'priceMove', title, body } = {}) {
  if (!isNative()) return false
  const perm = await checkPermission()
  if (perm !== 'granted') return false

  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await ensureChannel()
    const id = NOTIFICATION_ID[type] || NOTIFICATION_ID.priceMove
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title: title || '基金沙盒',
          body: body || '',
          channelId: CHANNEL_ID,
          extra: { go: DOT_TARGET[type] || 'watch' },
          isExactNotification: false,
        },
      ],
    })
    markDot(type)
    return true
  } catch (e) {
    console.warn('[notify] 发送业务提醒失败：', e?.message || e)
    return false
  }
}
