// src/lib/announcements.js · 基金公告（真实源）
// ------------------------------------------------------------
// 东财 F10 的 JJGG 公告接口已停更，取不到数据，所以走「基金公司自己发的公告渠道」，
// 并补上证监会统一披露平台的定期报告（全市场通用）。
//
// 数据源：
//   ① 证监会基金电子披露平台 eid.csrc.gov.cn
//      - 定期报告（季报/中报/年报），按基金代码精确查询，全市场覆盖
//      - GET /fund/disclose/advanced_search_report.do?aoData=<JSON>
//      - PDF：/fund/disclose/instance_show_pdf_id.do?instanceid=<uploadInfoId>
//   ② 基金公司官网（临时公告，逐家适配）
//      - 招商基金 cmfchina.com：服务端渲染列表，<p>标题</p><span class="date">
//      - 中欧基金 zofund.com：服务端渲染列表，<a class="link" href=pdf>标题</a>+<div class="time">
//      - 华夏基金 chinaamc.com：JSON API /front/front/contents（catalogID=15896）
//      - 其他公司：未适配 → 如实返回空，不编造
//
// 约定：
//   - 单只基金按需抓（点开详情才抓），不后台全池抓
//   - localStorage 缓存 12 小时；基金公司映射缓存 7 天
//   - 任一源失败单独降级，其余照常展示
//   - 原生环境走 CapacitorHttp 绕跨域；浏览器预览走 fetch（可能被 CORS 拦）

const CACHE_PREFIX = 'fund_ann_'
const CACHE_TTL = 12 * 60 * 60 * 1000
const COMPANY_TTL = 7 * 24 * 60 * 60 * 1000

const UA =
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'

/* ---------------- 基础请求 ---------------- */

async function getText(url, referer, timeoutMs = 12000) {
  const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': UA, Referer: referer || url },
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
    // 只看 res.data 会把 404 / 502 / 劫持页也当成正文喂进 JSON.parse，
    // 结果是解析抛错或渲染出脏数据 —— 必须先看状态码。
    const status = Number(res?.status)
    if (!Number.isFinite(status) || status < 200 || status >= 300) return ''
    const d = res?.data
    return typeof d === 'string' ? d : d == null ? '' : JSON.stringify(d)
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } })
    if (!r.ok) return ''
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || Date.now() - (obj.at || 0) > ttl) return null
    return obj.v
  } catch {
    return null
  }
}

const MAX_CACHE_ENTRIES = 60

/* 公告缓存是「每只基金一个 key」，只增不删会挤爆 localStorage 的 5MB 配额
   —— 配额一满，账本写入也会跟着失败。这里自己记一份索引做 FIFO 淘汰。 */
function readCacheIndex() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_PREFIX + '__index__') || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeCacheIndex(idx) {
  try {
    localStorage.setItem(CACHE_PREFIX + '__index__', JSON.stringify(idx))
    return true
  } catch {
    return false
  }
}

/** 淘汰最旧的条目，直到剩余 <= limit；limit<=0 时淘汰到只剩一半 */
function evictOldest(limit) {
  const idx = readCacheIndex()
  const keys = Object.keys(idx).sort((a, b) => (idx[a] || 0) - (idx[b] || 0))
  const keep = limit > 0 ? limit : Math.max(1, Math.floor(keys.length / 2))
  while (keys.length > keep) {
    const k = keys.shift()
    try {
      localStorage.removeItem(CACHE_PREFIX + k)
    } catch {
      // 忽略
    }
    delete idx[k]
  }
  writeCacheIndex(idx)
}

function cacheSet(key, v) {
  const payload = JSON.stringify({ at: Date.now(), v })
  const bumpIndex = () => {
    const idx = readCacheIndex()
    idx[key] = Date.now()
    return writeCacheIndex(idx)
  }

  try {
    localStorage.setItem(CACHE_PREFIX + key, payload)
    if (!bumpIndex() || Object.keys(readCacheIndex()).length > MAX_CACHE_ENTRIES) {
      evictOldest(MAX_CACHE_ENTRIES)
    }
    return true
  } catch {
    // 配额满：清掉一半最旧的缓存再试一次
    evictOldest(0)
    try {
      localStorage.setItem(CACHE_PREFIX + key, payload)
      bumpIndex()
      return true
    } catch {
      return false
    }
  }
}

function stripTags(s) {
  /* 顺序要紧：先还原实体、再剥标签。
      反过来的话，&lt;script&gt; 这类内容会先被去标签留空、再被还原成
      <script> —— 一旦哪天有人把它喂给 innerHTML 就变成注入点。
      本项目目前全树无 dangerouslySetInnerHTML，属隐患而非已可利用。 */
  return String(s ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 只放行 http / https 链接。
 * 公告标题与链接来自远端，原样塞进 href 会让 javascript: 之类的伪协议有机会执行。
 * @param {unknown} u
 * @returns {string} 安全则返回原串，否则空串
 */
function safeHttpUrl(u) {
  const s = String(u ?? '').trim()
  return /^https?:\/\//i.test(s) ? s : ''
}

/* ---------------- ① 证监会 eid：定期报告 ---------------- */

/**
 * 定期报告（FB = 基金定期报告：季报 / 中期报告 / 年报）
 * ------------------------------------------------------------
 * ⚠️ 份额类别归并：C 类份额代码（如 100038）在 eid 里没有独立记录，
 *    报告挂在主代码（003095）下。所以按 code 查不到时，改用基金名查
 *    （fundShortName 模糊匹配），能覆盖同一基金的所有份额。
 * @param {string} code 基金代码
 * @param {number} limit
 * @param {string} fundName 基金名（code 查不到时的回退查询条件）
 */
export async function fetchEidReports(code, limit = 6, fundName = '') {
  const cacheKey = `eid_${code}_${limit}`
  const cached = cacheGet(cacheKey, CACHE_TTL)
  if (cached) return cached

  const buildAo = (fundCode, shortName) => [
    { name: 'sEcho', value: 1 },
    { name: 'iDisplayStart', value: 0 },
    { name: 'iDisplayLength', value: limit },
    { name: 'fundType', value: '' },
    { name: 'reportType', value: 'FB' },
    { name: 'reportYear', value: '' },
    { name: 'fundCompanyShortName', value: '' },
    { name: 'fundCode', value: fundCode },
    { name: 'fundShortName', value: shortName },
    { name: 'startUploadDate', value: '' },
    { name: 'endUploadDate', value: '' },
  ]

  const query = async (ao) => {
    const url =
      'http://eid.csrc.gov.cn/fund/disclose/advanced_search_report.do' +
      `?aoData=${encodeURIComponent(JSON.stringify(ao))}`
    const raw = await getText(url, 'http://eid.csrc.gov.cn/fund/disclose/advanced_search.html')
    return JSON.parse(raw)?.aaData ?? []
  }

  try {
    let rows = await query(buildAo(code, ''))

    // 按代码查不到 → 用基金名再查一次（C 类份额归并到主代码）
    if (rows.length === 0 && fundName) {
      const shortName = String(fundName)
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[A-Za-z]$/g, '')
        .trim()
      if (shortName) {
        try {
          rows = await query(buildAo('', shortName))
        } catch {
          // 名称查询失败就维持空
        }
      }
    }

    const out = rows
      .map((r) => ({
        kind: 'report',
        title: stripTags(r.reportName),
        date: String(r.reportSendDate || r.uploadDate || '').slice(0, 10),
        url: safeHttpUrl(
          r.uploadInfoId
            ? `http://eid.csrc.gov.cn/fund/disclose/instance_show_pdf_id.do?instanceid=${encodeURIComponent(String(r.uploadInfoId))}`
            : '',
        ),
        desc: stripTags(r.reportDesp || ''),
      }))
      .filter((x) => x.title)
    cacheSet(cacheKey, out)
    return out
  } catch {
    return []
  }
}

/* ---------------- ② 基金公司：临时公告 ---------------- */

/** 基金代码 → 基金公司名（抓东财 F10 概况页，缓存 7 天） */
export async function fetchFundCompany(code) {
  const cacheKey = `company_${code}`
  const cached = cacheGet(cacheKey, COMPANY_TTL)
  if (cached) return cached

  try {
    const html = await getText(
      `https://fundf10.eastmoney.com/jbgk_${code}.html`,
      'https://fundf10.eastmoney.com/'
    )
    const m = html.match(/管理人：\s*<a[^>]*>([^<]+)<\/a>/)
    const name = m ? stripTags(m[1]) : ''
    if (name) cacheSet(cacheKey, name)
    return name
  } catch {
    return ''
  }
}

/* 各基金公司的公告列表适配器。
   adapter 返回统一的 {title, date, url} 数组。
   只列已适配的公司；没适配的公司如实返回空。 */
const COMPANY_SOURCES = {
  招商基金: {
    name: '招商基金',
    url: 'https://www.cmfchina.com/web/aboutUs/CompanyNotice/fundnotice/index.html',
    referer: 'https://www.cmfchina.com/',
    parse(html) {
      // <a href="..." class="item"><p>标题</p><span class="date"></span></a>
      const out = []
      const re = /<a[^>]*href="([^"]+)"[^>]*class="item"[^>]*>([\s\S]*?)<\/a>/g
      let m
      while ((m = re.exec(html))) {
        const inner = m[2]
        const title = stripTags((inner.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '')
        const date = stripTags((inner.match(/class="date"[^>]*>([\s\S]*?)<\//) || [])[1] || '')
        if (!title) continue
        let url = m[1]
        if (url.startsWith('/')) url = 'https://www.cmfchina.com' + url
        out.push({ title, date: date.slice(0, 10), url })
      }
      return out
    },
  },
  中欧基金: {
    name: '中欧基金',
    url: 'https://www.zofund.com/main/informationcenter/informationdisclosure/regularann/index.html',
    referer: 'https://www.zofund.com/',
    parse(html) {
      // <li><p><a class="link" href="xxx.pdf">标题</a></p>...<div class="time"></div></li>
      const out = []
      const re = /<li[^>]*>([\s\S]*?)<\/li>/g
      let m
      while ((m = re.exec(html))) {
        const inner = m[1]
        const a = inner.match(/<a[^>]*class="link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
        if (!a) continue
        const title = stripTags(a[2])
        if (!title) continue
        const date = stripTags((inner.match(/class="time"[^>]*>([\s\S]*?)<\//) || [])[1] || '')
        let url = a[1]
        if (url.startsWith('/')) url = 'https://www.zofund.com' + url
        out.push({ title, date: date.slice(0, 10), url })
      }
      return out
    },
  },
  华夏基金: {
    name: '华夏基金',
    url: 'https://www.chinaamc.com/front/front/contents?title=&sortType=Recent&containChildren=N&publishTime=&pageIndex=0&pageSize=20&catalogID=15896&siteID=128',
    referer: 'https://www.chinaamc.com/guanyu/gonggao/',
    isJson: true,
    parse(raw) {
      try {
        const json = JSON.parse(raw)
        const rows = json?.data?.data ?? []
        return rows
          .map((r) => ({
            title: stripTags(r.title),
            date: String(r.publishDate || '').slice(0, 10),
            url: r.link || '',
          }))
          .filter((x) => x.title)
      } catch {
        return []
      }
    },
  },
}

/**
 * 基金公司临时公告（按基金名过滤）
 * @param {string} code 基金代码
 * @param {string} fundName 基金名（用于过滤本公司公告）
 * @param {number} limit
 */
export async function fetchCompanyNotices(code, fundName, limit = 6) {
  const company = await fetchFundCompany(code)
  if (!company) return { company: '', items: [], supported: false }

  const src = COMPANY_SOURCES[company]
  if (!src) return { company, items: [], supported: false }

  const cacheKey = `company_notices_${company}`
  let items = cacheGet(cacheKey, CACHE_TTL)
  if (!items) {
    try {
      const raw = await getText(src.url, src.referer)
      items = src.parse(raw)
      cacheSet(cacheKey, items)
    } catch {
      items = []
    }
  }

  /* 过滤：公告标题通常包含基金全称（如「招商中证白酒指数证券投资基金」）。
     用基金名的核心片段匹配 —— 去掉「A/C/E」份额后缀和「(LOF)」这类括号。
     若过滤后为空（公司列表只显示最近 N 条，未必有这只基金），
     回退为「该公司最新公告」，由 UI 标注清楚，不冒充本基金公告。 */
  const core = String(fundName || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[A-Za-z]$/g, '')
    .trim()
  const key = core.slice(0, Math.min(6, core.length))
  const filtered = key ? items.filter((x) => x.title.includes(key)) : []
  const matched = filtered.length > 0
  const list = matched ? filtered : items

  return {
    company,
    supported: true,
    matched,
    items: list.slice(0, limit),
  }
}

/**
 * 汇总：定期报告 + 公司临时公告（去重、按日期倒序）
 * @param {string} code
 * @param {{name?:string, limit?:number}} opts
 */
export async function fetchFundAnnouncements(code, { name = '', limit = 8 } = {}) {
  if (!code) return { items: [], company: '', companySupported: false, companyMatched: false }

  const [reports, notices] = await Promise.all([
    fetchEidReports(code, limit, name),
    fetchCompanyNotices(code, name, limit),
  ])

  /* 只并入「确认是本基金」的公司公告。公司官网列表页只给最近 N 条，
     命中不了本基金时宁可不放，也不拿别的基金的公告充数。 */
  const noticeItems = notices.matched ? notices.items : []

  const seen = new Set()
  const all = [...noticeItems, ...reports]
    .filter((x) => {
      const k = `${x.title}|${x.date}`
      if (!x.title || seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limit)

  return {
    items: all,
    company: notices.company,
    companySupported: notices.supported,
    companyMatched: !!notices.matched,
  }
}
