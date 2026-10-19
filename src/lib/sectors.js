// src/lib/sectors.js · 行业板块行情（C3 板块信号）
// ------------------------------------------------------------
// 数据源：东财板块行情（push2 clist，fs=m:90+t:2 行业板块）。
// 返回按涨跌幅排序的板块列表；拿不到返回空数组，界面显示「暂不可达」。
//
// 板块接口含二级/三级重复（如「航空装备Ⅱ/Ⅲ」），按名称去重时保留第一条。

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const UA =
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

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

/**
 * 行业板块行情
 * @param {number} limit 取多少个板块（按涨跌幅降序）
 * @returns {Promise<Array<{code,name,pct,price}>>}
 */
export async function fetchSectors(limit = 40) {
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get' +
    `?pn=1&pz=${limit * 2}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2` +
    '&fields=f12,f14,f3,f2'
  try {
    const raw = await getText(url)
    const diff = JSON.parse(raw)?.data?.diff || []
    const seen = new Set()
    const rows = []
    for (const d of diff) {
      const name = String(d.f14 || '').trim()
      const pct = num(d.f3)
      if (!name || pct == null) continue
      // 去掉 Ⅱ/Ⅲ 后缀造成的重复
      const base = name.replace(/[ⅠⅡⅢ]+$/, '')
      if (seen.has(base)) continue
      seen.add(base)
      rows.push({ code: String(d.f12 || ''), name: base, pct, price: num(d.f2) })
      if (rows.length >= limit) break
    }
    return rows
  } catch {
    return []
  }
}
