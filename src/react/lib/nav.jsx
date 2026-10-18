// nav.jsx · 二级页栈（安卓 push / pop 语义）
//
// 为什么要有它：常规做法是
// **一屏一个主题 + 点进去看详情**。所以需要一个页面栈。
//
// - push(key, params)：进入二级页（全屏，隐藏底部 Tab）
// - pop()：返回上一级
// - 安卓物理返回键：有二级页 → 返回；无 → 退出 App
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const NavCtx = createContext(null)

export function NavProvider({ children }) {
  const [stack, setStack] = useState([])
  const stackRef = useRef(stack)
  stackRef.current = stack

  const push = useCallback((key, params = {}) => {
    setStack(s => [...s, { key, params, ts: Date.now() }])
  }, [])
  const pop = useCallback(() => setStack(s => s.slice(0, -1)), [])
  const reset = useCallback(() => setStack([]), [])

  // 安卓物理返回键
  useEffect(() => {
    let listener = null
    ;(async () => {
      try {
        const mod = await import('@capacitor/app')
        const App = mod && mod.App
        if (!App || !App.addListener) return
        listener = await App.addListener('backButton', () => {
          if (stackRef.current.length > 0) setStack(s => s.slice(0, -1))
          else { try { App.exitApp() } catch { /* ignore */ } }
        })
      } catch { /* Web / 无插件：忽略 */ }
    })()
    return () => { try { listener && listener.remove && listener.remove() } catch { /* ignore */ } }
  }, [])

  const page = stack.length ? stack[stack.length - 1] : null
  return (
    <NavCtx.Provider value={{ stack, page, push, pop, reset }}>
      {children}
    </NavCtx.Provider>
  )
}

export function useNav() {
  const c = useContext(NavCtx)
  return c || { stack: [], page: null, push: () => {}, pop: () => {}, reset: () => {} }
}

export default useNav
