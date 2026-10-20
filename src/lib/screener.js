// src/lib/screener.js · 全市场基金筛选（完整版）
// ------------------------------------------------------------
// 数据源：天天基金排行接口（rankhandler.aspx），返回全市场约 1.8 万只基金，
// 字段含：代码 / 名称 / 单位净值 / 累计净值 / 日涨幅 / 近1周 / 近1月 /
//         近3月 / 近6月 / 近1年 / 近2年 / 近3年 / 今年来 / 成立来 /
//         成立日期 / 原始费率 / 折后费率 / 规模（亿）。
//
// 排行本身没有「历史分位 / 最大回撤 / 年化波动」——这三项需要逐只抓
// pingzhongdata 历史净值。所以分两步：
//   ① fetchFundRank   拉排行（快，1 个请求）
//   ② enrichHistory   对当前页前 N 只补分位/回撤/波动（慢，每只 1 个请求）
//
// 筛选口径对齐项目 screen_rules：近1年 > 0、分位 < 50%、最大回撤 < 50%。
// 拿不到的字段保持 null，不参与筛选、不填 0。

import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { fetchFundCached } from './navCache.js'
import { navPercentile } from './deep_analysis.js'
import { drawdownRecovery, annualVol } from './navlab.js'
import { detectJumps } from './navSanitize.js'

const UA =
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

const SORT_OPTIONS = [
  { key: '1nzf', label: '近1年' },
  { key: '6yzf', label: '近6月' },
  { key: '3yzf', label: '近3月' },
  { key: 'jnzf', label: '今年来' },
]
export { SORT_OPTIONS }

async function getText(url, timeoutMs = 12000) {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
    const d = res?.data
    return typeof d === 'string' ? d : d == null ? '' : JSON.stringify(d)
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace('%', ''))
  return Number.isFinite(n) ? n : null
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 排行行解析：逗号分隔，索引见文件头注释 */
function parseRow(s) {
  const f = String(s).split(',')
  return {
    code: f[0],
    name: f[1],
    date: f[3] || '',
    nav: num(f[4]),
    accNav: num(f[5]),
    dayPct: num(f[6]),
    w1: num(f[7]),
    m1: num(f[8]),
    m3: num(f[9]),
    m6: num(f[10]),
    y1: num(f[11]),
    y2: num(f[12]),
    y3: num(f[13]),
    ytd: num(f[14]),
    since: num(f[15]),
    establish: f[16] || '',
    sourceRate: num(f[19]),
    rate: num(f[20]),
    scale: num(f[24]),
  }
}

/**
 * 拉一页基金排行
 * @param {{page?:number, size?:number, sort?:string, order?:'desc'|'asc'}} opts
 * @returns {Promise<{rows:Array, total:number}>}
 */
export async function fetchFundRank({ page = 1, size = 20, sort = '1nzf', order = 'desc' } = {}) {
  const end = fmtDate(new Date())
  const s = new Date()
  s.setFullYear(s.getFullYear() - 1)
  const start = fmtDate(s)
  const url =
    'https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=all&rs=&gs=0' +
    `&sc=${sort}&st=${order}&sd=${start}&ed=${end}&qdii=&tabSubtype=,,,,,&pi=${page}&pn=${size}&dx=1`
  try {
    const raw = await getText(url)
    const arr = [...raw.matchAll(/"([^"]*)"/g)]
      .map((m) => m[1])
      .filter((s2) => /^\d{6},/.test(s2))
    const total = Number((raw.match(/allRecords:(\d+)/) || [])[1] || 0)
    return { rows: arr.map(parseRow), total }
  } catch {
    return { rows: [], total: 0 }
  }
}

/**
 * 给排行行补历史指标（分位 / 最大回撤 / 年化波动）
 * 每只一次 pingzhongdata 请求（走缓存）；失败的那只保持 null，不猜。
 *
 * 数据源异常跳变防护（v21 口径）：净值序列含单日 ≥50% 跳变时，
 * 分位/回撤/波动全部失真（001594 ），该行标 `suspect: true`，
 * `screenRows` 会把它排除，不用失真指标参与筛选。
 */
export async function enrichHistory(rows) {
  return Promise.all(
    (rows || []).map(async (r) => {
      try {
        const series = await fetchFundCached(r.code)
        if (series.length === 0) {
          return { ...r, percentile: null, maxDrawdown: null, vol: null, samples: 0, suspect: false }
        }
        if (detectJumps(series).length > 0) {
          return { ...r, percentile: null, maxDrawdown: null, vol: null, samples: series.length, suspect: true }
        }
        return {
          ...r,
          percentile: navPercentile(series),
          maxDrawdown: drawdownRecovery(series)?.maxDrawdown ?? null,
          vol: annualVol(series),
          samples: series.length,
          suspect: false,
        }
      } catch {
        return { ...r, percentile: null, maxDrawdown: null, vol: null, samples: 0, suspect: false }
      }
    }),
  )
}

/**
 * 三轨筛选（对齐 screen_rules）
 * @param {Array} rows enrichHistory 后的行
 * @param {{maxPercentile?:number, maxDrawdown?:number, minY1?:number, maxVol?:number}} rules
 */
export function screenRows(
  rows,
  { maxPercentile = 50, maxDrawdown = 50, minY1 = 0, maxVol = null } = {},
) {
  return (rows || []).filter((r) => {
    if (r.suspect) return false
    if (r.y1 == null || r.y1 < minY1) return false
    if (r.percentile == null || r.percentile > maxPercentile) return false
    if (r.maxDrawdown == null || Math.abs(r.maxDrawdown) > maxDrawdown) return false
    if (maxVol != null && (r.vol == null || r.vol > maxVol)) return false
    return true
  })
}

/** 综合分：分位越低越好、近1年越高越好、回撤越小越好（0–100） */
export function scoreOf(r) {
  if (r.percentile == null || r.y1 == null || r.maxDrawdown == null) return null
  const p = 100 - Math.min(100, Math.max(0, r.percentile))
  const y = Math.min(100, Math.max(0, (r.y1 + 30) * 2)) // -30% → 0，+20% → 100
  const d = 100 - Math.min(100, Math.abs(r.maxDrawdown) * 2) // 0% → 100，50% → 0
  return +(p * 0.4 + y * 0.35 + d * 0.25).toFixed(1)
}
