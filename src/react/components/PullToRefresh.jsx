// PullToRefresh.jsx · 纯前端「下拉刷新」
//
// 用法：把滚动容器的 ref 传进来（scrollRef），组件在该容器上挂原生 touch 监听。
//   仅当容器滚到顶部（scrollTop === 0）且手指向下拖超过阈值时，才触发 onRefresh()。
//
// 为什么用原生 addEventListener 而不是 React 的 onTouchMove：
//   React 对 touch 事件默认 passive，无法 preventDefault；而顶部下拉时必须
//   preventDefault 才能压住 Android WebView 自带的 overscroll（页面橡皮筋），
//   否则指示条和橡皮筋会打架。
//
// 视觉：容器顶部推出一条指示条 —— 「下拉刷新 / 松开刷新 / 正在刷新…」。
// 不改原生、不动 WebView 配置，纯前端 → 可走热更新。

import { useEffect, useRef, useState } from 'react'

const THRESHOLD = 60   // 松手触发刷新的下拉距离（px）
const MAX_PULL = 96    // 指示条最大拉伸距离（px）
const START_GAP = 6    // 起手死区：手指移动超过它才算「下拉」

export default function PullToRefresh({ scrollRef, onRefresh, disabled = false, children }) {
  const [pullY, setPullY] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const st = useRef({ startY: null, pulling: false, y: 0, refreshing: false })
  const refreshCb = useRef(onRefresh)
  refreshCb.current = onRefresh

  useEffect(() => {
    const el = scrollRef?.current
    if (!el) return

    const reset = () => { st.current.pulling = false; st.current.y = 0; setPullY(0) }

    const onStart = (e) => {
      if (disabled || st.current.refreshing) return
      if (el.scrollTop > 0) return          // 不在顶部 → 不接管
      st.current.startY = e.touches[0].clientY
      st.current.pulling = false
    }

    const onMove = (e) => {
      const s = st.current
      if (s.startY == null) return
      const dy = e.touches[0].clientY - s.startY
      if (dy <= 0) { if (s.pulling) reset(); return }   // 往上滑 → 取消
      if (el.scrollTop > 0) { s.startY = null; reset(); return }  // 中途滚动了 → 放弃
      if (dy > START_GAP) {
        s.pulling = true
        const dist = Math.min(MAX_PULL, (dy - START_GAP) * 0.5)   // 0.5 阻尼，跟手不突兀
        s.y = dist
        setPullY(dist)
        if (e.cancelable) e.preventDefault()
      }
    }

    const onEnd = async () => {
      const s = st.current
      if (s.startY == null) return
      s.startY = null
      const shouldRefresh = s.pulling && s.y >= THRESHOLD
      s.pulling = false
      if (!shouldRefresh) { reset(); return }
      s.refreshing = true
      setRefreshing(true)
      setPullY(THRESHOLD)
      try {
        await refreshCb.current?.()
      } catch { /* 刷新失败不阻塞收起 */ }
      finally {
        s.refreshing = false
        setRefreshing(false)
        reset()
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [scrollRef, disabled])

  const label = refreshing ? '正在刷新…' : (pullY >= THRESHOLD ? '松开刷新' : '下拉刷新')

  return (
    <>
      <div
        className="ptr-bar"
        style={{ height: pullY, transition: pullY === 0 ? 'height .25s ease' : 'none' }}
        aria-hidden={pullY === 0}
      >
        <span className={`ptr-spinner${refreshing ? ' spinning' : ''}`} />
        <span className="ptr-text">{label}</span>
      </div>
      {children}
    </>
  )
}
