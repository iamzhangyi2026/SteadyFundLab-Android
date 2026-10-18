/**
 * 触发式自动刷新 — 充电 + WiFi + 夜间时段 + 每日一次 + 后台执行
 * ------------------------------------------------------------
 * 设计原则：
 *   1. 零轮询，零 setInterval。
 *   2. 只在「充电插拔」「网络切换」「进入后台」三个原生事件触发时检查条件。
 *   3. 必须同时满足以下全部条件才触发全量抓取：
 *      ① 连 WiFi          @capacitor/network
 *      ② 正在充电         navigator.getBattery()（不可用时降级，仅看 WiFi）
 *      ③ 夜间时段         local time ∈ [nightStartHour, nightEndHour)（config.ts 可配）
 *      ④ 每日一次          pool_meta.last_full_refresh_date 不等于今天
 *      ⑤ App 在后台       App.getState().isActive === false
 *      ⑥ 主开关打开       FULL_MARKET_CONFIG.ENABLE_FULL_MARKET_REFRESH = true
 *   4. 任一条件不满足 → 静默跳过，不打扰用户。
 *
 * 触发路径：
 *   ┌──────────────────────────────────────────────────────┐
 *   │  系统广播 ACTION_POWER_CONNECTED/DISCONNECTED         │
 *   │       ↓  PowerMonitor.PowerReceiver                  │
 *   │       ↓  notifyListeners('onCharging', {...})        │
 *   │  JS 侧 onCharging → checkAndMaybeRefresh()           │
 *   │  JS 侧 networkStatusChange → checkAndMaybeRefresh()  │
 *   │  JS 侧 appStateChange（进入后台）→ checkAndMaybeRefresh│
 *   └──────────────────────────────────────────────────────┘
 */
import { isNative } from './platform.js'
import {
  refreshFundPool,
  refreshNavPool,
  startBackgroundRefresh,
  stopBackgroundRefresh,
  isNightWindow,
  _loadCfg,
} from './dataAdapter.js'

let isCharging = false
let isWifiConnected = false
let isAppInForeground = true   // 默认前台（App 刚启动）
let initialized = false
let isInitializing = false     // init 期间禁止 autoRefresh，避免与主流程竞争限流接口

/**
 * 设置初始化状态（由 init_app.ts 在 fetch 前后调用）
 */
export function setIsInitializing(val) {
  isInitializing = !!val
}

/**
 * 核心决策：所有条件满足 → 触发一次全量刷新
 * 任何条件不满足 → 静默返回，不打扰用户
 */
export async function checkAndMaybeRefresh(store) {
  if (!isNative()) return
  if (!store) return
  if (isInitializing) {
    console.log('[autoRefresh] 初始化中，跳过刷新')
    return
  }
  // ① WiFi + ② 充电（充电不可用则降级为只看 WiFi）
  if (!isWifiConnected) {
    console.log('[autoRefresh] 未连 WiFi，跳过')
    return
  }
  if (!isCharging) {
    console.log('[autoRefresh] 未在充电，跳过')
    return
  }
  // ③ 夜间时段（local time）
  let cfg = null
  try { cfg = await _loadCfg() } catch (_) { /* ignore */ }
  if (!cfg) { console.log('[autoRefresh] 配置加载失败，跳过'); return }
  const night = await isNightWindow(cfg)
  if (!night) { console.log('[autoRefresh] 非夜间时段，跳过'); return }
  // ⑤ App 不在前台才跑
  if (isAppInForeground) {
    console.log('[autoRefresh] App 在前台，跳过全量刷新')
    return
  }

  console.log('[autoRefresh] 触发全量刷新: 充电=' + isCharging + ' WiFi=' + isWifiConnected + ' 夜间=' + cfg.nightStartHour + 'h')
  // 开前台服务保活：否则 App 在后台时 WebView 的 JS 会被系统冻结，抓取跑不起来
  await startBackgroundRefresh()
  try {
    const r = await refreshFundPool()
    if (!r.ok) {
      console.warn('[autoRefresh] 全量刷新失败:', r.error)
    } else {
      console.log('[autoRefresh] 全量刷新完成:', r.data?.note)
    }
    // 分层抓取第 ⑤ 层：列表抓完接着补净值（后台慢速推进，天然断点续抓）
    const navR = await refreshNavPool(2000)
    console.log('[autoRefresh] 净值补全:', JSON.stringify(navR?.data ?? navR))
  } catch (e) {
    console.warn('[autoRefresh] 全量刷新异常:', e?.message || e)
  } finally {
    await stopBackgroundRefresh()
  }
}

/**
 * 监听充电状态变化（通过 MainActivity 中的 BroadcastReceiver 触发 'onCharging' 事件）。
 */
export function startChargingListener(store) {
  if (!isNative()) return
  try {
    import('@capacitor/core').then(({ registerPlugin }) => {
      const PowerMonitor = registerPlugin('PowerMonitor')
      PowerMonitor.start().catch(e =>
        console.warn('[autoRefresh] PowerMonitor.start 失败:', e?.message || e)
      )
      PowerMonitor.addListener('onCharging', (data) => {
        const wasCharging = isCharging
        isCharging = !!data?.charging
        console.log('[autoRefresh] 充电状态变更:', isCharging)
        if (isCharging !== wasCharging) checkAndMaybeRefresh(store)
      })
      // 启动时立即读取当前充电状态（作为初始值）
      import('@capacitor/device').then(({ Device }) => {
        Device.getBatteryInfo().then((info) => {
          isCharging = !!info?.isCharging
          console.log('[autoRefresh] 初始充电状态:', isCharging)
          checkAndMaybeRefresh(store)
        }).catch(e =>
          console.warn('[autoRefresh] 读取初始电量失败:', e?.message || e)
        )
      })
    })
  } catch (e) {
    console.warn('[autoRefresh] 无法注册充电监听:', e?.message || e)
  }
}

/**
 * 监听网络状态变化（@capacitor/network 原生支持）。
 */
export function startNetworkListener(store) {
  if (!isNative()) return
  try {
    import('@capacitor/network').then(({ Network }) => {
      Network.addListener('networkStatusChange', async (status) => {
        const wasWifi = isWifiConnected
        isWifiConnected = status.connectionType === 'wifi'
        console.log('[autoRefresh] 网络变更:', status.connectionType, 'WiFi:', isWifiConnected)

        // 从 WiFi 切走 → 停止
        if (wasWifi && !isWifiConnected) {
          console.log('[autoRefresh] WiFi 断开，停止自动刷新')
          return
        }
        // 刚连上 WiFi → 触发一次刷新（如果正在充电且在后台夜间）
        if (!wasWifi && isWifiConnected) {
          checkAndMaybeRefresh(store)
        }
      })

      // 启动时立即读取当前网络状态
      Network.getStatus().then((status) => {
        isWifiConnected = status.connectionType === 'wifi'
        console.log('[autoRefresh] 初始网络状态:', status.connectionType, 'WiFi:', isWifiConnected)
        checkAndMaybeRefresh(store)
      }).catch(e => {
        console.warn('[autoRefresh] 读取初始网络状态失败:', e?.message || e)
      })
    })
  } catch (e) {
    console.warn('[autoRefresh] 无法注册网络监听:', e?.message || e)
  }
}

/**
 * 监听 App 前后台切换：
 *   - 进前台  → isAppInForeground=true（停止全量刷新）
 *   - 进后台  → isAppInForeground=false（允许后台执行全量刷新）
 */
export function startAppLifecycleListener(store) {
  if (!isNative()) return
  try {
    import('@capacitor/app').then(({ App }) => {
      App.addListener('appStateChange', (state) => {
        const wasForeground = isAppInForeground
        isAppInForeground = !!state?.isActive
        console.log('[autoRefresh] App 状态:', isAppInForeground ? '前台' : '后台')
        if (!wasForeground && isAppInForeground) {
          // 从后台进入前台 → 停止全量刷新，不触发
          console.log('[autoRefresh] App 进入前台，暂停全量刷新')
        } else if (wasForeground && !isAppInForeground) {
          // 从前台进入后台 → 检查条件，可能触发全量刷新
          console.log('[autoRefresh] App 进入后台，检查刷新条件')
          checkAndMaybeRefresh(store)
        }
      })
    })
  } catch (e) {
    console.warn('[autoRefresh] 无法注册前后台监听:', e?.message || e)
  }
}

/**
 * 启动所有监听器（在 App.jsx 首次渲染后调用一次）。
 * @param {import('./store/useStore.js').UseStoreActions} store
 */
export function startAutoRefreshTriggers(store) {
  if (initialized) return
  initialized = true
  isInitializing = true  // 启动监听时默认锁定，等 init 完成后再解锁

  console.log('[autoRefresh] 启动触发式自动刷新')
  startChargingListener(store)
  startNetworkListener(store)
  startAppLifecycleListener(store)
}
