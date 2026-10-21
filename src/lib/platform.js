/**
 * 运行平台判断
 * ------------------------------------------------------------
 * 全项目**唯一**的 isNative 来源 —— 不要在各自模块里再定义一遍。
 *
 * 背景：Capacitor 的插件在浏览器里调用会抛异常，所以凡是碰原生插件的
 * 代码路径都要先问一句「现在是 App 里还是浏览器里」。
 * 这个判断曾散落在多个文件里
 * 各写一份，改动时容易只改一处 —— 现在统一收在这里。
 *
 * 返回：
 *   true  = 跑在 App（Android WebView）里，原生插件可用
 *   false = 跑在浏览器 / vite preview 里，原生能力一律不可用
 */

import { Capacitor } from '@capacitor/core'

/** 是否运行在原生 App 环境 */
export const isNative = () => Capacitor.isNativePlatform()
