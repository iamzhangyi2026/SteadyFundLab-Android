// src/lib/gestures.js · 下拉刷新手势
// ------------------------------------------------------------
// 纯 touch 事件实现，不引任何库、不发任何请求。
//
// ⚠️ 这里**不做侧滑返回**。
//    Android 的全面屏手势本身就有「边缘滑动返回」，系统会把它转发成
//    Capacitor 的 backButton 事件（处理逻辑在 App.jsx）。
//    如果在 Web 层再仿一套边缘滑动，两套手势会同时响应：
//    页面跟着手指横移、系统同时触发返回 —— 表现就是「滑一下乱跳」。
//    正确接法：返回交给系统，App 只决定「返回到哪一页」。
//
// 下拉刷新是 Web 层自己的手势，与系统手势不冲突，保留在这里。

/** 下拉超过这个距离才触发刷新 */
const PULL_DISTANCE = 76
/** 判定「已在顶部」的容差：浏览器滚动会留下小数值 */
const TOP_TOLERANCE = 4

/**
 * 下拉刷新。
 * @param {HTMLElement} container 滚动容器（.app-body）
 * @param {HTMLElement} indicator 顶部指示器元素
 * @param {() => void} onRefresh  刷新动作（并发保护：刷新中不重复触发）
 */
export function bindPullRefresh(container, indicator, onRefresh) {
  if (!container || !indicator) return () => {}

  let startY = 0
  let pulling = false
  let dist = 0
  let refreshing = false

  const setIndicator = (y, text) => {
    // 外层居中用 translate(-50%, …)，纵向位移由手势控制
    indicator.style.transition = 'transform 0ms'
    indicator.style.transform = `translate(-50%, ${Math.min(y, PULL_DISTANCE + 12)}px)`
    indicator.style.opacity = String(Math.min(1, y / 40))
    const t = indicator.querySelector('.pull-text')
    if (t && text) t.textContent = text
  }

  const release = () => {
    indicator.style.transition = 'transform 220ms cubic-bezier(0.22,0.61,0.36,1), opacity 160ms'
    indicator.style.transform = 'translate(-50%, 0)'
    indicator.style.opacity = '0'
    indicator.classList.remove('is-refreshing')
  }

  const onStart = (e) => {
    if (refreshing) return
    if (container.scrollTop > TOP_TOLERANCE) return
    const t = e.touches[0]
    if (!t) return
    pulling = true
    startY = t.clientY
    dist = 0
  }

  const onMove = (e) => {
    if (!pulling || refreshing) return
    const t = e.touches[0]
    if (!t) return
    const dy = t.clientY - startY
    if (dy <= 0) {
      dist = 0
      setIndicator(0)
      return
    }
    // 容器已经在顶部还要往下拉 → 阻止默认，别让浏览器跟着回弹
    if (container.scrollTop <= TOP_TOLERANCE && e.cancelable) e.preventDefault()
    dist = dy
    setIndicator(dist, dist >= PULL_DISTANCE ? '松开刷新' : '下拉刷新')
  }

  const onEnd = () => {
    if (!pulling) return
    pulling = false
    if (dist >= PULL_DISTANCE && !refreshing) {
      refreshing = true
      indicator.classList.add('is-refreshing')
      setIndicator(PULL_DISTANCE, '刷新中…')
      const startedAt = Date.now()
      Promise.resolve(onRefresh()).finally(() => {
        /* 「刷新中」至少展示 500ms：有的页面刷新是同步的（改个 key 就完事），
           不等一下的话指示器一闪而过，用户根本看不到反馈。 */
        const wait = Math.max(0, 500 - (Date.now() - startedAt))
        window.setTimeout(() => {
          refreshing = false
          release()
        }, wait)
      })
      return
    }
    release()
  }

  const onCancel = () => {
    if (pulling) {
      pulling = false
      release()
    }
  }

  // touchmove 必须非 passive 才能 preventDefault
  container.addEventListener('touchstart', onStart, { passive: true })
  container.addEventListener('touchmove', onMove, { passive: false })
  container.addEventListener('touchend', onEnd, { passive: true })
  container.addEventListener('touchcancel', onCancel, { passive: true })

  return () => {
    container.removeEventListener('touchstart', onStart)
    container.removeEventListener('touchmove', onMove)
    container.removeEventListener('touchend', onEnd)
    container.removeEventListener('touchcancel', onCancel)
  }
}
