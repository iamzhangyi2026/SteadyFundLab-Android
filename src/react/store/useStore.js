import { create } from 'zustand'
// NOTE: 安卓版是纯前端 SQLite 架构，所有数据由 dataAdapter.js 直读本地库，不连任何 HTTP 后端。
// 数据加载由 page-level useEffect + dataAdapter 负责。

export const useStore = create((set, get) => {
  // toast 自增序号（队列去重 / 逐条移除，不依赖时间戳比对）
  let toastSeq = 0

  const actions = {}

  // 2) 写操作：纯前端架构，无 HTTP 后端，全部 stub 为 no-op（保留签名防引用崩）
  actions.placeOrder            = async () => null
  actions.cancelOrder           = async () => null
  actions.addDingtouPlan        = async () => null
  actions.updateDingtouPlan     = async () => null
  actions.deleteDingtouPlan     = async () => null
  actions.runDingtou            = async () => null
  actions.addIntel              = async () => null
  actions.collectIntel          = async () => null
  actions.refreshNews           = async () => null
  actions.refreshMarketNews     = async () => null
  actions.refreshSectorNews     = async () => null
  actions.runTriage             = async () => null
  actions.refreshFunds          = async () => null
  actions.addFund               = async () => null
  actions.removeFund            = async () => null
  actions.searchFunds           = async () => null
  actions.takeSnapshot          = async () => null
  actions.openExternal          = () => null
  actions.updateSettings        = async () => null
  actions.fetchRecovery         = async () => ({ snapshots: [] })
  actions.takeBackup            = async () => null
  actions.pruneBackups          = async () => null
  actions.restoreFromArchive    = async () => null
  actions.fetchAiConfigStatus   = async () => ({ configured: false })
  actions.saveAiConfig          = async () => ({ configured: false })
  actions.clearAiConfig         = async () => ({ configured: false })

  // 3) 轻量 toast 队列（操作反馈，避免弹窗轰炸）。
  //    duration 毫秒（省略则按类型取默认）：
  //      error → 6s（报错要能读完原因）、其余 → 2.4s；
  //      duration <= 0 → **常驻**，必须手动点 × 关闭，留给「重大事件/风控提醒」这类
  //      一闪而过就会漏看的内容。常驻条目不参与「只留最近 3 条」的裁剪，免得被挤掉。
  actions.notify = (message, type = 'info', duration = null) => {
    const ms = duration == null ? (type === 'error' ? 6000 : 2400) : duration
    const sticky = !(ms > 0)
    toastSeq += 1
    const id = toastSeq
    set((st) => {
      const prev = st.toasts || []
      const next = [...prev, { id, message, type, ts: Date.now(), sticky }]
      const keptSticky = next.filter((t) => t.sticky).slice(-5)     // 常驻最多叠 5 条
      const keptTransient = next.filter((t) => !t.sticky).slice(-3) // 普通提示只留最近 3 条
      return { toasts: [...keptSticky, ...keptTransient] }
    })
    if (!sticky) setTimeout(() => get().dismissToast(id), ms)
  }
  actions.dismissToast = (id) => set((st) => ({ toasts: (st.toasts || []).filter((t) => t.id !== id) }))
  actions.clearToast = () => set({ toasts: [] })

  return {
    ...actions,
    toasts: [],
    recovery: { data: null, loading: false, error: null, lastUpdated: null },
    aiConfig: { data: null, loading: false, error: null, lastUpdated: null },
    // UI 状态：当前活跃 tab / 更多面板 tab / 加载占位
    ui: { activeTab: 'overview', loading: false, activeMoreTab: null },
    setUI(action, value) {
      set((st) => ({
        ui: { ...st.ui, [action]: value },
      }))
    },
  }
})
