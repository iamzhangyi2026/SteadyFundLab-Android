/**
 * 本地通知
 * ------------------------------------------------------------
 * 用途：App 没打开时主动提醒（例如基金涨跌到阈值、关注的位置进入低估区）。
 *
 * ⚠️ 两条原则：
 *
 * 1. 通知权限必须在「用户主动点击」时请求，不要一打开 App 就弹。
 *    一上来就弹权限框，用户大概率点拒绝，而且拒绝后就很难再要回来
 *    （Android 13+ 拒绝两次后系统不再弹窗，只能去设置里手动开）。
 *
 * 2. 通知只用于「用户真正关心的事」（涨跌阈值、估值洼地、定投到期），
 *    不做任何版本更新类打扰。
 */

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
      description: '自选基金变动与估值提醒',
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
  /* 与 checkPermission 保持一致：插件在部分 ROM 上会抛，
     不 catch 会让「开启通知」按钮直接崩掉页面。 */
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const r = await LocalNotifications.requestPermissions()
    return r.display
  } catch (e) {
    console.warn('[notify] requestPermissions 失败：', e?.message || e)
    return 'unknown'
  }
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
   红点（App 内指示器）—— 通用机制
   ------------------------------------------------------------------
   红点不只跟着版本更新走，各类通知共用同一套规则。

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
  priceMove: 'watch', // 自选基金涨跌 → 自选
  undervalued: 'discover', // 估值洼地 → 发现
  rebalance: 'holdings', // 再平衡提醒 → 持仓
}

/**
 * 通知类型 → 固定通知 id（同一类复用一个 id，反复检查不会堆通知）
 * ⚠️ 每类必须独占一个 id：id 相同 = 后发的覆盖先发的
 *    （曾经再平衡与持仓预警共用 200，再平衡会把持仓预警顶掉，
 *      红点亮着但点进去看不到想看的内容）。
 */
const NOTIFICATION_ID = {
  priceMove: 200,
  undervalued: 300,
  rebalance: 400,
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
    /* 事件名必须是 'localNotificationActionPerformed'：写成 'actionPerformed'
       插件不认，监听器永远不会被调用。
       插件端 retainUntilConsumed = true，所以 App 没运行时点通知、
       事件发生在 JS 加载之前，也会保留下来补发。 */
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
