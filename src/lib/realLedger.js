// src/lib/realLedger.js · 真实持仓账本（localStorage 持久化）
// ------------------------------------------------------------
// OCR 导入的真实持仓落地存储：导入组件写入、持仓页读取。
// 只存本机（卸载即失），原型阶段范式与 simLedger 一致。
//
// 口径：
//   - 份额 / 金额以**最新一次导入为准**（快照语义：同一基金再次导入 = 覆盖，
//     不累加——避免重复截图导致份额翻倍失真）
//   - 无代码的条目按名称去重
//   - 金额为持有市值（元）；收益在持仓页按「份额 × 净值」实时算

const KEY = 'real_holdings'

/** 读取全部真实持仓（数组；异常时返回空，不抛） */
export function loadRealHoldings() {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * 单只持仓的实时口径计算（持仓页 / 详情页 / 深度分析共用，口径只写一遍）。
 *
 * 口径：
 *   - 截图「持有金额」是市值，不是成本；成本 = 市值 ÷ (1 + 收益率%)
 *   - 持有额 = 份额 × 最新净值；无份额时用截图市值按净值涨幅等比换算
 *   - 持有收益 = 持有额 − 成本；持有收益率 = 持有收益 ÷ 成本
 *   - 当日估算收益按盘中/盘后两种净值基准分开算，不混用
 *
 * @param {object} r 账本行 { code, name, shares, amount, pct, nav_at_import, live }
 * @returns {{ nav, cost, mv, pnl, pnlPct, estPnl }}
 */
export function calcHolding(r) {
  /* 脏数据防线：pct 可能是导入的字符串/空值，也可能极端到 -100（除零）。
     所有中间值先过有限数校验，宁可返回 null（界面显示「—」），也不渲染 NaN。
     ⚠️ Number(null) === 0、Number('') === 0——必须先挡掉空值，
        否则 shares=null 会被当成 0 份，市值算成 0、收益 -100%（ 回归抓到的 bug）。 */
  const num = (v) => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const navNow = num(r.live?.nav)
  const navBase = num(r.nav_at_import)
  const shares = num(r.shares)
  const amount = num(r.amount)
  const pctRaw = num(r.pct)

  // 成本口径：优先账本里的 cost（定投自动追加写入），
  // 其次用截图口径「市值 ÷ (1 + 收益率)」，最后退回金额本身
  const costDirect = num(r.cost)
  const cost =
    costDirect != null
      ? costDirect
      : pctRaw != null && amount != null && pctRaw > -100
        ? amount / (1 + pctRaw / 100)
        : amount

  const mv =
    shares != null && navNow != null
      ? shares * navNow
      : navNow != null && navBase != null && navBase > 0 && amount != null
        ? (amount * navNow) / navBase
        : amount

  const pnl = mv != null && cost != null ? mv - cost : null
  const pnlPct = pnl != null && cost ? (pnl / cost) * 100 : null
  const pct = num(r.live?.pct)
  const estPnl =
    mv != null && pct != null && pct > -100
      ? r.live?.pnlBase === 'yesterday'
        ? (mv * pct) / 100
        : (mv * pct) / (100 + pct)
      : null
  return { nav: navNow, cost, mv, pnl, pnlPct, estPnl }
}

/**
 * 批量写入真实持仓（按 code 覆盖；无 code 的按 name 覆盖）。
 * 返回 { written, total }：written = 本次写入条数，total = 写入后总数。
 */export function addRealHoldings(items) {
  const map = new Map()
  const keyOf = (r) => (r.code ? `c:${r.code}` : `n:${r.name || ''}`)
  for (const r of loadRealHoldings()) map.set(keyOf(r), r)
  let written = 0
  for (const it of items) {
    if (!it || (!it.code && !it.name)) continue
    const rec = {
      code: it.code || null,
      name: it.name || null,
      shares: it.shares != null ? Number(it.shares) : null,
      amount: it.amount != null ? Number(it.amount) : null,
      pct: it.pct != null ? Number(it.pct) : null,
      // 导入当天的单位净值：没有份额时，用它把「当时的市值」换算成「现在的市值」
      // （市值 = 导入金额 × 当前净值 ÷ 导入时净值）
      nav_at_import: it.nav_at_import != null ? Number(it.nav_at_import) : null,
      nav_date_at_import: it.nav_date_at_import || '',
      raw: it.raw || '',
      created_at: new Date().toISOString(),
    }
    map.set(keyOf(rec), rec)
    written++
  }
  const all = [...map.values()]
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 写满等异常：返回 0 表示未落盘（UI 侧提示）
    return { written: 0, total: 0 }
  }
  return { written, total: all.length }
}

/** 移除某只基金的真实持仓（按 code 或 name 匹配） */
export function removeRealHolding(code, name) {
  const key = code ? `c:${code}` : `n:${name || ''}`
  const rest = loadRealHoldings().filter((r) => (r.code ? `c:${r.code}` : `n:${r.name || ''}`) !== key)
  try {
    localStorage.setItem(KEY, JSON.stringify(rest))
  } catch {
    return false
  }
  return true
}

/**
 * 修改某只持仓的 份额 / 市值金额 / 收益率（按 code 或 name 匹配）。
 * 只改传入的字段；传 null 或空串表示清空。
 * @returns {boolean} 是否写入成功
 */
export function updateRealHolding(code, name, patch = {}) {
  const key = code ? `c:${code}` : `n:${name || ''}`
  const list = loadRealHoldings()
  const i = list.findIndex(
    (r) => (r.code ? `c:${r.code}` : `n:${r.name || ''}`) === key,
  )
  if (i < 0) return false

  const numOrNull = (v) => {
    if (v == null || String(v).trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const rec = { ...list[i] }
  if ('shares' in patch) rec.shares = numOrNull(patch.shares)
  if ('amount' in patch) rec.amount = numOrNull(patch.amount)
  if ('pct' in patch) rec.pct = numOrNull(patch.pct)
  rec.updated_at = new Date().toISOString()
  list[i] = rec

  try {
    localStorage.setItem(KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/**
 * 追加一笔「定投自动投」：份额 += deltaShares，成本 += amountCost，市值按最新净值重算。
 * 只对账本里**已存在**的基金追加；该基金不在持仓里返回 false（不自动建仓）。
 *
 * @param {{code:string, name?:string, deltaShares:number, amountCost:number,
 *          nav:number, navDate?:string}} p
 * @returns {boolean}
 */
export function appendRealHolding({ code, name, deltaShares, amountCost, nav, navDate }) {
  if (!code || !(Number(deltaShares) > 0) || !(Number(nav) > 0)) return false
  const keyOf = (r) => (r.code ? `c:${r.code}` : `n:${r.name || ''}`)
  const list = loadRealHoldings()
  const i = list.findIndex((r) => keyOf(r) === `c:${code}`)
  if (i < 0) return false

  const cur = list[i]
  const oldCost =
    cur.cost != null
      ? Number(cur.cost)
      : cur.pct != null && cur.amount != null
        ? Number(cur.amount) / (1 + Number(cur.pct) / 100)
        : cur.amount != null
          ? Number(cur.amount)
          : 0
  const shares = (Number(cur.shares) || 0) + Number(deltaShares)
  const cost = oldCost + Number(amountCost)
  const mv = shares * Number(nav)
  const pct = cost > 0 ? (mv / cost - 1) * 100 : null

  list[i] = {
    ...cur,
    name: name || cur.name,
    shares,
    cost: +cost.toFixed(4),
    amount: +mv.toFixed(2),
    pct: pct != null ? +pct.toFixed(4) : null,
    nav_at_import: Number(nav),
    nav_date_at_import: navDate || cur.nav_date_at_import || '',
    updated_at: new Date().toISOString(),
  }

  try {
    localStorage.setItem(KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/**
 * 给老数据补「导入时净值」基准（只补缺失的，不动已有值）。
 * 没有份额的持仓，市值只能靠「导入金额 × 净值涨幅」推算 ——
 * 缺了这个基准，市值会永远停在导入那天的金额。
 * 补基准当天市值不变（比例 = 1），之后才随净值走。
 */
export function backfillNavBase(navByCode) {
  const list = loadRealHoldings()
  let changed = false
  for (const r of list) {
    const n = r.code ? navByCode[r.code] : null
    if (r.code && r.nav_at_import == null && n?.nav != null) {
      r.nav_at_import = n.nav
      r.nav_date_at_import = n.date || ''
      changed = true
    }
  }
  if (changed) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list))
    } catch {
      // 写失败就算了，下次再补
    }
  }
  return changed
}
