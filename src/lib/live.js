// src/lib/live.js · 实时行情（最新净值 + 跟踪指数）
// ------------------------------------------------------------
// 持仓行要显示：估算净值 / 持有额 / 持有收益 / 持有收益率 / 涨跌幅 / 估算收益 / 更新时间。
// 其中「净值、涨跌幅」来自东财批量接口；「估算净值、估算收益」来自跟踪指数的实时行情。
//
// ⚠️ 基金实时估值已全行业下线（天天基金  下线、腾讯估值字段恒 0）：
//   指数基金 ≈ 95% 仓位跟着跟踪指数走，所以用**跟踪指数的实时涨跌幅**近似估算；
//   主动型基金（INDEXCODE 为 '--'）没有可跟踪的指数 → 估算净值/估算收益返回 null，
//   UI 显示「—」。**不编数**。
//
// 请求走原生（CapacitorHttp）绕开 WebView 的跨域限制；浏览器预览退回 fetch。

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const UA =
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const NAV_TTL = 5 * 60 * 1000 // 最新净值：5 分钟
const QUOTE_TTL = 60 * 1000 // 指数行情：1 分钟

const navCache = new Map() // code → { nav, date, pct, ts }
const indexCache = new Map() // code → { code, name } | null（静态映射，不失效）
const quoteCache = new Map() // indexCode → { pct, value, time, ts }

async function getText(url, timeoutMs = 8000) {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
    const d = res?.data
    if (typeof d === 'string') return d
    return d == null ? '' : JSON.stringify(d)
  }
  // 浏览器预览：直接 fetch（会被跨域拦住，属预期，界面显示「—」）
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(timer)
  }
}

const num = (v) => {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

/** 批量最新净值：一次请求拿全部代码（force=true 时忽略缓存，强制重新拉） */
export async function fetchLiveNav(codes, force = false) {
  const out = {}
  const need = []
  for (const c of codes) {
    const hit = navCache.get(c)
    if (!force && hit && Date.now() - hit.ts < NAV_TTL) out[c] = hit
    else need.push(c)
  }
  if (need.length === 0) return out

  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=200' +
    `&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1&Fcodes=${need.join(',')}`
  try {
    const raw = await getText(url)
    const list = JSON.parse(raw)?.Datas ?? []
    for (const x of list) {
      const code = String(x.FCODE ?? '').trim()
      if (!code) continue
      const rec = {
        nav: num(x.NAV),
        date: String(x.PDATE ?? '').trim(),
        pct: num(x.NAVCHGRT),
        ts: Date.now(),
      }
      navCache.set(code, rec)
      out[code] = rec
    }
  } catch {
    // 失败不缓存，下次重试；调用方按缺失处理
  }
  return out
}

/** 基金 → 跟踪指数（INDEXCODE 为 '--' 表示主动型，无指数） */
export async function fetchFundIndex(code) {
  if (indexCache.has(code)) return indexCache.get(code)
  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation' +
    `?FCODE=${code}&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1`
  try {
    const raw = await getText(url)
    const d = JSON.parse(raw)?.Datas ?? {}
    const idx = String(d.INDEXCODE ?? '').trim()
    const out = idx && idx !== '--' ? { code: idx, name: String(d.INDEXNAME ?? '').trim() } : null
    indexCache.set(code, out)
    return out
  } catch {
    return null // 失败不缓存，下次重试
  }
}

/**
 * 涨跌幅自己算：用现价/最新价 与 昨收 相除。
 * ⚠️ 不能直接用接口的 f[32]：个别标的（如停牌、数据错位）该字段会给出
 *    273.99 这种明显不是百分比的数，直接用会把整只基金的估算拉飞。
 * f[3]=现价（指数为点位）、f[4]=昨收。算不出来才退回 f[32]。
 */
function calcPct(f) {
  const now = num(f[3])
  const prev = num(f[4])
  if (now != null && prev != null && prev > 0) return ((now - prev) / prev) * 100
  return num(f[32])
}

/** 指数代码 → 腾讯行情代码（深市 399/980 用 sz，其余 sh） */
const quoteCode = (idx) => (/^(399|980|159)/.test(String(idx)) ? 'sz' : 'sh') + idx

/** 腾讯行情时间 → 10/16 16:14
    A 股是 14 位数字（20261016161415），港股是 2026/10/16 16:08:22，两种都要认。 */
function fmtQuoteTime(t) {
  const s = String(t ?? '').trim()
  if (/^\d{14}$/.test(s)) {
    return `${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`
  }
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/)
  if (m) return `${m[2]}/${m[3]} ${m[4]}:${m[5]}`
  return s
}

/** 批量指数实时行情（force=true 时忽略缓存） */
export async function fetchIndexQuotes(indexCodes, force = false) {
  const out = {}
  const need = []
  for (const i of indexCodes) {
    const hit = quoteCache.get(i)
    if (!force && hit && Date.now() - hit.ts < QUOTE_TTL) out[i] = hit
    else need.push(i)
  }
  if (need.length === 0) return out

  const url = `https://qt.gtimg.cn/q=${[...new Set(need.map(quoteCode))].join(',')}`
  try {
    const text = await getText(url)
    const re = /v_([a-z]{2}\d+)="([^"]*)"/g
    let m
    while ((m = re.exec(text))) {
      const qc = m[1]
      const idx = need.find((i) => quoteCode(i) === qc)
      if (!idx) continue
      const f = m[2].split('~')
      if (f.length < 33) continue
      const t = fmtQuoteTime(f[30])
      const rec = {
        pct: calcPct(f),
        value: num(f[3]),
        time: t,
        date: t.slice(0, 5), // MM/DD，用来判断「净值是不是已经含了这一天」
        ts: Date.now(),
      }
      quoteCache.set(idx, rec)
      out[idx] = rec
    }
  } catch {
    // 同上：失败不缓存
  }
  return out
}

/* ── 重仓股估算（主动型基金） ──
   主动型没有跟踪指数。退而用「前十大重仓股实时涨跌」按占净值比加权，
   这是行业通行的近似：假设其余持仓与前十大同步涨跌。
   持仓是季报数据（缓存 24 小时），行情 1 分钟。 */
const STOCK_TTL = 24 * 60 * 60 * 1000
const stockCache = new Map() // 基金代码 → 重仓股列表
const stockQuoteCache = new Map() // 腾讯股票代码 → { pct, time, ts }

/** 前十大重仓股：[{ dm, name, ratio(占净值%), exch }] */
export async function fetchFundStocks(code) {
  const hit = stockCache.get(code)
  if (hit && Date.now() - hit.ts < STOCK_TTL) return hit.list

  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition' +
    `?FCODE=${code}&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1`
  try {
    const raw = await getText(url)
    const list = (JSON.parse(raw)?.Datas?.fundStocks ?? [])
      .map((s) => ({
        dm: String(s.GPDM ?? '').trim(),
        name: String(s.GPJC ?? '').trim(),
        ratio: num(s.JZBL),
        exch: String(s.TEXCH ?? '').trim(), // 1 沪 / 2 深 / 5 港
      }))
      .filter((s) => s.dm && s.ratio != null && s.ratio > 0)
    stockCache.set(code, { list, ts: Date.now() })
    return list
  } catch {
    return [] // 失败不缓存，下次重试
  }
}

/** 股票 → 腾讯行情代码（1 沪 / 2 深 / 5 港） */
function stockQuoteCode(s) {
  if (s.exch === '5') return 'hk' + s.dm
  if (s.exch === '1') return 'sh' + s.dm
  if (s.exch === '2') return 'sz' + s.dm
  return (/^[68]/.test(s.dm) ? 'sh' : 'sz') + s.dm
}

/** 批量股票实时行情（与指数共用 1 分钟缓存节奏） */
export async function fetchStockQuotes(stocks, force = false) {
  const out = {}
  const need = []
  for (const s of stocks) {
    const qc = stockQuoteCode(s)
    const hit = stockQuoteCache.get(qc)
    if (!force && hit && Date.now() - hit.ts < QUOTE_TTL) out[qc] = hit
    else need.push(qc)
  }
  const uniq = [...new Set(need)]
  if (uniq.length === 0) return out

  try {
    const text = await getText(`https://qt.gtimg.cn/q=${uniq.join(',')}`)
    const re = /v_([a-z]{2}\d+)="([^"]*)"/g
    let m
    while ((m = re.exec(text))) {
      const f = m[2].split('~')
      if (f.length < 33) continue
      const pct = calcPct(f)
      // 单只股票单日涨跌超过 25% 视为数据异常（错位/停牌），不参与加权，宁可少算不编
      if (pct == null || Math.abs(pct) > 25) continue
      const t = fmtQuoteTime(f[30])
      const rec = { pct, time: t, date: t.slice(0, 5), ts: Date.now() }
      stockQuoteCache.set(m[1], rec)
      out[m[1]] = rec
    }
  } catch {
    // 失败不缓存
  }
  return out
}

/** 按占净值比加权，算重仓股的整体涨跌幅（拿不到行情的股票不计入权重） */
function weightedPct(list, quotes) {
  let w = 0
  let sum = 0
  let time = ''
  let date = ''
  for (const s of list) {
    const q = quotes[stockQuoteCode(s)]
    if (!q || q.pct == null) continue
    sum += s.ratio * q.pct
    w += s.ratio
    // 取**最新**的行情时间：停牌股的时间很旧，不能拿第一只的时间当整组的时间
    if (q.date && q.date >= date) {
      date = q.date
      time = q.time || time
    }
  }
  return w > 0 ? { pct: sum / w, time, date, weight: w } : null
}

/**
 * 持仓批量行情：净值 + 实时涨跌幅，合成每只基金的展示字段。
 *
 * ⚠️ 关键口径：**净值可能已经包含当天涨跌**。
 *   基金净值在收盘后公布（PDATE）。若 PDATE 与行情日期是同一天，
 *   说明这天已经收盘结算，净值本身已含当日涨跌 —— 此时再拿当日行情乘一遍，
 *   就是把同一天涨了两次（会把白酒指数 0.5397 显示成 0.5467）。
 *
 * 两种情形：
 *   ① 盘中（净值日期 < 行情日期）：estNav = 净值 × (1 + 实时涨跌)，
 *      当日收益 = 持有额 × 实时涨跌 ÷ 100（基准是昨日市值）
 *   ② 盘后（净值日期 = 行情日期）：estNav = 净值本身，
 *      涨跌幅 = 净值日涨跌幅（实际值），当日收益 = 持有额 × 涨跌幅 ÷ (100 + 涨跌幅)
 *      （基准已是今日市值）
 *
 * 实时涨跌的来源：有跟踪指数用指数；主动型用前十大重仓股加权；都没有则退回净值日涨跌。
 *
 * @param {string[]} codes
 * @param {{force?: boolean}} [opts] force = 忽略缓存（打开 App / 切回前台时用）
 * @returns {Record<string, {nav, navDate, navPct, indexCode, indexName, estNav, pct, pctFrom, time, pnlBase, navIncludesDay}>}
 *   pnlBase: 'yesterday'（盘中，基准昨日市值）| 'today'（盘后，基准今日市值）
 */
export async function fetchHoldingsLive(codes, { force = false } = {}) {
  const uniq = [...new Set(codes.filter(Boolean))]
  const result = {}
  if (uniq.length === 0) return result

  const [navMap, idxList] = await Promise.all([
    fetchLiveNav(uniq, force),
    Promise.all(uniq.map(fetchFundIndex)),
  ])

  const idxByFund = {}
  idxList.forEach((v, i) => {
    idxByFund[uniq[i]] = v
  })

  const quoteMap = await fetchIndexQuotes(
    [...new Set(Object.values(idxByFund).filter(Boolean).map((v) => v.code))],
    force,
  )

  // 主动型（无跟踪指数）走重仓股加权
  const noIdx = uniq.filter((c) => !idxByFund[c])
  const stockLists = {}
  await Promise.all(
    noIdx.map(async (c) => {
      stockLists[c] = await fetchFundStocks(c)
    }),
  )
  const allStocks = Object.values(stockLists).flat()
  const stockQuotes = allStocks.length ? await fetchStockQuotes(allStocks, force) : {}

  for (const code of uniq) {
    const nav = navMap[code] || null
    const idx = idxByFund[code] || null
    const q = idx ? quoteMap[idx.code] || null : null
    const w = !idx && stockLists[code]?.length ? weightedPct(stockLists[code], stockQuotes) : null
    // 重仓股覆盖的仓位太少（<30%，如 QDII 或持仓拿不全）时，不足以代表整只基金，
    // 宁可不给实时估算，退回净值日涨跌
    const wPct = w && w.weight >= 30 ? w.pct : null

    const livePct = q?.pct ?? wPct ?? null
    const liveTime = (q?.pct != null ? q.time : wPct != null ? w.time : '') || ''
    const liveDate = (q?.pct != null ? q.date : wPct != null ? w.date : '') || ''
    const navMD = nav?.date ? nav.date.slice(5).replace('-', '/') : ''
    const navIncludesDay = !!(liveDate && navMD && liveDate === navMD)

    let estNav = null
    let pct = null
    let pnlBase = 'today'
    let from = ''

    if (navIncludesDay) {
      // 净值已含当日涨跌：净值就是最新值，涨跌用净值自带的实际值
      estNav = nav?.nav ?? null
      pct = nav?.pct ?? livePct ?? null
      pnlBase = 'today'
      from = 'nav'
    } else {
      // 盘中：净值是上一交易日的，用实时行情推估算值
      estNav = nav?.nav != null && livePct != null ? nav.nav * (1 + livePct / 100) : null
      pct = livePct ?? nav?.pct ?? null
      pnlBase = livePct != null ? 'yesterday' : 'today'
      from = q?.pct != null ? 'index' : wPct != null ? 'stocks' : nav?.pct != null ? 'nav' : ''
    }

    result[code] = {
      nav: nav?.nav ?? null,
      navDate: nav?.date ?? '',
      navPct: nav?.pct ?? null,
      indexCode: idx?.code ?? '',
      indexName: idx?.name ?? '',
      estNav,
      pct,
      pctFrom: from,
      time: liveTime || (nav?.date ? nav.date.slice(5).replace('-', '/') : ''),
      pnlBase,
      navIncludesDay,
    }
  }
  return result
}
