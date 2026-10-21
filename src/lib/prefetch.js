// src/lib/prefetch.js · 后台分层预抓取（M1）
// ------------------------------------------------------------
// 规划原文（整体规划 M1）：「恢复全量净值抓取：启动读本地 + 后台分层抓 +
// WiFi+充电全量」。这里按 prototype 的实时抓架构落地：
//
//   分层（优先级从高到低）：
//     L1 真实持仓 + 模拟持仓 —— 用户的钱，必须最先有完整历史
//     L2 自选池 + 发现页候选池 —— 打开就能看
//     L3 全市场排行前 N（默认关闭，用户自己开）—— 给筛选/对比预热
//
//   触发条件（全部满足才跑）：
//     ① 开关打开（「我的 → 数据预抓取」，默认开）
//     ② 仅 WiFi 时必须是 WiFi（默认开）
//     ③ 仅充电时必须在充电（默认关）
//     ④ 距上次抓取 ≥ 6 小时（避免每次启动都抓）
//
//   其它约定：
//     - 每只间隔 600ms，最多抓 L1+L2+L3 共 maxFunds 只，避免打爆接口
//     - 只写 navCache（净值历史），不碰账本
//     - 单只失败跳过，不中断整批
//     - 全部在后台跑，界面不阻塞

import { Capacitor } from '@capacitor/core'
import { loadRealHoldings } from './realLedger.js'
import { loadSimHoldings } from './simLedger.js'
import { fetchFundCached, loadNavCache } from './navCache.js'
import { fetchFundRank } from './screener.js'

const PREFS_KEY = 'prefetch_prefs'
const LAST_KEY = 'prefetch_last'
const MIN_GAP = 6 * 60 * 60 * 1000 // 两次自动预抓取最小间隔
const STEP_DELAY = 600

/* 与 Watch / Discover 保持一致的静态池（页面里是硬编码，这里同源维护） */
const WATCH_POOL = ['040001', '110010', '000021', '100038']
const DISCOVER_POOL = ['040001', '110010', '000021', '100038', '001594', '519674']

const DEFAULT_PREFS = {
  enabled: true,
  wifiOnly: true,
  chargingOnly: false,
  includeMarket: false, // L3 全市场排行，默认关
  maxFunds: 24,
}

/** 读预抓取设置 */
export function loadPrefetchPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null')
    return { ...DEFAULT_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

/** 存预抓取设置（局部更新） */
export function savePrefetchPrefs(patch) {
  const next = { ...loadPrefetchPrefs(), ...patch }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  } catch {
    // 忽略
  }
  return next
}

/** 上次预抓取结果 {at, ok, fail, total} */
export function lastPrefetch() {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) || 'null')
  } catch {
    return null
  }
}

/* ---------------- 条件判断 ---------------- */

async function readNetwork() {
  try {
    const { Network } = await import('@capacitor/network')
    const s = await Network.getStatus()
    return { connected: !!s?.connected, type: s?.connectionType || 'unknown' }
  } catch {
    // 浏览器 / 插件不可用：按在线处理
    return { connected: true, type: 'unknown' }
  }
}

async function readBattery() {
  try {
    const { Device } = await import('@capacitor/device')
    const b = await Device.getBatteryInfo()
    return { charging: !!b?.isCharging, level: b?.batteryLevel ?? null }
  } catch {
    return { charging: false, level: null }
  }
}

/**
 * 判断当前是否满足自动预抓取条件（不发起抓取）
 * @returns {Promise<{ok:boolean, reason:string, net?:object, battery?:object}>}
 */
export async function prefetchGate() {
  const prefs = loadPrefetchPrefs()
  if (!prefs.enabled) return { ok: false, reason: '已关闭自动预抓取' }

  const net = await readNetwork()
  if (!net.connected) return { ok: false, reason: '当前无网络', net }
  if (prefs.wifiOnly && net.type !== 'wifi' && net.type !== 'unknown') {
    return { ok: false, reason: '仅 WiFi 时抓取（当前是移动网络）', net }
  }

  const battery = await readBattery()
  if (prefs.chargingOnly && !battery.charging) {
    return { ok: false, reason: '仅充电时抓取（当前未充电）', net, battery }
  }

  const last = lastPrefetch()
  if (last?.at && Date.now() - last.at < MIN_GAP) {
    return { ok: false, reason: '6 小时内已抓过', net, battery }
  }

  return { ok: true, reason: '', net, battery }
}

/* ---------------- 分层取目标 ---------------- */

function uniq(list) {
  const seen = new Set()
  const out = []
  for (const c of list) {
    if (!c || seen.has(c)) continue
    seen.add(c)
    out.push(c)
  }
  return out
}

/** L1：真实持仓 + 模拟持仓 */
export function layer1Codes() {
  const real = (loadRealHoldings() || []).map((r) => r.code)
  const sim = (loadSimHoldings() || []).map((r) => r.code)
  return uniq([...real, ...sim])
}

/** L2：自选池 + 发现页候选池 */
export function layer2Codes() {
  return uniq([...WATCH_POOL, ...DISCOVER_POOL])
}

/** L3：全市场排行前 N（按近一年涨幅，真实排行接口） */
export async function layer3Codes(n = 30) {
  try {
    const rows = await fetchFundRank({ page: 1, size: n, sort: '1nzf', order: 'desc' })
    return uniq((rows || []).map((r) => r.code))
  } catch {
    return []
  }
}

/** 模块级并发锁：同一时刻只允许一个预抓取批次在跑（null = 空闲） */
let inflight = null

/**
 * 执行一次分层预抓取
 * @param {{onProgress?: (p:{done:number,total:number,code:string,layer:number})=>void,
 *          force?: boolean, includeMarket?: boolean, signal?: AbortSignal}} opts
 * @returns {Promise<{ok:number, fail:number, total:number, skipped:number, layers:object}>}
 */
export async function runPrefetch({ onProgress, force = false, includeMarket, signal } = {}) {
  /* 同一时刻只允许一个批次跑：App 就绪与设置页「立即抓取」可能同时触发，
     叠加会让按只节流失效、请求翻倍。第二次调用直接复用第一次的 Promise。 */
  if (inflight) return inflight

  const aborted = () => signal?.aborted === true
  const emit = (payload) => {
    if (aborted()) return
    onProgress?.(payload)
  }

  const run = (async () => {
    const prefs = loadPrefetchPrefs()
    const wantMarket = includeMarket ?? prefs.includeMarket

  const l1 = layer1Codes()
  const l2 = layer2Codes().filter((c) => !l1.includes(c))
  const l3 = wantMarket ? (await layer3Codes(30)).filter((c) => !l1.includes(c) && !l2.includes(c)) : []

  /* maxFunds 必须夹紧：设置面板是下拉，但 localStorage 能被手改成 5000，
     那样一个批次就是 50 分钟的后台抓取。上限 60 只，下限 1 只。 */
  const maxFunds = Math.min(60, Math.max(1, Number(prefs.maxFunds) || 24))
  const rawQueue = [...l1, ...l2, ...l3].slice(0, maxFunds)
  let queue = rawQueue

  /* 非强制模式下，24 小时内抓过的不再重复抓（省流量） */
  if (!force) {
    queue = rawQueue.filter((code) => {
      const hit = loadNavCache(code)
      return !hit || Date.now() - hit.at > 24 * 60 * 60 * 1000
    })
  }

  const skipped = rawQueue.length - queue.length
  const total = queue.length
  let ok = 0
  let fail = 0

    for (let i = 0; i < queue.length; i++) {
      if (aborted()) break
      const code = queue[i]
      try {
        emit({ done: i, total, code, layer: l1.includes(code) ? 1 : l2.includes(code) ? 2 : 3 })
        const series = await fetchFundCached(code, { force: true })
        if (series && series.length) ok++
        else fail++
      } catch {
        fail++
      }
      if (aborted()) break
      if (i < queue.length - 1) await new Promise((r) => setTimeout(r, STEP_DELAY))
    }

    const result = {
      at: Date.now(),
      ok,
      fail,
      total,
      skipped,
      layers: { l1: l1.length, l2: l2.length, l3: l3.length },
      native: Capacitor.isNativePlatform(),
    }
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(result))
    } catch {
      // 忽略
    }
    emit({ done: total, total, code: '', layer: 0 })
    return result
  })()

  inflight = run
  try {
    return await run
  } finally {
    inflight = null
  }
}

/**
 * 启动时的自动预抓取（条件不满足就静默跳过，不打扰用户）
 * @returns {Promise<{ran:boolean, reason?:string, result?:object}>}
 */
export async function autoPrefetch() {
  const gate = await prefetchGate()
  if (!gate.ok) return { ran: false, reason: gate.reason }
  const result = await runPrefetch({})
  return { ran: true, result }
}
