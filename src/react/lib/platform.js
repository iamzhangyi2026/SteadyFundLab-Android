/**
 * 运行平台判断
 * ------------------------------------------------------------
 * 全项目唯一 isNative 来源 —— 浏览器里调用原生插件会抛异常，
 * 所以凡是碰 @capacitor/* 的代码路径都要先问一句「现在是 App 里还是浏览器里」。
 */
import { Capacitor } from '@capacitor/core'

/** 是否运行在原生 App 环境 */
export const isNative = () => Capacitor.isNativePlatform()
