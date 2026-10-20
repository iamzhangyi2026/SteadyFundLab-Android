/**
 * 使用时长 + 电量消耗采集
 * ------------------------------------------------------------
 * 目的：评估 App 在上的耗电情况（用于排查「太费电」这类反馈）。
 *
 * 五条设计规则（重要，别改坏）：
 *   1. 只在「进前台 / 退后台」各读一次电量，前台期间**不轮询** ——
 *      拿高频采样去测耗电，等于测量手段自己变成耗电大户。
 *   2. **充电时不记账**（那时电量在涨，数据没有意义）。
 *   3. 只存**聚合值**：累计前台毫秒 + 累计掉电百分比。
 *      不存时间戳序列 —— 不记录"几点用了多久"，避免变成作息画像。
 *   4. **后台不记账**（本来就没有后台任务，记也是 0）。
 *   5. 上报走**独立 POST**（见 reportUsage）。
 *      （ 改版：原本打算借 Capgo 插件的 custom_id 字段搭车，
 *        走正规通道 —— 自己发一个请求，不借用别人的字段。）
 *
 * ⚠️ 口径说明：这里记的是「整机在这段时间掉了多少电」，
 *    不是「本 App 单独耗多少电」—— 前台期间微信、系统也在耗电。
 *    所以要多台多天平均后才有参考价值，单次数值噪声大。
 */

import { currentBundle } from './updater.js'
import { isNative } from './platform.js'

const FG_MS_KEY = 'usage_foreground_ms'
const DROP_KEY = 'usage_battery_drop'
const T1_KEY = 'usage_t1'
const B1_KEY = 'usage_b1'
const C1_KEY = 'usage_c1' // 进前台时是否在充电

/** 读电量与充电状态；失败或非原生环境返回 null */
async function readBattery() {
  if (!isNative()) return null
  try {
    const { Device } = await import('@capacitor/device')
    const info = await Device.getBatteryInfo()
    if (!info || typeof info.batteryLevel !== 'number') return null
    return { level: info.batteryLevel, charging: !!info.isCharging }
  } catch (e) {
    console.warn('[usage] 读取电量失败：', e?.message || e)
    return null
  }
}

/** 累加聚合值（掉电量按百分比 0~100 存） */
function accumulate(ms, dropPercent) {
  try {
    const prevMs = parseInt(localStorage.getItem(FG_MS_KEY) || '0', 10) || 0
    const prevDrop = parseFloat(localStorage.getItem(DROP_KEY) || '0') || 0
    localStorage.setItem(FG_MS_KEY, String(prevMs + ms))
    localStorage.setItem(DROP_KEY, String(prevDrop + dropPercent))
  } catch {
    // localStorage 不可用时忽略
  }
}

/** 进前台：记下起始时间与电量 */
async function onForeground() {
  const b = await readBattery()
  try {
    localStorage.setItem(T1_KEY, String(Date.now()))
    if (b) {
      localStorage.setItem(B1_KEY, String(b.level))
      localStorage.setItem(C1_KEY, b.charging ? '1' : '0')
    } else {
      localStorage.removeItem(B1_KEY)
      localStorage.removeItem(C1_KEY)
    }
  } catch {
    // 忽略
  }
}

/** 退后台：结算本次前台会话 */
async function onBackground() {
  const b = await readBattery()
  try {
    const t1 = parseInt(localStorage.getItem(T1_KEY) || '0', 10)
    const b1 = parseFloat(localStorage.getItem(B1_KEY) || '')
    const c1 = localStorage.getItem(C1_KEY) === '1'

    // 清掉本次会话的临时值，避免重复结算
    localStorage.removeItem(T1_KEY)
    localStorage.removeItem(B1_KEY)
    localStorage.removeItem(C1_KEY)

    if (!t1 || !b || !Number.isFinite(b1)) return
    // 规则 2：充电时不记账（进前台或退后台任一时刻在充电都跳过）
    if (c1 || b.charging) return

    const ms = Date.now() - t1
    if (ms <= 0) return

    const drop = (b1 - b.level) * 100
    // 电量只降不升才合理；出现负数说明中途充过电，舍弃
    if (drop <= 0) {
      accumulate(ms, 0)
      return
    }
    accumulate(ms, drop)
  } catch {
    // 忽略
  }
}

/**
 * 启动采集（App 启动时调一次即可）
 * ------------------------------------------------------------
 * 监听前后台切换。用 @capacitor/app 的 appStateChange。
 * @param {string} [statsUrl] - 上报地址（SCF 函数 URL）。不传就只采集不上报。
 */
export async function startUsageTracking(statsUrl) {
  if (!isNative()) return
  try {
    const { App } = await import('@capacitor/app')
    await App.addListener('appStateChange', (state) => {
      if (state?.isActive) {
        onForeground()
      } else {
        // 退后台：先结算本次前台会话，再把累计值报上去
        onBackground().then(() => reportUsage(statsUrl))
      }
    })
    // App 启动时本身就是前台，补记一次起点
    onForeground()
  } catch (e) {
    console.warn('[usage] 无法监听前后台切换：', e?.message || e)
  }
}

/**
 * 读取聚合结果（供上报使用）
 * @returns {{ foregroundMs: number, batteryDropPercent: number, perHour: number|null }}
 */
function getUsageStats() {
  let ms = 0
  let drop = 0
  try {
    ms = parseInt(localStorage.getItem(FG_MS_KEY) || '0', 10) || 0
    drop = parseFloat(localStorage.getItem(DROP_KEY) || '0') || 0
  } catch {
    // 忽略
  }
  const hours = ms / 3600000
  return {
    foregroundMs: ms,
    batteryDropPercent: Math.round(drop * 100) / 100,
    // 每前台小时掉电百分比 —— 这是最终用于评估的指标
    perHour: hours > 0 ? Math.round((drop / hours) * 100) / 100 : null,
  }
}

/**
 * 把聚合值上报到 SCF（独立 POST）
 * ------------------------------------------------------------
 * 只发两个聚合值：累计前台毫秒 + 累计掉电百分比。
 * 不发时间戳序列 —— 不记录「几点用了多久」，避免变成作息画像。
 *
 * ⚠️ 失败一律静默：上报是为了排查 BUG 和评估耗电，
 *    不能因为上报失败影响用户的正常使用。
 *
 * @param {string} [statsUrl] - SCF 函数 URL
 */
export async function reportUsage(statsUrl) {
  if (!isNative() || !statsUrl) return false

  const s = getUsageStats()
  // 一条数据都还没攒到就不发（免得给 COS 塞一堆 0）
  if (!s.foregroundMs) return false

  let deviceId = ''
  let bundleVersion = ''
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    const d = await CapacitorUpdater.getDeviceId()
    // ⚠️ 字段名是 deviceId，不是 identifier（踩过：写错就全落到 unknown 一个文件里）
    deviceId = d?.deviceId || ''
  } catch {
    // 拿不到就留空，SCF 端用 unknown 兜底
  }
  try {
    // 用 updater.js 里封装好的版本 —— 插件的 currentBundle() 返回 { currentBundle: {...} }，
    // 直接读 .version 会是 undefined（版本号一直是空的坑）
    const b = await currentBundle()
    bundleVersion = b?.version || ''
  } catch {
    // 忽略
  }

  try {
    await fetch(statsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'usage_report',
        device_id: deviceId || 'unknown',
        bundle_version: bundleVersion,
        foreground_ms: s.foregroundMs,
        battery_drop_percent: s.batteryDropPercent,
      }),
    })
    return true
  } catch (e) {
    console.warn('[usage] 上报失败：', e?.message || e)
    return false
  }
}
