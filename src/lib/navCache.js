// src/lib/navCache.js · 净值历史本地缓存（实时抓 + 增量存）
// ------------------------------------------------------------
// 定位：仍然是「实时抓」，但抓过的历史数据落到 localStorage，
// 分析（位置 / 下跌 / 回测 / 基准 / TWR / 筛选）优先读缓存，缺的才请求。
// 不引入 SQLite，也不做离线优先——只是把「已抓到的历史」存住、别重复抓。
//
// 容量控制（localStorage 约 5MB）：
//   - 每只基金只保留最近 MAX_POINTS 条（默认 1200，覆盖 250 日窗口 + 3 年定投回测）
//   - 触碰 150 只基金上限时，淘汰最早写的那批（FIFO），避免写满后新数据存不进
//
// 合并口径：按日期升序去重，新数据覆盖同一天旧值。

import { fetchFund, fmtNavDate } from './eastmoney.js'

const PREFIX = 'nav_cache_v1_'
const INDEX_KEY = PREFIX + '__index__'
const MAX_POINTS = 1200
const MAX_FUNDS = 150
const TTL = 24 * 60 * 60 * 1000

function readIndex() {
  try {
    const obj = JSON.parse(localStorage.getItem(INDEX_KEY) || '{}')
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function writeIndex(idx) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx))
  } catch {
    // 写满就算了，索引不影响读
  }
}

/** 读某基金的缓存序列（无则 null） */
export function loadNavCache(code) {
  if (!code) return null
  try {
    const obj = JSON.parse(localStorage.getItem(PREFIX + code) || 'null')
    if (!obj || !Array.isArray(obj.series) || obj.series.length === 0) return null
    return obj
  } catch {
    return null
  }
}

/**
 * 把本地缓存的序列换成 fetchFund 的返回结构，供首屏直接渲染
 * @returns {{code:string,name:string,netWorth:Array,accWorth:Array,rate:null,sourceRate:null}|null}
 */
export function cachedToWorth(code) {
  const obj = loadNavCache(code)
  if (!obj) return null
  const netWorth = []
  const accWorth = []
  for (const p of obj.series) {
    const x = Date.parse(`${p.date}T00:00:00`)
    if (!Number.isFinite(x) || !Number.isFinite(Number(p.nav))) continue
    netWorth.push({ x, y: Number(p.nav) })
    if (Number.isFinite(Number(p.acc_nav))) accWorth.push({ x, y: Number(p.acc_nav) })
  }
  if (netWorth.length === 0) return null
  return {
    code,
    name: code,
    netWorth,
    accWorth,
    rate: null,
    sourceRate: null,
    minBuy: null,
    stockCodes: [],
    fromCache: true,
  }
}

/**
 * 写缓存（截断到 MAX_POINTS，并登记索引供 FIFO 淘汰）
 *
 * 顺序：**先尝试写**，写失败（配额满）才淘汰最旧的那批再重试一次。
 * 旧实现是先淘汰再写——一旦写入失败，旧缓存白删了，等于丢数据。
 */
export function saveNavCache(code, series, { source = 'net' } = {}) {
  if (!code || !Array.isArray(series) || series.length === 0) return false
  const idx = readIndex()
  idx[code] = Date.now()

  // 种子快照记 at:0 —— 它只是发版当天的快照，不能当成「刚刚抓过」。
  // 否则预抓取会因「24h 内抓过」把种子覆盖的基金全部跳过（首日队列为空、
  // 功能形同虚设），位置/下跌/算法推荐也会一直沿用发版当天的旧数据。
  const at = source === 'seed' ? 0 : Date.now()
  const trimmed = series.slice(-MAX_POINTS)
  const payload = JSON.stringify({
    at,
    source,
    last_date: trimmed[trimmed.length - 1]?.date || '',
    series: trimmed,
  })

  const tryWrite = () => {
    try {
      localStorage.setItem(PREFIX + code, payload)
      writeIndex(idx)
      return true
    } catch {
      return false
    }
  }

  if (tryWrite()) return true

  /* 写失败：按 FIFO 淘汰——先腾出超过上限的部分，再额外清 10 只给配额留空间 */
  const keys = Object.keys(idx)
    .filter((k) => k !== code)
    .sort((a, b) => idx[a] - idx[b])
  const overLimit = Math.max(0, keys.length - (MAX_FUNDS - 1))
  const need = overLimit + 10
  for (const k of keys.slice(0, need)) {
    try {
      localStorage.removeItem(PREFIX + k)
    } catch {
      // 忽略
    }
    delete idx[k]
  }
  return tryWrite()
}

/** fetchFund 的结果 → [{date, nav, acc_nav}] */
export function toSeries(d) {
  if (!d) return []
  const accByX = new Map((d.accWorth || []).map((p) => [p.x, p.y]))
  return (d.netWorth || [])
    .map((p) => ({
      date: fmtNavDate(p.x),
      nav: Number(p.y),
      acc_nav: accByX.has(p.x) ? Number(accByX.get(p.x)) : null,
    }))
    .filter((p) => p.date && Number.isFinite(p.nav))
}

/** 合并两段序列：按日期升序，新值覆盖同一天 */
export function mergeSeries(old, fresh) {
  if (!old || old.length === 0) return fresh || []
  if (!fresh || fresh.length === 0) return old
  const map = new Map(old.map((p) => [p.date, p]))
  for (const p of fresh) map.set(p.date, p)
  return [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
}

/**
 * 带缓存的净值序列取用
 * @param {string} code 基金代码
 * @param {{force?: boolean, ttl?: number}} opts force=忽略 TTL 强制重抓
 * @returns {Promise<Array<{date,nav,acc_nav}>>} 取不到返回 []
 */
export async function fetchFundCached(code, { force = false, ttl = TTL } = {}) {
  if (!code) return []
  const hit = loadNavCache(code)
  if (!force && hit && Date.now() - hit.at < ttl && hit.series.length) {
    return hit.series
  }
  try {
    const d = await fetchFund(code)
    const series = toSeries(d)
    const merged = mergeSeries(hit?.series || [], series)
    saveNavCache(code, merged)
    return merged.length ? merged : []
  } catch {
    // 网络失败：退回缓存（离线也能分析），没有就空
    return hit?.series || []
  }
}

/** 清掉某基金缓存（数据源异常/口径修复后可手动清，让下次重新抓） */
export function clearNavCache(code) {
  try {
    localStorage.removeItem(PREFIX + code)
    const idx = readIndex()
    delete idx[code]
    writeIndex(idx)
  } catch {
    // 忽略
  }
}
