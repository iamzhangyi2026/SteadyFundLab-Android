/**
 * 模拟持仓账本（localStorage 持久化）
 * ------------------------------------------------------------
 * 「记录模拟买入」的落地存储：详情页写入、持仓页读取。
 * 只存本机（卸载即失），与「不涉及真实资金」的沙盒定位一致。
 *
 * 口径：
 *   - 份额 / 费用按**单位净值**折算，不用累计净值
 *   - 申购费外扣法（fee = amount − amount ÷ (1 + rate)），
 *     复用 lib/fees.js 的 calcPurchase，保证与详情页试算一致
 */

const KEY = 'sim_holdings'

/** 读取全部买入记录（数组；异常时返回空，不抛） */
export function loadSimHoldings() {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 追加一条买入记录；写入成功返回 true */
export function addSimHolding(rec) {
  const all = loadSimHoldings()
  all.push(rec)
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
    return true
  } catch {
    return false
  }
}

/** 某基金的已记录笔数 */
export function countSimHolding(code) {
  return loadSimHoldings().filter((r) => r.code === code).length
}

/**
 * 删除一条买入记录（按 id）。
 * 人控要求：用户必须能删自己的模拟记录，不能只进不出。
 * @param {string} id addSimHolding 时写入的 id
 * @returns {boolean} 删掉了返回 true；没这条记录返回 false
 */
export function removeSimHolding(id) {
  if (!id) return false
  const all = loadSimHoldings()
  const next = all.filter((r) => r.id !== id)
  if (next.length === all.length) return false
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

/** 清空全部模拟记录（确认后调用，不可恢复） */
export function clearSimHoldings() {
  try {
    localStorage.removeItem(KEY)
    return true
  } catch {
    return false
  }
}

/** 按基金代码聚合一笔行：份额 / 投入 / 费用（持仓页展示用） */
export function simHoldingByCode() {
  const map = new Map()
  for (const r of loadSimHoldings()) {
    const cur = map.get(r.code) || { code: r.code, name: r.name, shares: 0, amount: 0, fee: 0 }
    cur.shares += Number(r.shares) || 0
    cur.amount += Number(r.amount) || 0
    cur.fee += Number(r.fee) || 0
    if (r.name) cur.name = r.name
    map.set(r.code, cur)
  }
  return [...map.values()]
}
