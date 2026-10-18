// useData.jsx · 全局账户数据层
//
// 职责：
//   1. 初始化 + 抓取进度（fetchingNav / navCount / initResult）—— 沿用现有逻辑
//   2. 账户数据共享（positions / budget / watchlist / orders）
//   3. 跨 Tab 导航（navigate / selectedFund）—— navigate 写入 store，不写 window
//   4. 统一刷新入口（refresh）
//
// 设计原则：
//   - 各 view 不再各自 useState + reload()，统一从 store 读
//   - 任一 Tab 发生买卖/关注操作后，调用 refresh()，其他 Tab 即时反映
//   - selectedFund 与 Trade 组件双向同步：Trade 手动选则写回 store，外部 navigate 则从 store 来

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { initDataLayer, isInitialized, getInitResult } from '../lib/dataAdapter'
import { fetchBudget, fetchPositions, fetchWatchlist, fetchAllOrders } from '../lib/dataAdapter'
import { startScheduler } from '../lib/scheduler'

const DataContext = createContext({
  initialized: true,
  initResult: null,
  initError: null,
  fetchingNav: false,
  navCount: 0,
  positions: [],
  budget: null,
  watchlist: [],
  orders: [],
  selectedFund: null,
  refresh: null,
  navigate: null,
})

export function DataProvider({ children, onNavigate }) {
  const [initResult, setInitResult] = useState(getInitResult())
  const [initError, setInitError] = useState(null)
  const [fetchingNav, setFetchingNav] = useState(false)
  const [navCount, setNavCount] = useState(0)
  const [started, setStarted] = useState(false)
  const [positions, setPositions] = useState([])
  const [budget, setBudget] = useState(null)
  const [watchlist, setWatchlist] = useState([])
  const [orders, setOrders] = useState([])
  const [selectedFund, setSelectedFund] = useState(null)

  // 统一刷新：重新拉取所有账户数据
  const refresh = useCallback(async () => {
    try {
      const [b, p, w, o] = await Promise.all([
        fetchBudget(), fetchPositions(), fetchWatchlist(), fetchAllOrders(),
      ])
      if (b.ok) setBudget(b.data ?? null)
      if (p.ok) setPositions(p.data ?? [])
      if (w.ok) setWatchlist(w.data ?? [])
      if (o.ok) setOrders(o.data ?? [])
    } catch (e) {
      console.error('[useData] refresh 失败', e)
    }
  }, [])

  // 初始化时自动刷新一次
  useEffect(() => {
    refresh()
  }, [refresh])

  // navigate：切换 Tab + 设置选中基金（同步到 store）
  const navigate = useCallback((tabKey, opts = {}) => {
    if (opts.fundCode) setSelectedFund(opts.fundCode)
    if (onNavigate) onNavigate(tabKey)
  }, [onNavigate])

  const start = useCallback(async () => {
    if (started) return
    setStarted(true)
    setFetchingNav(true)
    setNavCount(0)
    try {
      const r = await initDataLayer({
        log: (msg) => console.log(msg),
        fetchOnStart: true,
        onProgress: (nameCount, curNavCount) => {
          setNavCount(curNavCount)
          console.log(`[progress] name=${nameCount} nav=${curNavCount}`)
        },
      })
      setInitResult(r)
      if (r.errors?.length) {
        setInitError(r.errors.slice(0, 2).join('；'))
      }
      // 初始化完成后**必须再刷新一次账户数据**：
      // 挂载时的 refresh() 早于 DB 就绪（那时 _db 还是 null，fetchWatchlist 返回空），
      // 不补这一次 → 账户页「自选速览 / 持仓 / 预算」永远是空的（而交易页自己拉，所以有数据）。
      await refresh()
      // 兜底调度器：AI 不在线时跑离线周期（每天一次，内部把关）
      startScheduler()
    } catch (e) {
      console.error('[useData] 初始化失败', e)
      setInitError('数据抓取失败，本地数据仍可使用')
    } finally {
      setFetchingNav(false)
    }
  }, [started])

  useEffect(() => {
    start()
  }, [start])

  return (
    <DataContext.Provider value={{
      initialized: true,
      initResult, initError, fetchingNav, navCount,
      positions, budget, watchlist, orders,
      selectedFund,
      setSelectedFund,
      refresh,
      navigate,
    }}>
      {children}
    </DataContext.Provider>
  )
}

export function useData() {
  return useContext(DataContext)
}
