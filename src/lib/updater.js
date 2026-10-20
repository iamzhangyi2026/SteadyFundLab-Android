/**
 * 应用更新
 * ------------------------------------------------------------
 * 两条路，按「这次改了什么」来分：
 *
 * ① 热更新 —— 只改了界面和逻辑（日常 90% 的改动）
 *    打一个 zip 包传到你的 URL → App 拉下来 → 下次启动生效。
 *    用户无感，不用重装，不用点任何按钮。
 *
 * ② 全量更新 —— 改了原生层（插件 / 权限 / 图标 / targetSdk）
 *    打新 APK 传到你的 URL → App 内提示 → 用户点一下下载覆盖安装。
 *    同签名覆盖安装，数据保留。
 *
 * ⚠️ 托管这些文件 ≠「有服务器」：那里只放 APK 和前端资源包，
 *    不存任何用户数据。用户数据从生成到存储全程在手机上。
 *
 * 本模块对外提供（按调用顺序）：
 *   notifyReady()          启动握手，不调用会被判定为更新失败
 *   currentBundle()        查当前跑的是哪个前端包
 *   compareVersion()       版本号比较（数字逐段，不能字符串比）
 *   checkHotUpdate()       查并安装热更新（含跨版本防线）
 *   installedBuild()       读本机 APK 的 versionCode
 *   enableStats()          打开统计上报（同意隐私政策后）
 *   checkRemoteVersion()   查是否有新安装包（只检查，不安装）
 */

import { isNative } from './platform.js'

/** 读不到版本号时的兜底值。
 *  ⚠️ 只用于「显示」—— 绝不能把它当成真实版本写进持久化基线，
 *     否则下次启动会误报「已更新到 vX」（踩过，见 App.jsx 的注释）。 */
export const APP_VERSION = '1.0.0'

/* ------------------------------------------------------------------
   ① 启动握手
   ------------------------------------------------------------------
   热更新插件要求 App 启动后尽快调用 notifyAppReady()。
   不调用的话，原生层会判定「这次更新启动失败」并自动回滚到旧版本。
   ------------------------------------------------------------------ */
export async function notifyReady() {
  if (!isNative()) return
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    await CapacitorUpdater.notifyAppReady()
  } catch (e) {
    console.warn('[updater] notifyAppReady 失败：', e?.message || e)
  }
}

/* ------------------------------------------------------------------
   ② 查当前装的是哪个前端包
   ------------------------------------------------------------------ */
export async function currentBundle() {
  if (!isNative()) return { version: APP_VERSION, native: false }
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    const cur = await CapacitorUpdater.current()
    return { version: cur?.bundle?.version || APP_VERSION, native: true, raw: cur }
  } catch (e) {
    return { version: APP_VERSION, native: true, error: e?.message || String(e) }
  }
}

/* ------------------------------------------------------------------
   ③ 版本号比较 —— 跨版本升级的前提
   ------------------------------------------------------------------
   ⚠️ 不能拿字符串比（=== / <）：
      1. 「只要不等就下载」会把**降级**也当成升级 —— 线上回滚过、
         或用户本地恰好比线上新时，用户会被装回旧包。
      2. 字符串比较 "1.0.9" > "1.0.10" 是错的。

   返回 1（a 新）/ -1（b 新）/ 0（一样）。
   ------------------------------------------------------------------ */
export function compareVersion(a, b) {
  const pa = String(a || '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/* ------------------------------------------------------------------
   ④ 检查并下载热更新
   ------------------------------------------------------------------
   manifestUrl 指向一个 JSON，形如：
     { "version": "1.0.1", "url": "https://.../bundle-1.0.1.zip", "minBuild": 6 }

   `minBuild` = 这个前端包要求的最低原生版本（Android versionCode）。
   ⚠️ 跨版本升级的核心防线，见下面 BLOCKED 分支。

   返回：{ updated, version, reason, blocked?, needBuild? }
   ------------------------------------------------------------------ */
export async function checkHotUpdate(manifestUrl, onProgress) {
  if (!isNative()) {
    return { updated: false, reason: '当前不是 App 环境（浏览器预览不适用）' }
  }
  if (!manifestUrl) {
    return { updated: false, reason: '还没配置热更新地址' }
  }

  const { CapacitorUpdater } = await import('@capgo/capacitor-updater')

  // 拉 manifest，禁掉缓存，否则永远拿到旧版本号
  const res = await fetch(`${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`读取更新信息失败：HTTP ${res.status}`)
  const info = await res.json()

  if (!info?.version || !info?.url) {
    throw new Error('更新信息格式不对，需要 { version, url }')
  }

  const cur = await CapacitorUpdater.current()
  const localVersion = cur?.bundle?.version || APP_VERSION

  /* ----------------------------------------------------------------
     跨版本升级的第一道防线：原生底座够不够新
     ----------------------------------------------------------------
     场景：用户很久没打开 App（比如还停在 build 3 / 前端 1.0.20），
     某天一打开，线上已经是 build 6 / 前端 1.0.36。

     热更包是**整包替换**（打包的是完整 dist，不是增量补丁），
     所以「跨好几代前端版本」本身没问题 —— 1.0.20 直接跳 1.0.36 是安全的。

     真正会出事的是**原生层落后**：
     新前端里调了 build 5 才加的插件 / 权限 / API，而用户手机上还是 build 3，
     那些能力根本不存在 → 装上去就是各种报错，比不升还糟。

     所以 manifest 里带 minBuild：本机 versionCode 低于它，就**不装**这个热更包，
     老老实实先把 APK 升上去。

     ⚠️ 认命的一点：跑着很老版本的用户，他那份代码里**没有这段判断**，
        拦不住他第一次装上最新包。但装完重启后就是新代码了，
        下次启动会被这里挡住 —— 不会一错再错地继续往更不兼容的方向走。
        真装崩了的兜底是 main.jsx 的 notifyReady()：
        启动没握手成功，Capgo 会自动回滚到上一个能跑的包。
     ---------------------------------------------------------------- */
  const minBuild = Number(info.minBuild) || 0
  if (minBuild > 0) {
    const b = await installedBuild()
    // b === 0 表示读不到（插件异常），这时不拦 —— 不能因为读不到就永远不更新
    if (b > 0 && b < minBuild) {
      return {
        updated: false,
        version: localVersion,
        blocked: true,
        needBuild: minBuild,
        reason: `需要先升级安装包（当前 build ${b}，这个界面版本要求 build ${minBuild} 以上）`,
      }
    }
  }

  // 只在线上**比本机新**时才装 —— 挡住降级
  if (compareVersion(info.version, localVersion) <= 0) {
    return { updated: false, version: localVersion, reason: '已是最新' }
  }

  // 监听下载进度（DownloadEvent 里是 0–100 的 percent）
  let listener = null
  if (typeof onProgress === 'function') {
    try {
      listener = await CapacitorUpdater.addListener('download', (state) => {
        onProgress(typeof state?.percent === 'number' ? state.percent : 0)
      })
    } catch (e) {
      console.warn('[updater] 无法监听下载进度：', e?.message || e)
    }
  }

  try {
    const bundle = await CapacitorUpdater.download({ url: info.url, version: info.version })

    // 切换方式的选择（记录， /  20 Pro / Android 16）：
    //   next() 官方推荐：标记为「下次启动生效」，不打断当前会话。
    //          ⚠️ 但无效 —— 调用后重启 App，插件日志仍显示
    //          "Built-in bundle is active"，界面没有变化。
    //   set()  立即切换并重启 App。会销毁当前 JS 上下文，
    //          此调用之后的代码不会执行、Promise 不会 resolve。
    //          有效。
    await CapacitorUpdater.set({ id: bundle.id })
  } finally {
    // set() 生效时下面这段不会执行到（JS 上下文已被销毁），无妨
    try {
      if (listener) await listener.remove()
    } catch {
      // 忽略
    }
  }

  // 下面这行永远不会执行到 —— set() 会立刻销毁 JS 上下文
  return { updated: true, version: info.version, previous: localVersion, reason: '已切换' }
}

/* ------------------------------------------------------------------
   ⑤ 读「本机装的 APK」的 build（Android 上就是 versionCode）
   ------------------------------------------------------------
   ⚠️ 为什么非得读它：硬编码的版本常量永远是死的（本项目历史上用 APP_BUILD = 1），
      而 version.json 的 build 是手动递增的 —— 拿硬编码值比，「有新版本」永远为真，
      用户装完还会一直看到提示。
      只有拿真实的 versionCode 比，装完才会自动变成「已是最新」。

      ⚠️ 所以 build.gradle 的 versionCode 必须跟 version.json 的 build 一起涨
         （发 APK 时两边 +1，保持同一个号）。
   ------------------------------------------------------------------ */
export async function installedBuild() {
  if (!isNative()) return 0
  try {
    const { App } = await import('@capacitor/app')
    const info = await App.getInfo()
    return parseInt(info?.build || '0', 10) || 0
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------------
   ⑥ 开启统计上报（用户点「知道了」同意隐私政策之后才调用）
   ------------------------------------------------------------------
   Capgo 插件原生层自带上报，会带上：
     机型（metadata.user_agent）、安卓版本（version_os）、App 版本（version_name）
   只要把 statsUrl 指向自己的 SCF 端点，这些数据就落到你自己的 COS 里。
   再把热更新版本号塞进 custom_id —— 看板里就能看出每台机器实际跑的版本。

   注意：必须 allowModifyUrl: true（capacitor.config.json 已设），否则插件拒绝。
   ------------------------------------------------------------------ */
export async function enableStats(url) {
  if (!isNative() || !url) return false
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    await CapacitorUpdater.setStatsUrl({ url })

    // custom_id = 热更新版本号（界面版本），比原生 version_name 有用
    try {
      // ⚠️ 用自己封装的 currentBundle()，不要用插件的 CapacitorUpdater.currentBundle()。
      //    插件那个返回的是 { currentBundle: BundleInfo, ... }，读 b.version 恒为 undefined
      //    —— 结果是 custom_id 一直没设上，看板里版本列永远是空的。
      const b = await currentBundle()
      if (b?.version) {
        await CapacitorUpdater.setCustomId({ customId: b.version })
      }
    } catch (e2) {
      console.warn('[updater] setCustomId 失败：', e2?.message || e2)
    }
    return true
  } catch (e) {
    console.warn('[updater] setStatsUrl 失败：', e?.message || e)
    return false
  }
}

/* ------------------------------------------------------------------
   ⑦ 检查是否需要新 APK（读远端 version.json）
   ------------------------------------------------------------------
   version.json 形如：
     { "build": 2, "version": "1.0.1", "apk": "https://.../app-release.apk", "note": "更新说明" }

   仅做「检查 + 提示」，不自动下载安装 —— 安装动作交给用户，
   避免出现「偷偷装东西」的观感。
   ------------------------------------------------------------------ */
export async function checkRemoteVersion(versionUrl) {
  if (!versionUrl) return { hasNew: false, reason: '还没配置版本检查地址' }

  const res = await fetch(`${versionUrl}${versionUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`读取版本信息失败：HTTP ${res.status}`)
  const info = await res.json()

  const remoteBuild = Number(info?.build)
  if (!Number.isFinite(remoteBuild)) throw new Error('版本信息格式不对，需要 { build }')

  /* ⚠️ 必须跟**本机真实 versionCode** 比，不能跟硬编码常量比 ——
     那样 hasNew 永远为 true（version.json 的 build 是手动递增的 3/4/5…）。
     这里算一次、随结果一起返回，调用方直接用就行，别各自重算 ——
     重算就会有人忘了这条规则。（历史上正是这里埋过一次雷） */
  const installed = await installedBuild()
  // installed === 0 = 读不到（插件异常）→ 不声称有新版本，宁可漏报也别误导
  const hasNew = installed > 0 && remoteBuild > installed

  return {
    hasNew,
    remote: info,
    remoteBuild,
    installed,
    local: { build: installed, version: APP_VERSION },
    reason: hasNew ? '有新版本' : '已是最新',
  }
}
