// src/lib/trade_status.js · 基金交易状态（申购/赎回）与限购额度
// ------------------------------------------------------------
// 数据源：天天基金 FundMNBasicInformation —— 它给的是**状态字段**（SGZT / SHZT /
// BUY / ISSALES）与额度（MINSG / MAXSG / MINRG / MINDT），不是日历推算。
// 境外休市、封闭期、暂停申购、限大额都会直接体现在字段里。
//
// 状态四态：open（开放）/ limited（有限额）/ closed（暂停）/ unknown（查不到）。
// 查不到、字段缺失、请求失败一律 unknown —— 不猜、不默认当开放。
//
// 缓存：localStorage 按**本地日期**判新鲜度，跨天自动重抓
//（限购金额与暂停状态每天都会变，昨天的结论今天不能直接用）。

import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { todayStr } from './date.js'

const KEY = 'trade_status_cache:'
/** 缓存结构版本：解析字段有增删就 +1，旧结构缓存自动作废重抓
    （否则同一天内加了新字段，界面会一直用缺字段的旧缓存，静默显示「—」） */
const SCHEMA = 2
const BASE = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation'

/** 把接口文本状态归成四态之一 */
export function toTradeState(text) {
  const s = String(text || '').trim()
  if (!s || s === '--') return 'unknown'
  if (s.includes('暂停') || s.includes('封闭') || s.includes('终止') || s.includes('停止')) {
    return 'closed'
  }
  if (s.includes('限')) return 'limited'
  if (s.includes('开放') || s.includes('正常') || s.includes('认购')) return 'open'
  return 'unknown'
}

const STATE_LABEL = { open: '开放', limited: '有限额', closed: '暂停', unknown: '未知' }
export function stateLabel(state) {
  return STATE_LABEL[state] || '未知'
}

function text(v) {
  const s = String(v ?? '').trim()
  return !s || s === '--' ? '' : s
}

function amount(v) {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n >= NO_LIMIT ? null : n
}

/** 接口给的「天数」字段：缺失或 0 一律 null，不当成 0 天 */
function daysOf(v) {
  if (v == null) return null
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? n : null
}

// 按基金代码分 key 存（KEY + code），写入时只动自己那一条，
// 避免同会话多只基金并发刷新时「读全量 → 整写」互相覆盖掉对方的结果。
function readOne(code) {
  try {
    const o = JSON.parse(localStorage.getItem(KEY + code) || 'null')
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

/** 读缓存（同步，无则 null；结构版本不匹配的旧缓存一律当没有） */
export function loadTradeStatus(code) {
  if (!code) return null
  const c = readOne(code)
  return c && c.schema === SCHEMA ? c : null
}

/** 缓存是否过期：跨天就要重抓 */
export function isTradeStatusStale(code) {
  const c = readOne(code)
  return !c || c.date !== todayStr()
}

/** 取字符串字段；取不到返回空串 */
function field(raw, key) {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)`))
  return m ? m[1] : ''
}

/** 取数字字段；接口有时给数字、有时给字符串，两种都接。取不到返回 null */
function numField(raw, key) {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)"?`))
  return m ? Number(m[1]) : null
}

/** 接口用超大值表示「不限」，超过这个阈值就按无上限处理 */
const NO_LIMIT = 1e11

/** 取布尔字段；取不到返回 null */
function boolField(raw, key) {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`))
  return m ? m[1] === 'true' : null
}

/* 该接口 Content-Type 是 application/json，CapacitorHttp 会把 data 直接解析成对象
   （{Datas:{...}} 或平铺）；异常路径才可能是字符串原文。两种形态都要能读，
   否则会静默变成「未知」。 */
function asObject(src) {
  if (!src || typeof src !== 'object') return null
  const d = src.Datas && typeof src.Datas === 'object' ? src.Datas : src
  return d && typeof d === 'object' ? d : null
}

function strOf(obj, raw, key) {
  if (obj) {
    const v = obj[key]
    return v == null ? '' : String(v)
  }
  return raw ? field(raw, key) : ''
}

function numOf(obj, raw, key) {
  if (obj) {
    const v = obj[key]
    if (v == null || v === '' || v === '--') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return raw ? numField(raw, key) : null
}

function boolOf(obj, raw, key) {
  if (obj) {
    if (obj[key] === true || obj[key] === 'true') return true
    if (obj[key] === false || obj[key] === 'false') return false
    return null
  }
  return raw ? boolField(raw, key) : null
}

/**
 * 从接口响应里抽状态字段。
 * 字符串路径不用整体 JSON.parse：响应里个别字段是 Python dict 字面量（单引号，如
 * FUNDBONUS），整串解析会抛错；而这里只需要标量字段，按字段抽更稳。
 */
function parseStatus(src, code) {
  const obj = asObject(src)
  const raw = obj ? null : typeof src === 'string' ? src : ''
  if (obj ? !('SGZT' in obj) : !raw.includes('SGZT')) return null

  const buyFlag = boolOf(obj, raw, 'BUY')
  const sellFlag = numOf(obj, raw, 'ISSALES')
  return {
    schema: SCHEMA,
    date: todayStr(),
    code,
    buyState: buyFlag === false ? 'closed' : toTradeState(strOf(obj, raw, 'SGZT')),
    sellState: sellFlag === 0 ? 'closed' : toTradeState(strOf(obj, raw, 'SHZT')),
    buyMark: text(strOf(obj, raw, 'SGZTMARK')) || text(strOf(obj, raw, 'SGZT')),
    sellMark: text(strOf(obj, raw, 'SHZT')),
    minBuy: amount(numOf(obj, raw, 'MINSG')),
    maxBuy: amount(numOf(obj, raw, 'MAXSG')),
    minSell: amount(numOf(obj, raw, 'MINRG')),
    minDt: amount(numOf(obj, raw, 'MINDT')),
    redeemArrive: text(strOf(obj, raw, 'YZBA')),
    confirmDay: text(strOf(obj, raw, 'SSBCFDAY')),
    buyConfirmDays: daysOf(numOf(obj, raw, 'SSBCFMDATA')),
    redeemConfirmDays: daysOf(numOf(obj, raw, 'RDMCFMDATA')),
    redeemArriveDays: daysOf(numOf(obj, raw, 'DRAWCFMDATA')),
    dividendArrive: text(strOf(obj, raw, 'FBYZQ')),
  }
}

async function fetchViaHttp(code) {
  const url = `${BASE}?FCODE=${encodeURIComponent(code)}&deviceid=1&plat=Android&product=EFund&version=6.2.8`
  const res = await CapacitorHttp.get({
    url,
    headers: { Referer: 'https://h5.1234567.com.cn/' },
    responseType: 'text',
    connectTimeout: 12000,
    readTimeout: 12000,
  })
  const src = res?.data
  if (src == null || src === '') throw new Error('接口返回为空')
  const st = parseStatus(src, code)
  if (!st) throw new Error('接口无该基金的交易状态字段')
  return st
}

/**
 * 抓一次交易状态并写缓存；失败返回 null（界面照旧显示 unknown）
 * @returns {Promise<object|null>}
 */
export async function refreshTradeStatus(code) {
  if (!code) return null
  if (!Capacitor.isNativePlatform()) return null
  try {
    const st = await fetchViaHttp(code)
    try {
      localStorage.setItem(KEY + code, JSON.stringify(st))
    } catch {
      /* 配额满：本次结果仍返回，只是不落盘 */
    }
    return st
  } catch {
    return null
  }
}

/**
 * 申购门控：看申购状态字段，不推算日历
 * @returns {{ok:boolean|null, state:string, text:string}} ok 为 null = 状态未知
 */
export function buyGate(st) {
  if (!st) return { ok: null, state: 'unknown', text: '申购状态未知，无法确认现在能不能买' }
  if (st.buyState === 'closed') {
    return { ok: false, state: 'closed', text: st.buyMark || '该基金暂停申购' }
  }
  if (st.buyState === 'limited') {
    const cap = st.maxBuy
    return {
      ok: true,
      state: 'limited',
      text: cap ? `限大额：单日累计最多 ${cap.toLocaleString('zh-CN')} 元` : st.buyMark || '限大额',
    }
  }
  if (st.buyState === 'open') {
    return { ok: true, state: 'open', text: st.buyMark || '开放申购' }
  }
  return { ok: null, state: 'unknown', text: '申购状态未知，无法确认现在能不能买' }
}

/**
 * 赎回门控
 * @returns {{ok:boolean|null, state:string, text:string}}
 */
export function sellGate(st) {
  if (!st) return { ok: null, state: 'unknown', text: '赎回状态未知，无法确认现在能不能卖' }
  if (st.sellState === 'closed') {
    return { ok: false, state: 'closed', text: st.sellMark || '该基金暂停赎回' }
  }
  if (st.sellState === 'limited') {
    return { ok: true, state: 'limited', text: st.sellMark || '赎回有限额' }
  }
  if (st.sellState === 'open') {
    return { ok: true, state: 'open', text: st.sellMark || '开放赎回' }
  }
  return { ok: null, state: 'unknown', text: '赎回状态未知，无法确认现在能不能卖' }
}

/** 金额是否超过单日申购上限（无上限信息时返回 false） */
export function overBuyLimit(st, amount) {
  if (!st || st.maxBuy == null) return false
  const n = Number(amount)
  return Number.isFinite(n) && n > st.maxBuy
}

/** 金额是否低于起购门槛（无门槛信息时返回 false） */
export function underMinBuy(st, amount) {
  if (!st || st.minBuy == null) return false
  const n = Number(amount)
  return Number.isFinite(n) && n > 0 && n < st.minBuy
}
