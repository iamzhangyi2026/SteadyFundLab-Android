/**
 * networkStatus.js · WiFi + 充电 状态检测
 * ----------------------------------------------------------------
 * 用途：判断是否满足「全量抓取」的硬条件（全市场约 2.4 万只，抓取慢、吃流量、耗电）
 *
 * 来源：
 *   - WiFi：@capacitor/network（已装）
 *   - 充电：Web Battery API（Android WebView 原生支持 navigator.getBattery）
 *
 * 兼容性：
 *   - 无 getBattery（部分老旧 WebView / 测试环境）→ 仅看 WiFi，reason 文案明确告知
 *   - 动态订阅：网络变化 / 充电插拔自动回调（零轮询，事件驱动）
 *
 * 使用：
 *   const s = await getNetworkAndBatteryStatus()
 *   if (s.onWifi && s.charging) → 满足条件，可触发全量抓取
 *
 *   const cleanup = await subscribeNetworkAndBattery((s) => { ... })
 *   // 组件卸载时 cleanup()
 */
import { Network } from '@capacitor/network'

/**
 * 检测 Web Battery API 是否可用
 */
function hasBatteryApi() {
  return typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function'
}

/**
 * 单次检查 WiFi + 充电状态
 * @returns {Promise<{
 *   onWifi: boolean,         // 是否连 WiFi
 *   charging: boolean,       // 是否在充电（getBattery 不可用时为 false）
 *   batterySupported: boolean, // 浏览器是否支持 getBattery
 *   reason: string,          // 人话版当前状态说明（中文）
 * }>}
 */
export async function getNetworkAndBatteryStatus() {
  // ── WiFi 状态 ──
  let onWifi = false
  try {
    const status = await Network.getStatus()
    onWifi = !!(status.connected && status.connectionType === 'wifi')
  } catch (e) {
    console.warn('[networkStatus] Network.getStatus 失败:', e?.message || e)
  }

  // ── 充电状态（Web Battery API） ──
  let charging = false
  let batterySupported = false
  if (hasBatteryApi()) {
    try {
      const b = await navigator.getBattery()
      charging = !!b.charging
      batterySupported = true
    } catch (e) {
      console.warn('[networkStatus] navigator.getBattery 失败:', e?.message || e)
    }
  }

  // ── 人话版 reason ──
  // 正常状态沉默（双满足），异常才显示提示
  let reason = null
  if (!batterySupported) {
    if (!onWifi) reason = '等连上无线网络并充电后，会自动更新基金数据'
  } else if (!onWifi || !charging) {
    reason = '等连上无线网络并充电后，会自动更新基金数据'
  }

  return { onWifi, charging, batterySupported, reason }
}

/**
 * 订阅网络 / 充电变化（事件驱动，零轮询）
 * @param {(status: {onWifi: boolean, charging: boolean, batterySupported: boolean}) => void} onChange
 * @returns {Promise<() => void>} 取消订阅函数
 */
export async function subscribeNetworkAndBattery(onChange) {
  const cleanups = []

  // ── 网络变化 ──
  try {
    const handle = await Network.addListener('networkStatusChange', async () => {
      try {
        const cur = await getNetworkAndBatteryStatus()
        onChange(cur)
      } catch (e) {
        console.warn('[networkStatus] onChange (network) 失败:', e?.message || e)
      }
    })
    cleanups.push(() => handle.remove())
  } catch (e) {
    console.warn('[networkStatus] Network.addListener 失败:', e?.message || e)
  }

  // ── 充电变化 ──
  if (hasBatteryApi()) {
    try {
      const b = await navigator.getBattery()
      const fire = async () => {
        try {
          const cur = await getNetworkAndBatteryStatus()
          onChange(cur)
        } catch (e) {
          console.warn('[networkStatus] onChange (battery) 失败:', e?.message || e)
        }
      }
      b.addEventListener('chargingchange', fire)
      b.addEventListener('levelchange', fire)
      cleanups.push(() => {
        b.removeEventListener('chargingchange', fire)
        b.removeEventListener('levelchange', fire)
      })
    } catch (e) {
      console.warn('[networkStatus] getBattery 失败:', e?.message || e)
    }
  }

  return () => cleanups.forEach((fn) => { try { fn() } catch (_) { /* ignore */ } })
}
