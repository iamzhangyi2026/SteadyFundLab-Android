// src/lib/usePullRefresh.js · 页面订阅「下拉刷新」的 hook
// ------------------------------------------------------------
// 手势在 App 根（main.app-body）上监听（见 lib/gestures.js），
// 但「刷新什么」只有各页面知道。这里用全局事件打通：
//   App 的手势 → dispatch 'app:pull-refresh' → 当前页面的回调执行。
// 页面卸载自动退订，不会串页。

import { useEffect, useRef } from 'react'

/**
 * 订阅「下拉刷新」手势：页面卸载自动退订，回调始终取最新闭包
 * @param {() => void} fn 刷新回调
 */
export function usePullRefresh(fn) {
  const ref = useRef(fn)
  ref.current = fn

  useEffect(() => {
    const handler = () => ref.current()
    window.addEventListener('app:pull-refresh', handler)
    return () => window.removeEventListener('app:pull-refresh', handler)
  }, [])
}
