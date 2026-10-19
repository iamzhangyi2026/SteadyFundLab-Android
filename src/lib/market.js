// src/lib/market.js · 大盘指数（C9）
// ------------------------------------------------------------
// 五大指数实时点位 + 日 K 线。数据源：
//   实时：腾讯 qt.gtimg.cn（与 live.js 同一套行情源，避免多源口径不一）
//   历史：东财 push2his kline（前复权日线）
//
// 拿不到就返回空数组 / null，界面显示「—」，不编数。

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const UA =
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

/** 五大指数：code 用于腾讯行情，secid 用于东财 K 线（1=沪 0=深） */
export const INDICES = [
  { code: '000001', name: '上证指数', secid: '1.000001' },
  { code: '399001', name: '深证成指', secid: '0.399001' },
  { code: '399006', name: '创业板指', secid: '0.399006' },
  { code: '000300', name: '沪深300', secid: '1.000300' },
  { code: '000905', name: '中证500', secid: '1.000905' },
]

const quoteCode = (idx) => (/^(399|980|159)/.test(String(idx)) ? 'sz' : 'sh') + idx

async function getText(url, timeoutMs = 10000) {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
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
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

/** 涨跌幅：现价 / 昨收，算不出才退回接口字段 */
function calcPct(f) {
  const now = num(f[3])
  const prev = num(f[4])
  if (now != null && prev != null && prev > 0) return ((now - prev) / prev) * 100
  return num(f[32])
}

function fmtQuoteTime(t) {
  const s = String(t ?? '').trim()
  if (/^\d{14}$/.test(s)) {
    return `${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`
  }
  return s
}

/** 批量实时点位：返回 { [code]: { value, pct, time } } */
export async function fetchMarketQuotes() {
  const url = `https://qt.gtimg.cn/q=${INDICES.map((i) => quoteCode(i.code)).join(',')}`
  const out = {}
  try {
    const text = await getText(url)
    const re = /v_([a-z]{2}\d+)="([^"]*)"/g
    let m
    while ((m = re.exec(text))) {
      const hit = INDICES.find((i) => quoteCode(i.code) === m[1])
      if (!hit) continue
      const f = m[2].split('~')
      if (f.length < 33) continue
      out[hit.code] = {
        value: num(f[3]),
        pct: calcPct(f),
        time: fmtQuoteTime(f[30]),
      }
    }
  } catch {
    // 失败返回空，调用方显示「—」
  }
  return out
}

/** 指数日 K 线：[{date, close}]，按日期升序；失败返回 [] */
export async function fetchIndexKline(secid, limit = 120) {
  /* 数据源：腾讯 ifzq（东财 push2his 在本机网络层下返回空 data，
     故指数 K 线走腾讯源）。
     secid '1.000300' → sh000300；'0.399001' → sz399001。
     返回行格式 [date, open, close, high, low, volume]，close 取索引 2。 */
  const [mkt, code] = String(secid).split('.')
  const qc = (mkt === '0' ? 'sz' : 'sh') + code
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${qc},day,,,${limit},qfq`
  try {
    const raw = await getText(url)
    const d = JSON.parse(raw)?.data?.[qc] || {}
    const arr = d.qfqday || d.day || []
    return arr
      .map((row) => {
        const close = num(row[2])
        return row[0] && close != null ? { date: String(row[0]), close } : null
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 大盘页一次拿全：五大指数实时 + 每个指数近 60 日走势 + 沪深300 近 120 日 */
export async function loadMarketOverview() {
  const [quotes, ...klines] = await Promise.all([
    fetchMarketQuotes(),
    ...INDICES.map((i) => fetchIndexKline(i.secid, 60)),
  ])
  const idx300 = INDICES.findIndex((i) => i.code === '000300')
  const kline300 = await fetchIndexKline('1.000300', 120)
  return {
    indices: INDICES.map((i, idx) => ({
      ...i,
      value: quotes[i.code]?.value ?? null,
      pct: quotes[i.code]?.pct ?? null,
      time: quotes[i.code]?.time ?? '',
      kline: klines[idx] || [],
    })),
    kline: kline300.length ? kline300 : klines[idx300] || [],
  }
}
