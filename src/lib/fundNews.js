// src/lib/fundNews.js · 单只基金资讯抓取
// ------------------------------------------------------------
// 资讯必须和「这只基金」挂钩，不抓泛泛的宏观噪音。
//
// 数据源（都是东财公开接口）：
//   ① 基金公告：api.fund.eastmoney.com/f10/JJGG
//      type=4 人事调整 / type=2 分红配送 / type=3 定期报告
//   ② 重仓股新闻：先取这只基金的前十大重仓股（live.js 的 fetchFundStocks，
//      与持仓估算同源），再按股票搜新闻 search-api-web.eastmoney.com（JSONP）
//
// 约定：
//   - 单只基金按需抓（点开详情才抓），不后台全池抓
//   - localStorage 缓存 24 小时，重复点开不重复请求
//   - 任一接口失败单独降级，其余照常展示；拿不到就空，不编造
//   - 接口返回的标题/摘要带 <em> 高亮标签，展示前剥掉

import { fetchFundStocks } from './live.js'
import { fetchFundAnnouncements } from './announcements.js'

const CACHE_PREFIX = 'fund_news_'
const CACHE_TTL = 24 * 60 * 60 * 1000

/** 接口里带的 <em>高亮</em> 标签剥掉 */
function stripTag(s) {
  return String(s ?? '').replace(/<\/?em>/g, '')
}

/** 走原生 HTTP（CapacitorHttp）绕跨域；浏览器预览退回 fetch */
async function getText(url, referer, timeoutMs = 10000) {
  const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        Referer: referer,
      },
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

/* 基金公告已由 lib/announcements.js 统一提供（证监会 eid 定期报告 +
   基金公司官网临时公告），本文件不再保留旧的公告抓取包装。 */

/** 个股新闻：东财搜索接口是 JSONP，要剥掉 cb(...) 外壳 */
export async function fetchStockNews(keyword, limit = 5) {
  if (!keyword) return []
  const param = {
    uid: '',
    keyword,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'default',
        pageIndex: 1,
        pageSize: limit,
        preTag: '<em>',
        postTag: '</em>',
      },
    },
  }
  const url =
    'https://search-api-web.eastmoney.com/search/jsonp' +
    `?cb=fundnews&param=${encodeURIComponent(JSON.stringify(param))}&_=${Date.now()}`
  try {
    const raw = await getText(url, `https://so.eastmoney.com/news/s?keyword=${keyword}`)
    const m = raw.match(/^\s*\w+\((.*)\)\s*;?\s*$/s)
    const json = m ? JSON.parse(m[1]) : JSON.parse(raw)
    const rows = json?.result?.cmsArticleWebOld ?? []
    return rows.slice(0, limit).map((r) => ({
      kind: 'stock_news',
      title: stripTag(r.title),
      summary: stripTag(r.content || '').slice(0, 120),
      source: stripTag(r.mediaName || ''),
      date: String(r.date || '').slice(0, 16),
      url: String(r.url || ''),
      related: keyword,
    }))
  } catch {
    return []
  }
}

/**
 * 抓一只基金的完整资讯：基金公告 + 前 N 大重仓股的新闻。
 * @returns {Promise<{code, announcements: Array, stockNews: Array, fetchedAt: number}>}
 */
export async function fetchFundNews(code, { maxStocks = 3, perStock = 3, announceLimit = 6, name = '' } = {}) {
  const [annRes, stocks] = await Promise.all([
    fetchFundAnnouncements(code, { name, limit: announceLimit }),
    fetchFundStocks(code),
  ])
  const announcements = annRes?.items || []

  const stockNews = []
  for (const s of stocks.slice(0, maxStocks)) {
    const rows = await fetchStockNews(s.dm, perStock)
    for (const r of rows) {
      stockNews.push({ ...r, related: s.name || s.dm, relatedCode: s.dm })
    }
  }

  return {
    code,
    announcements,
    company: annRes?.company || '',
    companySupported: !!annRes?.companySupported,
    stockNews,
    fetchedAt: Date.now(),
  }
}

/** 读缓存（24 小时内复用，避免点开一次就抓一次） */
export function cachedFundNews(code) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + code)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (Date.now() - obj.fetchedAt > CACHE_TTL) return null
    return obj
  } catch {
    return null
  }
}

function saveFundNews(obj) {
  try {
    localStorage.setItem(CACHE_PREFIX + obj.code, JSON.stringify(obj))
  } catch {
    // 存满了就算了，不阻塞展示
  }
}

/** 同一只基金的抓取进行中的 Promise（多处同时打开时不重复请求） */
const INFLIGHT = new Map()

/**
 * 带缓存的资讯拉取：有缓存直接用，没有才联网。
 * 返回 { data, fromCache, error }。
 */
export async function loadFundNews(code, opts) {
  const hit = cachedFundNews(code)
  if (hit) return { data: hit, fromCache: true, error: null }
  if (INFLIGHT.has(code)) return INFLIGHT.get(code)
  const task = (async () => {
    try {
      const fresh = await fetchFundNews(code, opts)
      saveFundNews(fresh)
      return { data: fresh, fromCache: false, error: null }
    } catch (e) {
      return { data: null, fromCache: false, error: e?.message || String(e) }
    } finally {
      INFLIGHT.delete(code)
    }
  })()
  INFLIGHT.set(code, task)
  return task
}
