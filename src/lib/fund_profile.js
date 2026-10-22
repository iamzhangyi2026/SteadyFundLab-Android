// src/lib/fund_profile.js · 基金档案（C8：基金经理 / 评级 / 投资风格）
// ------------------------------------------------------------
// 数据源：东财基金移动端接口（FundMNManagerList / FundMNRating）。
// ⚠️ 这两个接口的字段名并不稳定，解析一律「宽松取第一个非空」，
//    取不到就返回 null —— 界面显示「暂无」，不编造经理姓名或星级。
// 投资风格需要「大盘/中小盘 × 价值/成长」两维数据，公开接口没有可靠字段，
// 本模块不猜，固定返回 null，由界面如实标注「未提供」。

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const CACHE_PREFIX = 'fund_profile_v1_'
const TTL = 24 * 60 * 60 * 1000
const UA =
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

async function getJson(url, timeoutMs = 9000) {
  try {
    if (Capacitor.isNativePlatform()) {
      const res = await CapacitorHttp.get({
        url,
        headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      })
      const d = res?.data
      if (d && typeof d === 'object') return d
      return JSON.parse(typeof d === 'string' ? d : String(d || '{}'))
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(url, { signal: ctrl.signal })
      return await r.json()
    } finally {
      clearTimeout(t)
    }
  } catch {
    return null
  }
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null
  for (const k of keys) {
    const v = obj[k]
    if (v != null && String(v).trim() !== '' && String(v).trim() !== '--') return v
  }
  return null
}

const base = (path, code) =>
  `https://fundmobapi.eastmoney.com/FundMNewApi/${path}` +
  `?FCODE=${code}&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1`

async function fetchManager(code) {
  const json = await getJson(base('FundMNManagerList', code))
  if (!json) return null
  const datas = json.Datas
  const list = Array.isArray(datas)
    ? datas
    : datas?.FundManagers || datas?.ManagerList || datas?.Datas || []
  if (!Array.isArray(list) || list.length === 0) return null

  const people = list
    .map((m) => ({
      name: pick(m, ['MGRNAME', 'MGR_NAME', 'NAME', 'JLNAME', 'MANAGERNAME']),
      startDate: pick(m, ['FSRQ', 'STARTDATE', 'RZRQ', 'FUNDMANAGERSTARTDATE']),
      days: pick(m, ['DAYS', 'RZTS', 'MANAGEDAYS']),
      returnPct: pick(m, ['PENAVG', 'HL', 'RETURN', 'MANAGERRETURN']),
    }))
    .filter((m) => m.name)

  return people.length ? people : null
}

async function fetchRating(code) {
  const json = await getJson(base('FundMNRating', code))
  if (!json) return null
  const d = json.Datas
  if (!d) return null
  const raw = pick(d, ['RATING', 'STAR', 'STARLEVEL', 'JJPJ', 'GRADE'])
  if (raw == null) return null
  const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10)
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : null
}

/**
 * 一次拿全基金档案
 * @returns {Promise<{manager: Array|null, rating: number|null, styleBox: null, fetchedAt: number}>}
 */
export async function fetchFundProfile(code) {
  if (!code) return { manager: null, rating: null, styleBox: null, fetchedAt: Date.now() }
  const key = CACHE_PREFIX + code
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const obj = JSON.parse(raw)
      if (obj && Date.now() - obj.fetchedAt < TTL) return obj
    }
  } catch {
    // 缓存坏了就重抓
  }

  const [manager, rating] = await Promise.all([fetchManager(code), fetchRating(code)])
  const value = { manager, rating, styleBox: null, fetchedAt: Date.now() }
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 忽略
  }
  return value
}
