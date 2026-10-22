/**
 * 基金数据抓取 —— 纯前端，零后端。
 *
 * 数据源：天天基金 pingzhongdata 接口（返回一段 JS 变量赋值文本）。
 *
 * 两条取数路径：
 *   1. 原生（App 内，生产路径）：CapacitorHttp 取回文本后自己解析变量。
 *      不执行远程代码、不读 window 全局 —— 并发抓多只基金时不会互相串数据。
 *   2. 浏览器（npm run dev 调试）：走 <script> 注入绕 CORS，变量挂在 window 上；
 *      并发会互相覆盖，所以只用于调试，不进生产调用链。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const CACHE = new Map()
const PING_BASE = 'https://fund.eastmoney.com/pingzhongdata/'

/**
 * 从 pingzhongdata 文本里切出 `var 名字 = 表达式;` 的表达式片段。
 * 扫描时跳过字符串内部，遇到顶层分号结束。
 * @param {string} text 接口原文
 * @param {string} name 变量名
 * @returns {string|null} 表达式文本，取不到返回 null
 */
function sliceExpr(text, name) {
  const at = text.indexOf(`var ${name}`)
  if (at < 0) return null
  let i = text.indexOf('=', at)
  if (i < 0) return null
  i += 1
  const start = i
  let depth = 0
  let quote = null
  for (; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ';' && depth <= 0) return text.slice(start, i).trim()
  }
  return text.slice(start).trim()
}

/** 取标量变量（字符串去引号，数字原样返回文本） */
function scalar(text, name) {
  const raw = sliceExpr(text, name)
  if (raw == null) return null
  const m = raw.match(/^"([\s\S]*)"$/) || raw.match(/^'([\s\S]*)'$/)
  return m ? m[1] : raw
}

/** 取数组变量；原文不是合法 JSON 时返回空数组，绝不抛错污染界面 */
function arrayOf(text, name) {
  const raw = sliceExpr(text, name)
  if (raw == null) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 费率类字段：解析不出有限数就返回 null，不让 NaN 进界面 */
function rate(text, name) {
  const n = parseFloat(scalar(text, name))
  return Number.isFinite(n) ? n : null
}

/** 把 pingzhongdata 文本解析成基金数据结构（与旧 window 全局路径同构） */
function buildFundData(text, code) {
  // ⚠️ 接口返回的数组不保证按日期升序，显式排序，不依赖接口顺序。
  const netWorth = arrayOf(text, 'Data_netWorthTrend').slice().sort((a, b) => a.x - b.x)
  // 两个数组格式不一样：
  //   Data_netWorthTrend = [{x, y, equityReturn, unitMoney}, ...]  对象数组
  //   Data_ACWorthTrend  = [[时间戳, 累计净值], ...]               数组的数组
  // 不归一化的话累计净值的 d.y 恒为 undefined，区间涨幅会算成 NaN 渲染到界面。
  const accWorth = arrayOf(text, 'Data_ACWorthTrend')
    .map((item) => (Array.isArray(item) ? { x: item[0], y: item[1] } : item))
    .sort((a, b) => a.x - b.x)

  return {
    code: scalar(text, 'fS_code') || code,
    name: scalar(text, 'fS_name') || '',
    sourceRate: rate(text, 'fund_sourceRate'), // 原始费率（%）
    rate: rate(text, 'fund_Rate'),             // 折后费率（%）
    minBuy: scalar(text, 'fund_minsg'),
    netWorth,
    accWorth,
    stockCodes: arrayOf(text, 'stockCodes'),
  }
}

/** 原生路径：取回文本自己解析，不执行远程代码、不碰 window 全局 */
async function fetchViaHttp(code) {
  // 时间戳降到分钟级：同一分钟内复用，不再每次刷新都强制回源
  const url = `${PING_BASE}${code}.js?v=${Math.floor(Date.now() / 60000)}`
  const res = await CapacitorHttp.get({
    url,
    headers: { Referer: 'https://fund.eastmoney.com/' },
    responseType: 'text',
    connectTimeout: 12000,
    readTimeout: 12000,
  })
  const text = typeof res?.data === 'string' ? res.data : ''
  if (!text) throw new Error('接口返回为空')
  const data = buildFundData(text, code)
  if (data.netWorth.length === 0) throw new Error('净值序列为空（解析失败或源无数据）')
  return data
}

/**
 * 抓某只基金的 pingzhongdata（净值历史 / 累计净值 / 费率 / 名称）
 * 用 script 标签注入绕过 CORS；同一 code 的内存缓存命中后不再请求。
 * @param {string} code 6 位基金代码
 * @returns {Promise<{code:string,name:string,netWorth:Array,accWorth:Array,rate:number,sourceRate:number}>}
 */
/** 浏览器调试路径：注入 <script> 绕 CORS，变量挂在 window 上（并发不安全，仅 dev 用） */
function fetchViaScript(code) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${PING_BASE}${code}.js?v=${Date.now()}`
    script.charset = 'utf-8'

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('请求超时（12 秒）'))
    }, 12000)

    function cleanup() {
      clearTimeout(timer)
      script.remove()
    }

    script.onload = () => {
      try {
        // ⚠️ 接口返回的数组不保证按日期升序，显式排序，不依赖接口顺序。
        const netWorth = [...(window.Data_netWorthTrend || [])].sort(
          (a, b) => a.x - b.x
        )
        // 两个数组格式不一样：
        //   Data_netWorthTrend = [{x, y, equityReturn, unitMoney}, ...]  对象数组
        //   Data_ACWorthTrend  = [[时间戳, 累计净值], ...]               数组的数组
        // 不归一化的话累计净值的 d.y 恒为 undefined，区间涨幅会算成 NaN 渲染到界面。
        const accWorth = (window.Data_ACWorthTrend || [])
          .map((item) => (Array.isArray(item) ? { x: item[0], y: item[1] } : item))
          .sort((a, b) => a.x - b.x)

        const data = {
          code: window.fS_code,
          name: window.fS_name,
          sourceRate: parseFloat(window.fund_sourceRate), // 原始费率（%）
          rate: parseFloat(window.fund_Rate),             // 折后费率（%）
          minBuy: window.fund_minsg,
          netWorth,   // [{ x: 时间戳, y: 单位净值, equityReturn: 日涨幅, unitMoney: 分红 }]
          accWorth,   // [{ x: 时间戳, y: 累计净值 }]
          stockCodes: window.stockCodes || [],
        }

        CACHE.set(code, data)
        cleanup()
        resolve(data)
      } catch (e) {
        cleanup()
        reject(e)
      }
    }

    script.onerror = () => {
      cleanup()
      reject(new Error('接口不可达'))
    }

    document.head.appendChild(script)
  })
}

/**
 * 抓某只基金的 pingzhongdata（净值历史 / 累计净值 / 费率 / 名称）
 * 原生走 CapacitorHttp 解析文本，浏览器调试才走 script 注入；
 * 同一 code 的内存缓存命中后不再请求。
 * @param {string} code 6 位基金代码
 * @returns {Promise<{code:string,name:string,netWorth:Array,accWorth:Array,rate:number,sourceRate:number}>}
 */
export function fetchFund(code) {
  if (CACHE.has(code)) return Promise.resolve(CACHE.get(code))
  const task = Capacitor.isNativePlatform() ? fetchViaHttp(code) : fetchViaScript(code)
  return task.then((data) => {
    CACHE.set(code, data)
    return data
  })
}

/** 从净值序列里取最新一条 */
export function latestNetWorth(netWorth) {
  if (!netWorth || netWorth.length === 0) return null
  return netWorth[netWorth.length - 1]
}

/** 时间戳 → 本地时区日期。
 *  style 'iso'：YYYY-MM-DD；style 'short'：MM/DD。
 *  ⚠️ 不能用 toISOString()——它输出 UTC，接口的时间戳是北京时间零点，
 *     直接转会把日期显示成前一天。 */
export function fmtNavDate(ts, style = 'iso') {
  if (ts == null) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  if (style === 'short') return `${p(d.getMonth() + 1)}/${p(d.getDate())}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 日涨跌幅（%）—— 用最近两个交易日的单位净值算 */
export function dayChange(netWorth) {
  if (!netWorth || netWorth.length < 2) return null
  const last = netWorth[netWorth.length - 1]
  const prev = netWorth[netWorth.length - 2]
  const a = Number(prev.y)
  const b = Number(last.y)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null
  return ((b - a) / a) * 100
}

/** 取最近 n 个点的净值序列，用于画迷你走势 */
export function recentSeries(netWorth, n = 60) {
  if (!netWorth || netWorth.length === 0) return []
  return netWorth.slice(-n).map((d) => Number(d.y)).filter(Number.isFinite)
}

/** 统计区间涨幅（%）—— 用累计净值算，这是历史表现口径 */
export function rangeReturn(accWorth, days) {
  if (!accWorth || accWorth.length < 2) return null
  const last = accWorth[accWorth.length - 1]
  const cutoff = last.x - days * 86400000
  const start = accWorth.find((d) => d.x >= cutoff) || accWorth[0]
  if (!start) return null
  // 显式校验：脏数据一律返回 null，绝不把 NaN 渲染到界面上
  const a = Number(start.y)
  const b = Number(last.y)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null
  return ((b - a) / a) * 100
}
