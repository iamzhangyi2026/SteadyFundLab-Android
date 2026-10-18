// pullRefreshRegistry.js · 「下拉刷新」注册表
//
// 各页（Tab 页 / 二级页）挂载时，把自己的「重新加载数据」函数注册进来；
// MobileLayout 的下拉刷新统一调 runPullRefresh() → 并发跑全部已注册的 reload，
// 等它们都完成（或失败）后，指示条才收起。
//
// 为什么用模块级 Set 而不是 context：
//   MobileLayout 在 DataProvider **外层**（见 App.jsx），拿不到 useData 的 refresh；
//   而各页在 DataProvider 内层，各自有 load/reload。用模块级注册表解耦两者。
//
// 注意：注册表只存「当前挂载页面」的回调 —— 页面卸载时 useEffect 清理会注销，
//   所以 Tab 切换后，旧页的 reload 不会残留（避免下拉刷新打到已卸载页）。

const handlers = new Set()

/** 注册一个刷新回调；返回取消注册函数（供 useEffect 清理） */
export function registerPullRefresh(fn) {
  if (typeof fn !== 'function') return () => {}
  handlers.add(fn)
  return () => { handlers.delete(fn) }
}

/** 并发执行所有已注册的刷新回调；单个失败不影响其它（全部 settled 后返回） */
export async function runPullRefresh() {
  const list = [...handlers]
  await Promise.allSettled(
    list.map((fn) => {
      try { return Promise.resolve(fn()) } catch { return Promise.resolve() }
    }),
  )
}

/** 当前已注册数量（调试用） */
export function pullRefreshCount() { return handlers.size }
