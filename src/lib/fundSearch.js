/**
 * 全市场基金搜索 —— 纯前端，零后端。
 *
 * 数据源：天天基金 FundSearch suggest 接口（key=关键词，返回 Datas 数组）。
 *
 * 两条取数路径（与 eastmoney.js 同构）：
 *   1. 原生（App 内，生产路径）：CapacitorHttp 取回 JSON 文本自己解析。
 *   2. 浏览器（npm run dev 调试）：JSONP script 注入绕 CORS，一次性回调后摘除。
 * 接口无 CORS 头，浏览器路径不能用普通 fetch。
 *
 * 只保留 CATEGORYDESC='基金' 的条目（剔掉高端理财等非基金产品）；
 * 解析不出 6 位代码或名称的记录丢弃；接口失败抛错交调用方提示，不编造结果。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const SUGGEST_BASE = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx'

/** 把一条接口记录归一化；不合格返回 null */
function normalize(rec) {
  const code = String(rec?.CODE || '').trim()
  const name = String(rec?.NAME || '').trim()
  if (!/^\d{6}$/.test(code) || !name) return null
  if (rec?.CATEGORYDESC !== '基金') return null
  const base = rec.FundBaseInfo || {}
  const nav = Number(base.DWJZ)
  return {
    code,
    name,
    type: String(base.FTYPE || '').trim() || '—',
    nav: Number.isFinite(nav) && nav > 0 ? nav : null,
    navDate: String(base.FSRQ || '').trim() || '',
  }
}

/** 校验并归一化整包响应；任何结构不符都抛错，不把脏数据喂进界面 */
function parse(json) {
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json)
    } catch {
      throw new Error('搜索接口返回无法解析')
    }
  }
  if (!json || json.ErrCode !== 0 || !Array.isArray(json.Datas)) {
    throw new Error('搜索接口返回异常')
  }
  return json.Datas.map(normalize).filter(Boolean)
}

/** 原生路径：CapacitorHttp 取文本自己解析 */
async function searchViaHttp(keyword, limit) {
  const url = `${SUGGEST_BASE}?m=1&key=${encodeURIComponent(keyword)}&pageindex=1&pagesize=${limit}&_=${Date.now()}`
  const res = await CapacitorHttp.get({
    url,
    headers: { Referer: 'https://fund.eastmoney.com/' },
    responseType: 'text',
    connectTimeout: 12000,
    readTimeout: 12000,
  })
  const text = typeof res?.data === 'string' ? res.data : ''
  if (!text) throw new Error('搜索接口返回为空')
  return parse(text)
}

/** 浏览器调试路径：JSONP script 注入绕 CORS */
function searchViaJsonp(keyword, limit) {
  return new Promise((resolve, reject) => {
    const cb = `__fundSearchCb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    const script = document.createElement('script')
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('搜索请求超时（12 秒）'))
    }, 12000)
    function cleanup() {
      clearTimeout(timer)
      delete window[cb]
      script.remove()
    }
    window[cb] = (json) => {
      try {
        cleanup()
        resolve(parse(json))
      } catch (e) {
        reject(e)
      }
    }
    script.onerror = () => {
      cleanup()
      reject(new Error('搜索接口不可达'))
    }
    script.src = `${SUGGEST_BASE}?m=1&key=${encodeURIComponent(keyword)}&pageindex=1&pagesize=${limit}&_=${Date.now()}&callback=${cb}`
    document.head.appendChild(script)
  })
}

/**
 * 全市场搜索基金（按名称 / 代码 / 拼音缩写匹配）。
 * @param {string} keyword 关键词
 * @param {{limit?:number}} [options] 返回条数上限（1–30，默认 10）
 * @returns {Promise<Array<{code:string,name:string,type:string,nav:number|null,navDate:string}>>}
 */
export async function searchFunds(keyword, { limit = 10 } = {}) {
  const key = String(keyword || '').trim()
  if (!key) return []
  const n = Math.min(30, Math.max(1, Number(limit) || 10))
  return Capacitor.isNativePlatform() ? searchViaHttp(key, n) : searchViaJsonp(key, n)
}
