/**
 * APK 自更新
 * ------------------------------------------------------------
 * 解决一件事：需要重新打包 APK 时，用户不用等开发者手动发文件过来。
 *
 * 流程：App 内下载 APK → 调起系统安装器 → 用户点「安装」→ 下次打开是新版。
 *
 * ⚠️ 两个必须知道的限制：
 *
 * 1. 安装 APK 时 Android 会杀掉本 App 进程（程序文件正在被替换），
 *    所以装完必须由用户手动重新打开 App。这是系统设计，微信也一样。
 *
 * 2. Android 8.0 起，安装非应用商店来源的 APK 需要用户自己在系统设置里
 *    打开「安装未知应用」开关。代码只能引导用户过去，不能代替他决定。
 *
 * 本模块只暴露两个方法（对应「我的 → 安装包」卡片上的动作）：
 *   openInstallPermission()   跳系统设置，引导用户开「安装未知应用」
 *   downloadAndInstallApk()   下载 + 调起系统安装器
 * 原生侧另有 canInstall()（权限预检）未接入界面，故 JS 侧不封装；
 * 将来要做「装之前先预检」时再加回来。
 *
 * 原生实现在 android/app/src/main/java/com/fundapp/ApkInstallerPlugin.java
 */

import { registerPlugin } from '@capacitor/core'
import { isNative } from './platform.js'

const ApkInstaller = registerPlugin('ApkInstaller')

/** 跳转到「安装未知应用」的系统设置页 */
export async function openInstallPermission() {
  if (!isNative()) return false
  try {
    await ApkInstaller.openInstallPermission()
    return true
  } catch (e) {
    console.warn('[apk] 打开安装权限页失败：', e?.message || e)
    return false
  }
}

/**
 * 下载并安装
 * @returns {{ok: boolean, size?: number, needPermission?: boolean, message?: string}}
 */
export async function downloadAndInstallApk(url) {
  if (!isNative()) {
    return { ok: false, message: '非 App 环境' }
  }
  if (!url) {
    return { ok: false, message: '缺少安装包地址' }
  }

  try {
    const r = await ApkInstaller.downloadAndInstall({ url })
    return { ok: true, size: r?.size || 0 }
  } catch (e) {
    const msg = e?.message || String(e)
    // 原生层在缺权限时用这个 code 拒绝
    if (e?.code === 'NEED_INSTALL_PERMISSION' || /安装未知应用/.test(msg)) {
      return { ok: false, needPermission: true, message: msg }
    }
    return { ok: false, message: msg }
  }
}
