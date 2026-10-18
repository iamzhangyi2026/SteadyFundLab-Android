// ─────────────────────────────────────────────
// sqlite_fetcher.ts · 真实 HTTP 抓取（通过 NativeHttp 原生插件调用 HttpURLConnection）
//
//
// 设计原则：
//   - 最低要求：只抓【净值】和【基金列表】，板块/新闻/蛋卷留空
//   - 使用 NativeHttp 插件（Java HttpURLConnection），绕过 WebView fetch 的 DNS/TLS 问题
//   - native DNS 解析正常，所以保留域名 URL
//   - 抓不到 → 返回空 + 标「数据缺失」，不造假数据（E3）
//   - 遇到字段缺失一律 null
// ─────────────────────────────────────────────

import type { StatusSnapshot } from '../core/status'
import { parseStatus } from '../core/status'

// ─── HttpDriver 抽象（Web / 真机两套实现都由 dataAdapter.js 提供） ─────

export interface HttpDriver {
  get(url: string, headers?: Record<string, string>, timeoutMs?: number): Promise<{ status: number; data: unknown }>
}

// ─── 模块级错误记录（结构化：时间戳 + 模块 + 原始信息） ──────────────────
// 原则：所有错误进入缓冲，「更多→导出诊断」可查；界面不显示任何技术细节

const MAX_ERROR_HISTORY = 50

interface ErrorEntry {
  ts: string          // ISO 8601
  module: string      // 调用方模块
  message: string     // 原始技术信息（含 ErrCode / SQL / stack 等）
}

const _errorLog: ErrorEntry[] = []

/** 供 fetcher 调用——自动注入 module 和时间戳 */
export function pushError(module: string, message: string): void {
  console.warn(`[ERR] ${module}: ${message}`)
  _errorLog.push({ ts: new Date().toISOString(), module, message })
  if (_errorLog.length > MAX_ERROR_HISTORY) _errorLog.shift()
}

/** 向后兼容旧接口（无 module 字段） */
export function pushFetchError(msg: string): void {
  pushError('fetcher', msg)
}

/** 供 init_app.ts 使用：返回字符串列表 */
export function getFetchErrors(): string[] {
  return _errorLog.map(e => `[${e.module}] ${e.message}`)
}

export function clearFetchErrors(): void { _errorLog.length = 0 }

/** 供诊断导出使用：返回结构化条目（最近 N 条） */
export function getStructuredErrors(): ErrorEntry[] {
  return [..._errorLog]
}

// ─── driver 注入 ─────

/** 生产环境：在 App 启动时调 useRealDriver() 注入 HTTP driver */
let _driver: HttpDriver | null = null

// NativeHttp 插件只注册一次并缓存（避免每请求多一次模块解析 + "already registered" 警告）。
// ⚠️ 初始化函数**不得返回插件代理**（返回 Promise<void> 只赋模块变量）——
// async 函数 return 代理会被 Promise.resolve 探测 .then，Capacitor 原生未实现 then
// → 抛 "NativeHttp.then() is not implemented"。
let _nativeHttp: any | null = null
let _nativeHttpInit = false
async function initNativeHttp(): Promise<void> {
  if (_nativeHttpInit) return
  _nativeHttpInit = true
  try {
    const { registerPlugin } = await import('@capacitor/core')
    _nativeHttp = registerPlugin('NativeHttp')
    console.log('[fetch] registerPlugin OK, methods:', Object.keys(_nativeHttp).join(','))
  } catch (e) {
    console.warn('[fetch] registerPlugin ERR', String(e))
    _nativeHttp = null
  }
}

export function setHttpDriver(driver: HttpDriver | null): void {
  _driver = driver
}
export function getHttpDriver(): HttpDriver | null { return _driver }

export function useRealDriver(): void {
  // 使用原生 Java HttpURLConnection（绕过 WebView fetch 的 DNS/TLS 问题）
  setHttpDriver({
    get: (url: string, headers: Record<string, string> = {}, timeoutMs = 60000) =>
      nativeGet(url, headers, timeoutMs),
  })
  console.log('[http] NativeHttp 驱动已注入')
}

/**
 * 通过原生 Java HttpURLConnection 发起 GET 请求。
 * 绕过 WebView fetch 在 Android 13 上的 DNS/TLS 问题。
 */
async function nativeGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; data: unknown }> {
  // 风控：熔断冷却中直接返回（冷却结束自动恢复，不永久阻断）
  if (_isCircuitOpen()) return { status: 0, data: null }
  // _rateLimitWait 仅做「sleep + 更新时间戳」，不会抛错，直接调用即可，无需 try 包裹。
  await _rateLimitWait()
  // 通过 Capacitor 插件系统访问原生插件（标准方式，与 PowerMonitor 一致）；模块级缓存，只注册一次
  await initNativeHttp()
  const nativeHttp = _nativeHttp ?? (window as any).NativeHttp ?? null
  if (!nativeHttp || typeof nativeHttp.get !== 'function') {
    const msg = 'NativeHttp plugin not available'
    console.warn('[fetch] ERR', msg, 'url=' + url.slice(0, 60))
    pushFetchError(msg)
    return { status: 0, data: null }
  }
  try {
    const result = await nativeHttp.get({ url, timeout: timeoutMs, headers })
    const text = (result as any)?.result ?? ''
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    console.log('[fetch]', url.includes('FundMN') ? 'FundMN' : url.slice(0, 40), '→ status 200')
    _recordSuccess()
    return { status: 200, data }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    console.warn('[fetch] ERR', msg, 'url=' + url.slice(0, 60))
    pushFetchError(`fetch failed: ${msg}`)
    _recordFailure()
    return { status: 0, data: null }
  }
}

// ─── 常量：东财 endpoint ────
//  恢复域名URL（IP直连CDN节点已失效，TLS SAN不匹配由NativeHttp TrustManager处理）
// fundmobapi.eastmoney.com = CDN边缘节点，fund.eastmoney.com = 源站

// 全市场基金列表
const ENDPOINT_FUND_NAME_PRIMARY = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?plat=Android&appType=ttjj&deviceid=web&FCODE=&pageIndex=1&pageSize=20000'
const ENDPOINT_FUND_NAME_FALLBACK = 'https://fund.eastmoney.com/Data/Fund_JJJZ_Data.aspx?st=code&sr=-1&page=1&ps=20000&rt=0.1234'
const ENDPOINT_FUND_NAME = ENDPOINT_FUND_NAME_PRIMARY

// 全市场基金档案（**含「基金类型」**）：东财静态 JS，格式
//   var r = [["000001","HXCZHH","华夏成长混合","混合型-灵活","拼音全称"], ...]
// 说明：主源(移动API) 与备用源(东财网页 Fund_JJJZ_Data.aspx) 均**不含类型列**，
//       基金类型只能从这里取；缺了它 → category 落库为空/「其他」→ 无法通过可投校验。
const ENDPOINT_FUND_CODE_SEARCH = 'https://fund.eastmoney.com/js/fundcode_search.js'

// 全市场费率（申购状态）
const ENDPOINT_FUND_PURCHASE = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPerInformation?plat=Android&appType=ttjj&FCODE=&pageIndex=1&pageSize=20000'

// 单只基金历史净值：双源兜底（避免单源失效）
// 主源 fundmobapi（现常 ErrCode 61136 限流）；备源 api.fund.eastmoney.com/f10/lsjz
//   （原 fund.eastmoney.com 同路径已 301→notfound 成死链，故备源换 lsjz）
const ENDPOINT_FUND_NAV_PRIMARY = (fundCode: string) =>
  `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPeriodIc?plat=Android&appType=ttjj&deviceid=web&FCODE=${fundCode}&pageIndex=1&pageSize=90&_=${Date.now()}`
const ENDPOINT_FUND_NAV_FALLBACK = (fundCode: string) =>
  `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=90&_=${Date.now()}`
const ENDPOINT_FUND_NAV = ENDPOINT_FUND_NAV_PRIMARY

// 单只基金**完整历史净值**：东财 pingzhongdata 静态 JS
// 内含 var Data_netWorthTrend=[{x:ts,y:单位净值,equityReturn:日涨跌%},...]
//      var Data_ACWorthTrend=[[ts,累计净值],...]
// 说明：新浪 of 接口只返回"最新 1 条" → 算不出收益/回撤（navStats 需 ≥30 个点），故历史优先取这里。
const ENDPOINT_FUND_PINGZHONG = (fundCode: string) =>
  `https://fund.eastmoney.com/pingzhongdata/${fundCode}.js`

// 单只基金**盘中实时估值**：腾讯基金行情（GBK 文本）
//   v_jj000001="代码~名称~估算净值~估算涨幅~?~单位净值~累计净值~日涨跌~日期~"
// 说明：天天基金 fundgz 接口**已废弃**（返回东财「页面未找到」），故改用腾讯。
// 交易时段「估算净值/涨幅」>0；非交易时段为 0（此时不显示盘中估值，避免造假）。
const ENDPOINT_FUND_ESTIMATE = (fundCode: string) =>
  `https://qt.gtimg.cn/q=jj${fundCode}`

const SOURCE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Referer': 'http://fund.eastmoney.com/',
  'Origin': 'http://fund.eastmoney.com',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

// ─── 抓取风控：限速 + 连续失败计数 + 熔断 ────────────────────
// 原则：宁可慢不被封，连续失败 N 次后暂停本次抓取

/** 请求间隔（毫秒）：每两次请求之间最小等待 */
const RATE_LIMIT_INTERVAL_MS = 300
let _lastRequestTime = 0

/** 连续失败计数（全局，用于熔断） */
let _consecutiveFailures = 0
const MAX_CONSECUTIVE_FAILURES = 8      // 连续失败 8 次 → 熔断
const CIRCUIT_COOLDOWN_MS = 30_000      // 熔断冷却 30s 后自动恢复（绝不永久卡死）
let _circuitOpenUntil = 0               // 冷却截止时间戳（0 = 未熔断）

/** 睡眠到距上次请求至少 RATE_LIMIT_INTERVAL_MS 毫秒 */
async function _rateLimitWait(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, RATE_LIMIT_INTERVAL_MS - (now - _lastRequestTime))
  if (wait > 0) await sleep(wait)
  _lastRequestTime = Date.now()
}

/** 熔断是否处于开启（冷却中）状态 */
function _isCircuitOpen(): boolean { return Date.now() < _circuitOpenUntil }

/** 记录成功（重置熔断计数与冷却） */
function _recordSuccess(): void { _consecutiveFailures = 0; _circuitOpenUntil = 0 }

/**
 * 记录一次失败。达到阈值 → 打开熔断（冷却 CIRCUIT_COOLDOWN_MS），
 * 冷却结束后自动复位、允许重试 —— 绝不永久阻断后续抓取。
 * 只在真实请求失败时调用（不再入口/失败双重计数）。
 */
function _recordFailure(): void {
  _consecutiveFailures++
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !_isCircuitOpen()) {
    _circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS
    console.warn(`[fetch] 连续失败 ${_consecutiveFailures} 次，熔断 ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s 后自动恢复`)
    pushFetchError(`连续失败 ${_consecutiveFailures} 次，熔断冷却 ${Math.round(CIRCUIT_COOLDOWN_MS / 1000)}s`)
    _consecutiveFailures = 0   // 复位计数：冷却结束后重新计数
  }
}

// ─── 通用：带超时拦截器 ─────

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error(`${label}: 超时 ${ms}ms`)), ms)
    p.then(v => { clearTimeout(tid); resolve(v) }).catch(e => { clearTimeout(tid); reject(e) })
  })
}

/** 延迟 ms 毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 带 61136 限流重试的 HTTP 请求包装器。
 * 当服务端返回 ErrCode=61136 时，指数退避重试（最多 maxRetries 次）。
 * 其他错误直接返回，不做重试。
 *
 * 退避参数（maxRetries / maxDelayMs）可由调用方指定。
 *   - 默认 3 次 / 20s 上限（普通接口）
 *   - 申购表等「容易被限流的大接口」调用方传更大值（6 次 / 30s）
 */
async function fetchWithRetry<T>(
  url: string,
  label: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxRetries = 3,
  maxDelayMs = 20000,
): Promise<{ status: number; data: T }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      // 61136 是东财服务端限流；退避要够长才有机会恢复
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), maxDelayMs)
      console.log(`[fetch] ${label} 限流重试 attempt=${attempt}/${maxRetries} 等待 ${delay}ms`)
      await sleep(delay)
    }
    const res = await _driver!.get(url, headers, timeoutMs)
    if (res.status !== 200) {
      // 网络/DNS 失败（含 Unable to resolve host）：退避重试，偶发失败不应直接放弃
      if (attempt === maxRetries - 1) {
        pushFetchError(`${label}: 重试 ${maxRetries} 次后仍失败（status=${res.status}）`)
      }
      continue
    }
    // 检查 61136 限流码（东财 H5 移动端特有）
    const obj = res.data as { Success?: boolean; ErrCode?: number } | null
    if (obj && obj.ErrCode === 61136) {
      if (attempt === maxRetries - 1) {
        pushFetchError(`${label}: 限流重试 ${maxRetries} 次后仍失败，ErrCode=61136`)
      }
      continue // 继续重试
    }
    return res as unknown as { status: number; data: T }
  }
  return { status: 0, data: null as unknown as T }
}

// ─── 基金代码规范化（零提示，直接修正） ───────────────────────────────────
// 规则：
//   1. 去掉后缀 .OF / .SZ / .SH（不区分大小写）
//   2. 纯数字代码不足6位 → 左侧补零（如 "11011" → "011011"）
//   3. 清洗后仍非6位数字 → 丢弃（静默，不提示用户）

/**
 * 规范化基金代码。
 * - 去掉后缀（.OF / .SZ / .SH，不区分大小写）
 * - 纯数字不足6位 → 左侧补零（如 "11011" → "011011"）
 * - 清洗后非6位数字 → null（静默丢弃）
 * @param raw 原始代码字符串
 * @returns 规范化后的6位数字代码，无法修复则返回 null
 */
export function normalizeFundCode(raw: string): string | null {
  const s = String(raw).trim().toUpperCase()
  // 去掉常见后缀
  const withoutSuffix = s.replace(/\.OF$/, '').replace(/\.SZ$/, '').replace(/\.SH$/, '')
  // 必须是纯数字
  if (!/^\d+$/.test(withoutSuffix)) return null
  // 补零到6位
  const padded = withoutSuffix.padStart(6, '0')
  // 补零后仍是6位（原长 ≤ 6 位）；原长 > 6 位则丢弃
  if (padded.length !== 6) return null
  return padded
}

/**
 * 将规范化日志写入 fund_code_correction_log 表（内部记录，不提示用户）。
 * 表不存在时静默忽略（迁移后建表）。
 */
export async function logCodeCorrection(
  db: { run: (sql: string, params?: unknown[]) => Promise<unknown> },
  rawCode: string,
  fixedCode: string,
  reason: string,
): Promise<void> {
  try {
    await db.run(
      `INSERT INTO fund_code_correction_log (raw_code, fixed_code, reason, logged_at)
       VALUES (?, ?, ?, ?)`,
      [rawCode, fixedCode, reason, new Date().toISOString().slice(0, 19).replace('T', ' ')],
    )
  } catch {
    // 表不存在 → 静默忽略
  }
}

// ─── 数据结构 ─────

export interface FundNameRow {
  fund_code: string
  fund_name: string
  fund_type: string | null
  is_buy: number | null
  source?: string   // 数据来源标注
}

export interface PurchaseRow {
  fund_code: string
  purchase_fee: number | null
  purchase_fee_discount: number | null
  minimum_purchase: number | null
  raw: Record<string, unknown>
}

// ─── 1) 全市场基金列表 ─────

export async function fetchFundNameList(timeoutSec = 60): Promise<FundNameRow[]> {
  if (!_driver) { pushFetchError('fetchFundNameList: driver 未注入'); return [] }
  // ── 0) 类型源优先：东财静态档案 JS（含 name + 类型，最可靠）──
  const typed = await _fetchNameFromCodeSearch(timeoutSec)
  if (typed.length > 0) {
    console.log(`[fetch] fundcode_search 命中：${typed.length} 只（含类型）`)
    return typed
  }
  // ── 主源：东财 H5 ──
  const primary = await _fetchNamePrimary(timeoutSec)
  if (primary.length > 0) return primary
  // ── 主源空：切备用源（东财网页 Fund_JJJZ_Data.aspx）──
  console.log('[fetch] 主源空，切备用源（东财 Fund_JJJZ_Data.aspx）')
  const fallback = await _fetchNameFallback(timeoutSec)
  if (fallback.length > 0) {
    console.log(`[fetch] 备用源命中：${fallback.length} 只基金，来源=东财PC`)
    return fallback
  }
  return []
}

/** 拉取东财静态档案 JS（fundcode_search.js），解析出 代码/名称/类型 */
async function _fetchNameFromCodeSearch(timeoutSec: number): Promise<FundNameRow[]> {
  try {
    const res = await withTimeout(
      _driver!.get(ENDPOINT_FUND_CODE_SEARCH, SOURCE_HEADERS, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundNameList.codeSearch',
    )
    if (res.status !== 200) { pushFetchError(`fetchFundNameList.codeSearch: HTTP ${res.status}`); return [] }
    const rows = _parseCodeSearch(res.data)
    if (rows.length === 0) pushFetchError('fetchFundNameList.codeSearch: 解析为空')
    return rows
  } catch (e) {
    pushFetchError(`fetchFundNameList.codeSearch: ${(e as Error).message}`)
    return []
  }
}

/**
 * 解析 fundcode_search.js：`var r = [[code, abbr, name, type, full], ...]`
 * 兼容两种入参：CapacitorHttp 已解析成对象（{r:[...]}）或原始字符串。
 */
function _parseCodeSearch(raw: unknown): FundNameRow[] {
  let arr: unknown = null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as { r?: unknown; datas?: unknown }
    if (Array.isArray(o.r)) arr = o.r
    else if (Array.isArray(o.datas)) arr = o.datas
  }
  if (!arr) {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
    const m = text.match(/\[\s*\[[\s\S]*\]\s*\]/)
    if (!m) return []
    try { arr = JSON.parse(m[0]) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  const out: FundNameRow[] = []
  for (const row of arr as unknown[]) {
    if (!Array.isArray(row) || row.length < 4) continue
    const code = String(row[0] ?? '').trim()
    const name = String(row[2] ?? '').trim()
    const type = String(row[3] ?? '').trim()
    if (!code || !name) continue
    out.push({ fund_code: code, fund_name: name, fund_type: type || null, is_buy: null, source: 'em_code_search' })
  }
  return out
}

async function _fetchNamePrimary(timeoutSec: number): Promise<FundNameRow[]> {
  try {
    const res = await fetchWithRetry(ENDPOINT_FUND_NAME_PRIMARY, 'fetchFundNameList.primary', SOURCE_HEADERS, timeoutSec * 1000)
    if (res.status !== 200) { pushFetchError(`fetchFundNameList.primary: HTTP ${res.status}`); return [] }
    const result = _parseFundNameList(res.data)
    if (result.length === 0) {
      const obj = res.data as { Success?: boolean; ErrCode?: number; ErrMsg?: string } | null
      if (obj && obj.Success === false) {
        pushFetchError(`fetchFundNameList.primary: status=200, code=${obj.ErrCode}, msg=${obj.ErrMsg || '未知'}, 来源=东财H5限流`)
      } else {
        pushFetchError(`fetchFundNameList.primary: status=200, body 空（keys=${res.data ? Object.keys(res.data).join(',') : 'null'}）`)
      }
    }
    return result
  } catch (e) {
    pushFetchError(`fetchFundNameList.primary: ${(e as Error).message}`)
    return []
  }
}

async function _fetchNameFallback(timeoutSec: number): Promise<FundNameRow[]> {
  try {
    // 第一页：读取总页数（record/pages 元数据）
    console.log('[fetch] 备用源 GET Fund_JJJZ_Data.aspx page=1 …')
    const firstRes = await withTimeout(
      _driver!.get(ENDPOINT_FUND_NAME_FALLBACK, SOURCE_HEADERS, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundNameList.fallback',
    )
    console.log('[fetch] 备用源 page=1 status=', firstRes.status, 'type=', typeof firstRes.data)
    if (firstRes.status !== 200) { pushFetchError(`fetchFundNameList.fallback: HTTP ${firstRes.status}`); return [] }
    const firstResult = _parseFundNameFallback(firstRes.data)
    if (firstResult.length === 0) {
      pushFetchError(`fetchFundNameList.fallback: status=200, body 不是 JS 字面量（keys=${firstRes.data ? typeof firstRes.data + '/' + (Array.isArray(firstRes.data) ? `Array[${(firstRes.data as unknown[]).length}]` : '-') : 'null'}）`)
      return []
    }
    // 从返回文本中提取总页数
    const rawData = firstRes.data
    const dataType = typeof rawData
    const dataKeys = (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) ? Object.keys(rawData) : null
    const text: string = dataType === 'string' ? rawData as unknown as string : JSON.stringify(rawData)
    console.log(`[fetch] 备用源 page=1 数据: type=${dataType}, keys=${dataKeys ? dataKeys.join(',') : 'N/A'}, len=${text.length}, first200=${JSON.stringify(text).slice(0, 200)}`)
    const pageMatch = text.match(/(?<![a-z])pages\s*:\s*\[?"(\d+)"?\s*,\s*curpage/)
    const totalPage = pageMatch ? parseInt(pageMatch[1], 10) : 1
    console.log(`[fetch] 备用源 page=1 返回 ${firstResult.length} 只，totalPages=${totalPage}`)
    if (totalPage <= 1) return firstResult

    // 逐页获取剩余数据
    const allRows: FundNameRow[] = [...firstResult]
    const seenCodes = new Set(allRows.map(r => r.fund_code))
    for (let page = 2; page <= totalPage; page++) {
      const pageUrl = ENDPOINT_FUND_NAME_FALLBACK.replace('page=1', `page=${page}`)
      try {
        const res = await withTimeout(
          _driver!.get(pageUrl, SOURCE_HEADERS, timeoutSec * 1000),
          timeoutSec * 1000,
          `fetchFundNameList.fallback.page${page}`,
        )
        if (res.status !== 200) continue
        const pageRows = _parseFundNameFallback(res.data)
        const newRows = pageRows.filter(r => !seenCodes.has(r.fund_code))
        allRows.push(...newRows)
        for (const row of newRows) seenCodes.add(row.fund_code)
        if (page % 50 === 0) console.log(`[fetch] 备用源 progress: ${page}/${totalPage} pages, ${allRows.length} funds`)
        // 轻度节流：每页之间等待 50ms，避免触发限流
        if (page < totalPage) await sleep(50)
      } catch {
        // 单页失败不影响整体
      }
    }
    console.log(`[fetch] 备用源命中：${allRows.length} 只基金，来源=东财PC（分页）`)
    return allRows
  } catch (e) {
    pushFetchError(`fetchFundNameList.fallback: ${(e as Error).message}`)
    return []
  }
}

function _parseFundNameList(raw: unknown): FundNameRow[] {
  const obj = raw as { Datas?: Array<Record<string, unknown>>; TotalCount?: number } | null
  if (!obj || !Array.isArray(obj.Datas)) return []
  const out: FundNameRow[] = []
  for (const r of obj.Datas) {
    const code = String(r.FCODE ?? r.fcode ?? r.fund_code ?? r['基金代码'] ?? '').trim()
    const name = String(r.NAME ?? r.name ?? r.SHORTNAME ?? r.SHORTNAME ?? r['基金简称'] ?? '').trim()
    if (!code || !name) continue
    out.push({
      fund_code: code,
      fund_name: name,
      fund_type: (r.FundType ?? r.fund_type ?? r['基金类型'] ?? null) as string | null,
      is_buy: Number(r.IsBuy ?? r.is_buy ?? r['是否可购'] ?? NaN) || null,
      source: '东财H5',
    })
  }
  return out
}

// 备用源：Fund_JJJZ_Data.aspx 返回 JS 字面量 `var db={chars:[...],datas:[[...], ...]}`
// 解析：用正则提取 datas 数组（CapacitorHttp.data 是字符串，或 Object）
function _parseFundNameFallback(raw: unknown): FundNameRow[] {
  let text = ''
  if (typeof raw === 'string') text = raw
  else if (raw && typeof raw === 'object') {
    // CapacitorHttp.data 已是 JSON，可能返回 { datas: [...] } 或 string
    const obj = raw as { datas?: unknown[]; Datas?: unknown[] }
    if (Array.isArray(obj.datas)) {
      return obj.datas.filter((r): r is string[] => Array.isArray(r)).map(r => _rowFromFallback(r)).filter(Boolean) as FundNameRow[]
    }
    text = JSON.stringify(raw)
  }
  if (!text) return []
  const m = text.match(/datas\s*:\s*(\[[\s\S]*?\]\]),/)
  if (!m) return []
  const arrText = m[1]
  const arr = _parseJsArray(arrText)
  if (!Array.isArray(arr)) return []
  const out: FundNameRow[] = []
  for (const row of arr) {
    if (!Array.isArray(row)) continue
    const r = _rowFromFallback(row as unknown[])
    if (r) out.push(r)
  }
  return out
}

function _rowFromFallback(row: unknown[]): FundNameRow | null {
  const code = String(row[0] ?? '').trim()
  const name = String(row[1] ?? '').trim()
  if (!code || !name || code.length !== 6) return null
  // row[9] 是「申购状态」文字：「开放申购」「暂停申购」「限大额」
  const status = String(row[9] ?? '')
  return {
    fund_code: code,
    fund_name: name,
    fund_type: null,
    is_buy: status === '开放申购' ? 1 : status === '暂停申购' ? 0 : null,
    source: '东财PC',
  }
}

// 极简 JS 数组解析（用 Function 构造器执行字面量，避开 eval 严格模式限制）
function _parseJsArray(text: string): unknown {
  // 先尝试 JSON.parse（兼容有些情况下数据本身就是合法 JSON）
  try { return JSON.parse(text) } catch { /* fallback */ }
  // 用 Function 构造器执行（数据是 `var db={...}`，我们提取 datas 数组后外面包 []
  // 解析的是 [[...], [...]] 结构，把字符串元素去转义后构造合法 JSON）
  // 这里直接拼 `return ([...])`，其中元素都是 JS 字符串字面量
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('return ' + text + ';')
    return fn()
  } catch (e) {
    pushFetchError(`_parseJsArray fallback 失败: ${(e as Error).message}`)
    return null
  }
}

// ─── 2) 全市场申购费率 / 最小申购 ─────

export async function fetchFundPurchaseList(timeoutSec = 60): Promise<PurchaseRow[]> {
  if (!_driver) { pushFetchError('fetchFundPurchaseList: driver 未注入'); return [] }
  try {
    // 申购表是 61136 重灾区，pageSize=20000 单次拉全市场 → 用更激进退避
    //   该接口可能连续重试失败（ErrCode=61136），过长总预算会拖慢首启。
    //   改为 4 次重试 / 上限 15s（总预算约 2+4+8+15 = 29s）：够恢复就恢复，
    //   恢复不了也别阻塞首启 —— 申购信息本就是**可选增强**（单只详情另有 FundMNPerInformation 兜）。
    const res = await fetchWithRetry(
      ENDPOINT_FUND_PURCHASE,
      'fetchFundPurchaseList',
      SOURCE_HEADERS,
      timeoutSec * 1000,
      4,      // maxRetries（6 → 4）
      15000,  // maxDelayMs（30000 → 15000）
    )
    if (res.status !== 200) { pushFetchError(`fetchFundPurchaseList: HTTP ${res.status}`); return [] }
    return _parseFundPurchaseList(res.data)
  } catch (e) {
    pushFetchError(`fetchFundPurchaseList: ${(e as Error).message}`)
    return []
  }
}

function _parseFundPurchaseList(raw: unknown): PurchaseRow[] {
  const obj = raw as { Datas?: Array<Record<string, unknown>> } | null
  if (!obj || !Array.isArray(obj.Datas)) return []
  const out: PurchaseRow[] = []
  for (const r of obj.Datas) {
    const code = String(r.FCODE ?? r.fcode ?? r['基金代码'] ?? '').trim()
    if (!code) continue
    const fee = Number(r.FRRATE ?? r.PurchaseFeeRate ?? r.purchase_fee ?? NaN)
    const min = Number(r.MINSG ?? r.MinPurchase ?? r.minimum_purchase ?? NaN)
    out.push({
      fund_code: code,
      purchase_fee: Number.isFinite(fee) ? fee : null,
      purchase_fee_discount: null,
      minimum_purchase: Number.isFinite(min) ? min : null,
      raw: r,
    })
  }
  return out
}

// ─── 3) 单只基金历史净值 ─────
// 优先级：fundmobapi（主） → fund.eastmoney.com（二） → 新浪（三，仅当日估值）
// 每个源单试（无 retry），超时 15s，总最坏 45s/只基金

// 新浪源可用性：DNS 偶发失败时**短暂冷却**（而非永久跳过），冷却结束自动重试
let _sinaSkipUntil = 0
const SINA_COOLDOWN_MS = 60_000

export async function fetchFundNavList(fundCode: string, timeoutSec = 15): Promise<Array<{ fund_code: string; nav_date: string; nav: number; nav_acc: number | null; daily_growth: number | null }>> {
  if (!_driver) { pushFetchError(`fetchFundNavList(${fundCode}): driver 未注入`); return [] }

  // ── 0) 历史源优先：东财 pingzhongdata（含完整历史，才能算收益/回撤/波动）──
  // 失败/空则继续走后面的源（新浪只有最新 1 条、东财移动端常限流），不影响健壮性
  const hist = await _fetchNavPingzhong(fundCode, timeoutSec)
  if (hist.length >= 2) {
    console.log(`[nav] ${fundCode} 命中历史源(pingzhongdata): ${hist.length}条`)
    return hist
  }

  // 先试新浪（无全局限流）；DNS 偶发失败 → 冷却 60s 后自动重试，**不永久放弃**
  if (Date.now() >= _sinaSkipUntil) {
    try {
      const rSina = await _fetchNavSina(fundCode, timeoutSec)
      if (rSina && rSina.length > 0) {
        console.log(`[nav] ${fundCode} 命中新浪源: ${rSina.length}条`)
        return rSina
      }
      // 新浪返回空数据但没抛错 → DNS可能可用但无数据，不标记为不可用
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (msg.includes('Unable to resolve host') || msg.includes('No address')) {
        // DNS 暂不可达 → 冷却 60s（不永久禁用，避免一次抖动废掉整个会话）
        _sinaSkipUntil = Date.now() + SINA_COOLDOWN_MS
        console.warn(`[nav] hq.sinajs.cn DNS 暂不可达，冷却 ${SINA_COOLDOWN_MS / 1000}s 后重试`)
      }
      pushFetchError(`fetchFundNavList.sina(${fundCode}): ${msg}`)
    }
  }

  // 东财主源（fundmobapi）：最多3次指数退避重试（61136可能是临时限流）
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = 2000 * attempt  // 2s, 4s
      console.log(`[nav] ${fundCode} 东财主源限流，${delay}ms 后退避重试 (${attempt}/3)`)
      await new Promise<void>(r => setTimeout(r, delay))
    }
    try {
      const res = await _driver.get(ENDPOINT_FUND_NAV_PRIMARY(fundCode), SOURCE_HEADERS, timeoutSec * 1000)
      if (res.status === 200) {
        const obj = res.data as { ErrCode?: number; Datas?: unknown } | null
        if (obj && obj.ErrCode === 61136) {
          if (attempt === 2) console.warn(`[nav] ${fundCode} 东财主源仍限流(61136)，放弃`)
          continue  // 继续重试
        }
        const r = _parseFundNavList(fundCode, res.data)
        if (r.length > 0) {
          console.log(`[nav] ${fundCode} 命中东财主源: ${r.length}条`)
          return r
        }
      }
      break  // 非61136错误，不再重试
    } catch (e) {
      pushFetchError(`fetchFundNavList.primary(${fundCode}): ${(e as Error).message}`)
      if (attempt < 2) await new Promise<void>(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }

  // 东财二源（fund.eastmoney.com）：最多2次退避重试
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.log(`[nav] ${fundCode} 东财二源退避重试 (${attempt}/2)`)
      await new Promise<void>(r => setTimeout(r, 2000))
    }
    try {
      const res = await _driver.get(ENDPOINT_FUND_NAV_FALLBACK(fundCode), SOURCE_HEADERS, timeoutSec * 1000)
      if (res.status === 200) {
        const r = _parseFundNavList(fundCode, res.data)
        if (r.length > 0) {
          console.log(`[nav] ${fundCode} 命中东财二源: ${r.length}条`)
          return r
        }
      }
      break
    } catch (e) {
      pushFetchError(`fetchFundNavList.fallback(${fundCode}): ${(e as Error).message}`)
    }
  }

  pushFetchError(`fetchFundNavList(${fundCode}): 所有源均无数据`)
  return []
}

// ─── 盘中实时估值（天天基金 fundgz）─────────────────────────
export interface FundEstimate {
  fund_code: string
  name: string
  /** 净值日期 */
  nav_date: string
  /** 单位净值（上一交易日） */
  nav: number
  /** 累计净值 */
  nav_acc: number | null
  /** 盘中估算净值 */
  estimate: number
  /** 估算涨跌幅 % */
  estimate_pct: number
  /** 估值时间 */
  estimate_time: string
  /** 是否**真实盘中估值**：非交易时段为 false（此时 estimate 回落到单位净值，UI 不应显示"盘中估值"） */
  live: boolean
}

/**
 * 抓取单只基金的**盘中实时估值**（估算净值 + 估算涨跌幅）。
 * 仅交易时段有实时值；非交易时段为上一交易日快照。抓不到返回 null（不造假）。
 */
export async function fetchFundEstimate(fundCode: string, timeoutSec = 10): Promise<FundEstimate | null> {
  if (!_driver) { pushFetchError(`fetchFundEstimate(${fundCode}): driver 未注入`); return null }
  try {
    const res = await fetchWithRetry<unknown>(
      ENDPOINT_FUND_ESTIMATE(fundCode), `estimate(${fundCode})`, SOURCE_HEADERS, timeoutSec * 1000, 2, 4000,
    )
    if (res.status !== 200) return null
    return _parseFundEstimate(fundCode, res.data)
  } catch (e) {
    pushFetchError(`fetchFundEstimate(${fundCode}): ${(e as Error).message}`)
    return null
  }
}

function _parseFundEstimate(fundCode: string, raw: unknown): FundEstimate | null {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  const m = text.match(/="([^"]*)"/)
  if (!m) return null
  const f = m[1].split('~')
  if (f.length < 9) return null
  const num = (v: unknown): number | null => {
    const n = parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : null
  }
  const nav = num(f[5])
  if (nav == null) return null
  const estRaw = num(f[2])
  const live = estRaw != null && estRaw > 0   // 仅交易时段 >0
  return {
    fund_code: fundCode,
    name: f[1] || '',
    nav_date: f[8] || '',
    nav,
    nav_acc: num(f[6]),
    estimate: live ? (estRaw as number) : nav,
    estimate_pct: live ? (num(f[3]) ?? 0) : (num(f[7]) ?? 0),
    estimate_time: f[8] || '',
    live,
  }
}

// ─── 批量盘中实时估值（账户页持仓多只）─────────────────
const ENDPOINT_FUND_ESTIMATES = (codes: string[]) =>
  `https://qt.gtimg.cn/q=${codes.map((c) => 'jj' + c).join(',')}`

export async function fetchFundEstimates(
  fundCodes: string[], timeoutSec = 12,
): Promise<Record<string, FundEstimate | null>> {
  const result: Record<string, FundEstimate | null> = {}
  if (!_driver) { fundCodes.forEach((c) => (result[c] = null)); return result }
  const CHUNK = 50
  for (let i = 0; i < fundCodes.length; i += CHUNK) {
    const chunk = fundCodes.slice(i, i + CHUNK)
    try {
      const res = await fetchWithRetry<unknown>(
        ENDPOINT_FUND_ESTIMATES(chunk), `estimates(${chunk.length})`, SOURCE_HEADERS, timeoutSec * 1000, 2, 4000,
      )
      if (res.status !== 200) { chunk.forEach((c) => (result[c] = null)); continue }
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      const re = /v_jj(\d+)="([^"]*)"/g
      let mm: RegExpExecArray | null
      const found = new Set<string>()
      while ((mm = re.exec(text))) {
        const code = mm[1]
        result[code] = _parseFundEstimate(code, `v_jj${code}="${mm[2]}"`)
        found.add(code)
      }
      chunk.forEach((c) => { if (!found.has(c)) result[c] = null })
    } catch (e) {
      pushFetchError(`fetchFundEstimates: ${(e as Error).message}`)
      chunk.forEach((c) => (result[c] = null))
    }
  }
  return result
}

// ─── 跟踪指数实时行情（按指数估算基金「当日涨跌」）──────────────
// 背景：天天基金已下线「基金净值估算」，全市场已无权威「实时估值」源。
//   替代：指数基金约 95% 仓位跟踪指数，用**跟踪指数的实时行情**近似当日涨跌。
//   映射（基金 → 指数）来自 FundMNDetailInformation 的 INDEXCODE（静态，内存缓存）。
const ENDPOINT_FUND_DETAIL_INFO = (code: string) =>
  `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation?FCODE=${code}&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1`

const ENDPOINT_INDEX_QUOTE = (qcodes: string[]) => `https://qt.gtimg.cn/q=${qcodes.join(',')}`

/** 指数代码 → 腾讯行情代码前缀（深市/国证 399/980 → sz，其余 → sh） */
function _indexQuoteCode(indexCode: string): string {
  const c = String(indexCode).trim()
  return /^(399|980|159)/.test(c) ? 'sz' + c : 'sh' + c
}

const _indexCodeCache = new Map<string, { code: string; name: string } | null>()

/** 基金 → 跟踪指数（内存缓存；失败不缓存，下次重试） */
async function _fetchFundIndexCode(fundCode: string, timeoutSec = 8): Promise<{ code: string; name: string } | null> {
  if (_indexCodeCache.has(fundCode)) return _indexCodeCache.get(fundCode) ?? null
  try {
    const res = await fetchWithRetry<unknown>(
      ENDPOINT_FUND_DETAIL_INFO(fundCode), `fundIndex(${fundCode})`, SOURCE_HEADERS, timeoutSec * 1000, 2, 4000,
    )
    if (res.status !== 200) return null
    const d = (res.data as { Datas?: Record<string, unknown> } | null)?.Datas
    const idx = d?.INDEXCODE ? String(d.INDEXCODE).trim() : ''
    const nm = d?.INDEXNAME ? String(d.INDEXNAME).trim() : ''
    const out = idx ? { code: idx, name: nm } : null
    _indexCodeCache.set(fundCode, out)
    return out
  } catch {
    return null
  }
}

const ENDPOINT_FUND_NAV_BATCH = (codes: string[]) =>
  `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=200&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1&Fcodes=${codes.join(',')}`

export interface FundLiveSnapshot {
  /** 基金最新净值日期（来自接口，通常比本地库新） */
  nav_date: string
  /** 基金最新净值日涨跌幅 % */
  nav_pct: number | null
  /** 跟踪指数代码（如 980017）；主动型为 '' */
  index_code: string
  /** 跟踪指数名称 */
  index_name: string
  /** 跟踪指数实时涨跌幅 % */
  index_pct: number | null
  /** 跟踪指数最新点位 */
  index_value: number | null
  /** 指数行情时间（如 2026-10-09 10:45:53） */
  index_time: string
}

/**
 * 批量「基金实时快照」：最新净值（日期 + 日涨跌幅）+ 跟踪指数实时行情。
 * 用途：持仓页「当日涨跌 / 今日预估收益」——
 *   ① 净值部分按「当日涨跌幅」口径（累计收益率走 acc_nav）；
 *   ② 指数部分用于估算「盘中实时涨跌」（天天基金已下线实时估值，无权威源）。
 * 不造假：拿不到的部分置 null / ''。
 */
export async function fetchFundLiveSnapshot(
  fundCodes: string[], timeoutSec = 8,
): Promise<Record<string, FundLiveSnapshot | null>> {
  const result: Record<string, FundLiveSnapshot | null> = {}
  if (!_driver || !fundCodes.length) { fundCodes.forEach((c) => (result[c] = null)); return result }

  const num = (v: unknown): number | null => {
    const n = parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : null
  }

  // 1) 批量最新净值（一次请求拿全部）
  const navByCode: Record<string, { date: string; pct: number | null }> = {}
  try {
    const res = await fetchWithRetry<unknown>(
      ENDPOINT_FUND_NAV_BATCH(fundCodes), `fundNavBatch(${fundCodes.length})`, SOURCE_HEADERS, timeoutSec * 1000, 2, 4000,
    )
    if (res.status === 200) {
      const d = (res.data as { Datas?: Array<Record<string, unknown>> } | null)?.Datas
      for (const x of d ?? []) {
        const code = String(x.FCODE ?? '').trim()
        if (!code) continue
        navByCode[code] = { date: String(x.PDATE ?? '').trim(), pct: num(x.NAVCHGRT) }
      }
    }
  } catch (e) {
    pushFetchError(`fetchFundLiveSnapshot.nav: ${(e as Error).message}`)
  }

  // 2) 基金 → 跟踪指数（内存缓存）
  const map = new Map<string, { code: string; name: string }>()
  for (const fc of fundCodes) {
    const idx = await _fetchFundIndexCode(fc, timeoutSec)
    if (idx) map.set(fc, idx)
  }

  // 3) 批量指数行情（同一指数去重）
  const quoteByIndex: Record<string, { pct: number | null; value: number | null; time: string }> = {}
  if (map.size) {
    const uniq = new Map<string, string>()   // 腾讯行情代码 → 指数代码
    for (const { code } of map.values()) uniq.set(_indexQuoteCode(code), code)
    const qcodes = [...uniq.keys()]
    try {
      const res = await fetchWithRetry<unknown>(
        ENDPOINT_INDEX_QUOTE(qcodes), `indexQuotes(${qcodes.length})`, SOURCE_HEADERS, timeoutSec * 1000, 2, 4000,
      )
      if (res.status === 200) {
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
        const re = /v_([a-z]{2}\d+)="([^"]*)"/g
        let mm: RegExpExecArray | null
        while ((mm = re.exec(text))) {
          const indexCode = uniq.get(mm[1])
          if (!indexCode) continue
          const f = mm[2].split('~')
          if (f.length < 33) continue
          const t = String(f[30] ?? '')
          const time = t.length === 14
            ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`
            : t
          quoteByIndex[indexCode] = { pct: num(f[32]), value: num(f[3]), time }
        }
      }
    } catch (e) {
      pushFetchError(`fetchFundLiveSnapshot.index: ${(e as Error).message}`)
    }
  }

  // 4) 组装
  for (const fc of fundCodes) {
    const idx = map.get(fc)
    const nav = navByCode[fc]
    const q = idx ? quoteByIndex[idx.code] : null
    if (!idx && !nav) { result[fc] = null; continue }
    result[fc] = {
      nav_date: nav?.date ?? '',
      nav_pct: nav?.pct ?? null,
      index_code: idx?.code ?? '',
      index_name: idx?.name ?? '',
      index_pct: q?.pct ?? null,
      index_value: q?.value ?? null,
      index_time: q?.time ?? '',
    }
  }
  return result
}

// ─── 大盘指数（分析页顶部指数排）─────────
// 东财 push2 全域（push2 / push2delay / push2his）在部分网络环境
//   **连接被服务端直接断掉**（原生 HTTP 报 unexpected end of stream），
//   主源改**腾讯 qt.gtimg.cn**（与盘中估值同域，设备端可用）；
//   push2 降为备源（换个网络环境仍可能通）。
// 指数名本地映射：腾讯返回 GBK 文本，端上解码不稳定，名称不依赖响应内容。
const INDEX_NAME_BY_CODE: Record<string, string> = {
  '000001': '上证指数',
  '399001': '深证成指',
  '399006': '创业板指',
  '000300': '沪深300',
}

const ENDPOINT_MARKET_INDEX_TENCENT =
  'https://qt.gtimg.cn/q=s_sh000001,s_sz399001,s_sz399006,s_sh000300'

const ENDPOINT_MARKET_INDEX =
  'https://push2.eastmoney.com/api/qt/ulist.np/get' +
  '?secids=1.000001,0.399001,0.399006,1.000300' +
  '&fields=f2,f3,f12,f14&fltt=2'

const INDEX_HEADERS = {
  'User-Agent': SOURCE_HEADERS['User-Agent'],
  'Referer': 'https://quote.eastmoney.com/',
}

export interface MarketIndex {
  code: string
  name: string
  /** 最新点位 */
  value: number
  /** 涨跌幅 % */
  change_pct: number
}

// 指数 → push2his secid（市场前缀：1=沪，0=深）
const INDEX_SECID: Record<string, string> = {
  '000001': '1.000001',
  '399001': '0.399001',
  '399006': '0.399006',
  '000300': '1.000300',
}

// 指数 → 腾讯代码（sh/sz 前缀）
const INDEX_TX_CODE: Record<string, string> = {
  '000001': 'sh000001',
  '399001': 'sz399001',
  '399006': 'sz399006',
  '000300': 'sh000300',
}

export interface IndexKlineBar {
  date: string
  open: number
  close: number
  high: number
  low: number
}

/**
 * 抓取指数**日 K 线**。返回按日期升序；抓不到返回空数组（不造假）。
 * 主源腾讯 fqkline（与指数行情同域，设备端稳定）；备源东财 push2his
 * 。
 */
export async function fetchIndexKline(indexCode: string, lmt = 120, timeoutSec = 12): Promise<IndexKlineBar[]> {
  if (!_driver) { pushFetchError('fetchIndexKline: driver 未注入'); return [] }

  // ── 主源：腾讯 fqkline ──
  //   {"data":{"sh000001":{"day":[[日期,开,收,高,低,量],...]}}}
  const txCode = INDEX_TX_CODE[indexCode] ?? `sh${indexCode}`
  try {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${txCode},day,,,${lmt},qfq`
    const res = await fetchWithRetry<unknown>(url, `indexKlineTx(${indexCode})`, SOURCE_HEADERS, timeoutSec * 1000, 2, 4000)
    if (res.status === 200) {
      const node = (res.data as { data?: Record<string, { day?: unknown[][] }> } | null)?.data?.[txCode]
      const arr = node?.day ?? []
      const out: IndexKlineBar[] = []
      for (const r of arr) {
        const date = String(r?.[0] ?? '').slice(0, 10)
        const o = Number(r?.[1]), c = Number(r?.[2]), h = Number(r?.[3]), l = Number(r?.[4])
        if (!date || ![o, c, h, l].every(Number.isFinite)) continue
        out.push({ date, open: o, close: c, high: h, low: l })
      }
      if (out.length) return out
    }
  } catch (e) {
    pushFetchError(`fetchIndexKline.tx(${indexCode}): ${(e as Error).message}`)
  }

  // ── 备源：东财 push2his ──
  const secid = INDEX_SECID[indexCode] ?? `1.${indexCode}`
  const url2 = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    + `?secid=${secid}&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55`
    + `&klt=101&fqt=0&end=20500101&lmt=${lmt}&_=${Date.now()}`
  try {
    const res = await fetchWithRetry<unknown>(url2, `indexKline(${indexCode})`, SOURCE_HEADERS, timeoutSec * 1000, 2, 4000)
    if (res.status !== 200) return []
    const obj = res.data as { data?: { klines?: string[] } } | null
    const ks = obj?.data?.klines ?? []
    const out: IndexKlineBar[] = []
    for (const k of ks) {
      // 每行："日期,开,收,高,低,..."
      const f = String(k).split(',')
      if (f.length < 5) continue
      const date = f[0]
      const o = Number(f[1]), c = Number(f[2]), h = Number(f[3]), l = Number(f[4])
      if (!date || ![o, c, h, l].every(Number.isFinite)) continue
      out.push({ date, open: o, close: c, high: h, low: l })
    }
    return out
  } catch (e) {
    pushFetchError(`fetchIndexKline(${indexCode}): ${(e as Error).message}`)
    return []
  }
}

/** 抓取四大指数（上证/深成/创业板/沪深300）。抓不到返回空数组（不造假）。 */
export async function fetchMarketIndex(timeoutSec = 10): Promise<MarketIndex[]> {
  if (!_driver) { pushFetchError('fetchMarketIndex: driver 未注入'); return [] }

  // 主源：腾讯（v_s_sh000001="1~上证指数~000001~3842.19~11.74~0.31~..."，~ 分隔）
  try {
    const res = await fetchWithRetry<string>(
      ENDPOINT_MARKET_INDEX_TENCENT, 'marketIndexTx', SOURCE_HEADERS, timeoutSec * 1000, 1, 2000,
    )
    if (res.status === 200) {
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      const out: MarketIndex[] = []
      // ⚠️ 不能按行 split：原生 HttpURLConnection 返回的文本会**丢失换行符**
      //    。
      //    改用全局正则，无论有无换行都能取全。
      const re = /v_s_[a-z]{2}(\d{6})="([^"]+)"/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const f = m[2].split('~')
        if (f.length < 6) continue
        const value = Number(f[3])
        const change_pct = Number(f[5])
        if (!Number.isFinite(value) || !Number.isFinite(change_pct)) continue
        out.push({ code: m[1], name: INDEX_NAME_BY_CODE[m[1]] ?? m[1], value, change_pct })
      }
      if (out.length) return out
    }
  } catch (e) {
    pushFetchError(`fetchMarketIndex(腾讯): ${(e as Error).message}`)
  }

  // 备源：东财 push2
  try {
    const res = await fetchWithRetry<unknown>(
      ENDPOINT_MARKET_INDEX, 'marketIndex', INDEX_HEADERS, timeoutSec * 1000, 1, 2000,
    )
    if (res.status === 200) {
      const obj = res.data as { data?: { diff?: Record<string, unknown>[] } } | null
      const diff = obj?.data?.diff
      if (Array.isArray(diff)) {
        const out: MarketIndex[] = []
        for (const d of diff) {
          const value = Number(d.f2)
          const change_pct = Number(d.f3)
          if (!Number.isFinite(value) || !Number.isFinite(change_pct)) continue
          out.push({ code: String(d.f12 ?? ''), name: String(d.f14 ?? ''), value, change_pct })
        }
        if (out.length) return out
      }
    }
  } catch (e) {
    pushFetchError(`fetchMarketIndex(push2): ${(e as Error).message}`)
  }
  return []
}

// ─── 全球行情（国外指数 + 商品）─────────────────────────
// 国外指数无 PE 分位数据源、商品（金银油）无 PE，
// 故只显示**实时点位/价格 + 涨跌%**（不造假估值分位）。
//   国外指数：东财 push2 ulist（fltt=2 归一：f2=点位 / f3=涨跌幅% / f12=代码 / f14=名称）
//   商品：腾讯 hf_（现价[0] / 涨跌额[1]，涨跌幅% 由 涨跌额/(现价−涨跌额) 算）
export interface GlobalQuote {
  code: string
  name: string
  /** 最新点位 / 价格 */
  value: number
  /** 涨跌幅 % */
  change_pct: number
  kind: 'index' | 'commodity'
}

const ENDPOINT_GLOBAL_INDEX =
  'https://push2.eastmoney.com/api/qt/ulist.np/get'
  + '?secids=100.DJIA,100.NDX,100.SPX,100.HSI,100.N225,100.KS11'
  + '&fields=f2,f3,f12,f14&fltt=2'

// 腾讯商品代码（hf_ 前缀）；名称自定——hf_ 返回名是 GBK，设备端 CapacitorHttp 易乱码
const COMMODITY_TX: { code: string; name: string; q: string }[] = [
  { code: 'XAU', name: '伦敦金', q: 'hf_XAU' },
  { code: 'XAG', name: '伦敦银', q: 'hf_XAG' },
  { code: 'CL', name: '美原油', q: 'hf_CL' },
]

/** 抓全球行情（6 国外指数 + 3 商品）。抓不到的项跳过，不造假。 */
export async function fetchGlobalQuotes(timeoutSec = 10): Promise<GlobalQuote[]> {
  if (!_driver) { pushFetchError('fetchGlobalQuotes: driver 未注入'); return [] }
  const out: GlobalQuote[] = []

  // ── 国外指数：东财 push2 ulist ──
  try {
    const res = await fetchWithRetry<unknown>(
      ENDPOINT_GLOBAL_INDEX, 'globalIndex', INDEX_HEADERS, timeoutSec * 1000, 1, 2000,
    )
    if (res.status === 200) {
      const obj = res.data as { data?: { diff?: Record<string, unknown>[] } } | null
      const diff = obj?.data?.diff
      if (Array.isArray(diff)) {
        for (const d of diff) {
          const value = Number(d.f2)
          const change_pct = Number(d.f3)
          if (!Number.isFinite(value) || !Number.isFinite(change_pct)) continue
          out.push({ code: String(d.f12 ?? ''), name: String(d.f14 ?? ''), value, change_pct, kind: 'index' })
        }
      }
    }
  } catch (e) {
    pushFetchError(`fetchGlobalQuotes(东财指数): ${(e as Error).message}`)
  }

  // ── 商品：腾讯 hf_（全局正则，防原生层丢换行符） ──
  try {
    const url = `https://qt.gtimg.cn/q=${COMMODITY_TX.map((c) => c.q).join(',')}`
    const res = await fetchWithRetry<string>(
      url, 'globalCommodity', SOURCE_HEADERS, timeoutSec * 1000, 1, 2000,
    )
    if (res.status === 200) {
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      for (const c of COMMODITY_TX) {
        const m = new RegExp(`v_${c.q}="([^"]+)"`).exec(text)
        if (!m) continue
        const f = m[1].split(',')
        const price = Number(f[0])
        const change = Number(f[1])
        if (!Number.isFinite(price) || price <= 0) continue
        const prev = price - (Number.isFinite(change) ? change : 0)
        const change_pct = prev > 0 ? (change / prev) * 100 : 0
        out.push({ code: c.code, name: c.name, value: price, change_pct, kind: 'commodity' })
      }
    }
  } catch (e) {
    pushFetchError(`fetchGlobalQuotes(腾讯商品): ${(e as Error).message}`)
  }

  return out
}

// ─── 指数估值（PE / PB / 历史分位 / 股息率）─────────────────────────
// 数据源：蛋卷（雪球基金）https://danjuanfunds.com/djapi/index_eva/dj
//   · 公开指数估值数据、无需鉴权；一次返回 63 个指数，按 index_code 过滤目标宽基。
//   · 字段口径：
//       pe_percentile / pb_percentile 是 **0~1 小数**（如 0.606 = 60.6%），UI 显示时 ×100；
//       yeild 是股息率（0~1 小数）；eva_type ∈ low | mid | high（低估 / 适中 / 高估）；
//       pe = 0 表示该指数无意义 PE（债类等）→ UI 显示「—」，不参与判断。
//   · 抓不到 → 返回空数组 + 标「数据缺失」，不造假。
export interface IndexValuation {
  index_code: string
  name: string
  /** 市盈率；null/0 表示无意义（债类），UI 显示 — */
  pe: number | null
  pb: number | null
  /** PE 历史分位（0~1 小数） */
  pe_percentile: number | null
  /** PB 历史分位（0~1 小数） */
  pb_percentile: number | null
  /** 股息率（0~1 小数） */
  yeild: number | null
  /** low | mid | high */
  eva_type: string
  /** 数据日期（如 09-30） */
  date: string
}

/** 目标宽基（蛋卷覆盖的核心指数）→ 中文名（响应里的 name 优先，此为兜底） */
const INDEX_EVA_WANT: Record<string, string> = {
  SH000300: '沪深300',
  SZ399006: '创业板指',
  SH000905: '中证500',
  SZ399001: '深证成指',
  SH000016: '上证50',
}

const ENDPOINT_INDEX_EVA = 'https://danjuanfunds.com/djapi/index_eva/dj'

/** 蛋卷要求带 iPhone UA + Referer（裸请求会被拒） */
const DANJUAN_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  'Referer': 'https://danjuanfunds.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

/**
 * 抓取指数估值。codes 省略 → 取全部目标宽基（按 INDEX_EVA_WANT 顺序）。
 * 抓不到返回空数组（不造假）。
 */
export async function fetchIndexValuation(codes?: string[], timeoutSec = 12): Promise<IndexValuation[]> {
  if (!_driver) { pushFetchError('fetchIndexValuation: driver 未注入'); return [] }
  const order = codes && codes.length ? codes : Object.keys(INDEX_EVA_WANT)
  const want = new Set(order)

  try {
    const res = await fetchWithRetry<unknown>(
      ENDPOINT_INDEX_EVA, 'indexEva', DANJUAN_HEADERS, timeoutSec * 1000, 2, 4000,
    )
    if (res.status !== 200) return []
    const items = (res.data as { data?: { items?: Record<string, unknown>[] } } | null)?.data?.items
    if (!Array.isArray(items)) return []

    const num = (v: unknown): number | null => {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const out: IndexValuation[] = []
    for (const it of items) {
      const code = String(it.index_code ?? '')
      if (!code || !want.has(code)) continue
      out.push({
        index_code: code,
        name: String(it.name ?? INDEX_EVA_WANT[code] ?? code),
        pe: num(it.pe),
        pb: num(it.pb),
        pe_percentile: num(it.pe_percentile),
        pb_percentile: num(it.pb_percentile),
        yeild: num(it.yeild),
        eva_type: String(it.eva_type ?? ''),
        date: String(it.date ?? ''),
      })
    }
    // 按调用方给定顺序稳定排列（未命中的目标指数不补假数据）
    out.sort((a, b) => order.indexOf(a.index_code) - order.indexOf(b.index_code))
    return out
  } catch (e) {
    pushFetchError(`fetchIndexValuation: ${(e as Error).message}`)
    return []
  }
}

// ─── 指数历史 PE（估值分位曲线用）─────────────────────────────────
// 数据源：中证指数有限公司官网 index-perf（历史行情 + 市盈率）
//   · URL：https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=&startDate=&endDate=
//   · 返回日度行情；字段 `peg` 实为「市盈率 PE」（与蛋卷接口数值吻合）
//     —— 中证官网字段命名如此，不是 PEG。
//   · ⚠️ endDate 必须设为「未来日期」：接口只返回 endDate 所在年度**之前**的数据，
//     传当年日期会拿不到当年数据。故用「当前年 + 2」作为 endDate。
//   · 覆盖范围：仅中证系列（沪深300 SH000300 / 中证500 SH000905 / 上证50 SH000016 等）。
//     深证系列（深证成指 SZ399001 / 创业板指 SZ399006）不在中证官网 → 返回空，UI 如实标注不覆盖。
//   · 抓不到 → 返回空数组（不造假）。
export interface IndexPePoint {
  /** 交易日 yyyy-MM-dd */
  date: string
  /** 市盈率 PE */
  pe: number
}

const ENDPOINT_INDEX_PERF = 'https://www.csindex.com.cn/csindex-home/perf/index-perf'
const CSINDEX_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.csindex.com.cn/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

/** 蛋卷/雪球指数代码（SH000300 / SZ399006）→ 中证官网代码（000300）。
 *  仅中证系列（非 399 开头）有效；深证系列返回 null（中证官网不收录）。 */
export function toCsindexCode(indexCode: string): string | null {
  const m = /^(?:SH|SZ)?(\d{6})$/.exec(String(indexCode || '').trim().toUpperCase())
  if (!m) return null
  const code = m[1]
  if (code.startsWith('399')) return null
  return code
}

/** 归一化中证官网日期：'2026-08-01' / '20260930' → '2026-09-30'；非法返回 '' */
function _normCsindexDate(raw: string): string {
  const s = String(raw || '').trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return ''
}

/**
 * 抓取指数历史 PE 序列（近 years 年，日度）。
 * @param indexCode 蛋卷指数代码（如 SH000300）
 * @returns 升序 [{date, pe}]；不覆盖或抓不到 → []
 */
export async function fetchIndexPeHistory(indexCode: string, years = 10, timeoutSec = 15): Promise<IndexPePoint[]> {
  if (!_driver) { pushFetchError('fetchIndexPeHistory: driver 未注入'); return [] }
  const code = toCsindexCode(indexCode)
  if (!code) return [] // 深证系列无覆盖
  const nowY = new Date().getFullYear()
  const start = `${nowY - years}-01-01`
  const end = `${nowY + 2}-12-31` // 未来日期，规避接口「排除 endDate 当年」行为
  const url = `${ENDPOINT_INDEX_PERF}?indexCode=${code}&startDate=${start}&endDate=${end}`
  try {
    const res = await fetchWithRetry<unknown>(url, 'indexPerf', CSINDEX_HEADERS, timeoutSec * 1000, 2, 3000)
    if (res.status !== 200) return []
    const arr = (res.data as { data?: Record<string, unknown>[] } | null)?.data
    if (!Array.isArray(arr)) return []
    const seen = new Set<string>()
    const out: IndexPePoint[] = []
    for (const it of arr) {
      const date = _normCsindexDate(String(it.tradeDate ?? ''))
      const pe = Number(it.peg)
      if (!date || !Number.isFinite(pe) || pe <= 0) continue
      // 过滤非交易日（周末）——中证官网首条常为 startDate 占位（可能落在周末）
      const dow = new Date(`${date}T00:00:00`).getDay()
      if (dow === 0 || dow === 6) continue
      if (seen.has(date)) continue
      seen.add(date)
      out.push({ date, pe })
    }
    out.sort((a, b) => a.date.localeCompare(b.date))
    return out
  } catch (e) {
    pushFetchError(`fetchIndexPeHistory: ${(e as Error).message}`)
    return []
  }
}

// ─── 基金深度档案（评级/能力/规模/资产配置/持有人）─────────────────
// 数据源：pingzhongdata 静态 JS 里的 4 个变量
//   Data_performanceEvaluation → 五维能力评分（选证/收益/抗风险/稳定性/择时）+ 平均分 avr
//   Data_fluctuationScale      → 规模变动（各季度规模 + 环比）
//   Data_assetAllocation       → 资产配置（股票/债券/现金占净比）
//   Data_holderStructure       → 持有人结构（机构/个人/内部持有比例）
export interface FundProfile {
  fund_code: string
  /** 综合能力平均分（0~100） */
  score_avr: number | null
  /** 五维能力：选证/收益率/抗风险/稳定性/择时 */
  score_items: Array<{ name: string; value: number }>
  /** 最新规模（亿元）+ 环比 */
  scale_latest: number | null
  scale_mom: string | null
  /** 资产配置（最新一期，%） */
  alloc_stock: number | null
  alloc_bond: number | null
  alloc_cash: number | null
  /** 持有人结构（最新一期，%） */
  holder_inst: number | null
  holder_person: number | null
  holder_date: string | null
}

/** 从 pingzhongdata 文本里取出 `var <name> = {...}` 的 JSON 对象（按括号配对切，避开正则截断） */
function _extractJsonVar<T>(text: string, name: string): T | null {
  const i = text.indexOf('var ' + name)
  if (i < 0) return null
  const s = text.indexOf('{', i)
  if (s < 0) return null
  let depth = 0
  for (let j = s; j < text.length; j++) {
    const ch = text[j]
    if (ch === '"') {                       // 跳过字符串（含转义）
      j++
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; j++ }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(text.slice(s, j + 1)) as T } catch { return null }
      }
    }
  }
  return null
}

/** 抓取基金深度档案。抓不到返回 null（不造假）。 */
export async function fetchFundProfile(fundCode: string, timeoutSec = 15): Promise<FundProfile | null> {
  if (!_driver) { pushFetchError('fetchFundProfile: driver 未注入'); return null }
  try {
    const res = await fetchWithRetry<unknown>(
      ENDPOINT_FUND_PINGZHONG(fundCode), `fundProfile(${fundCode})`, SOURCE_HEADERS, timeoutSec * 1000, 2, 4000,
    )
    if (res.status !== 200) return null
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
    if (!text.includes('Data_performanceEvaluation')) return null

    const perf = _extractJsonVar<{ avr?: string; categories?: string[]; data?: number[] }>(text, 'Data_performanceEvaluation')
    const scale = _extractJsonVar<{ categories?: string[]; series?: Array<{ y?: number; mom?: string }> }>(text, 'Data_fluctuationScale')
    const alloc = _extractJsonVar<{ series?: Array<{ name?: string; data?: number[] }> }>(text, 'Data_assetAllocation')
    const holder = _extractJsonVar<{ categories?: string[]; series?: Array<{ name?: string; data?: number[] }> }>(text, 'Data_holderStructure')

    const last = <T,>(a?: T[]): T | null => (Array.isArray(a) && a.length ? a[a.length - 1] : null)
    const pickAlloc = (kw: string) => {
      const s = (alloc?.series ?? []).find(x => String(x?.name ?? '').includes(kw))
      const v = last(s?.data)
      return Number.isFinite(v as number) ? (v as number) : null
    }
    const pickHolder = (kw: string) => {
      const s = (holder?.series ?? []).find(x => String(x?.name ?? '').includes(kw))
      const v = last(s?.data)
      return Number.isFinite(v as number) ? (v as number) : null
    }
    const scaleLast = last(scale?.series)

    const scoreItems = (perf?.categories ?? []).map((n, k) => ({ name: String(n), value: Number(perf?.data?.[k] ?? NaN) }))
      .filter(x => Number.isFinite(x.value))
    const avr = Number(perf?.avr)

    return {
      fund_code: fundCode,
      score_avr: Number.isFinite(avr) ? avr : null,
      score_items: scoreItems,
      scale_latest: Number.isFinite(scaleLast?.y as number) ? (scaleLast?.y as number) : null,
      scale_mom: scaleLast?.mom != null ? String(scaleLast.mom) : null,
      alloc_stock: pickAlloc('股票'),
      alloc_bond: pickAlloc('债券'),
      alloc_cash: pickAlloc('现金'),
      holder_inst: pickHolder('机构'),
      holder_person: pickHolder('个人'),
      holder_date: last(holder?.categories) != null ? String(last(holder?.categories)) : null,
    }
  } catch (e) {
    pushFetchError(`fetchFundProfile(${fundCode}): ${(e as Error).message}`)
    return null
  }
}

/**
 * 从 JS 文本切出某变量赋值的**数组字面量**：`marker` 之后的 `[` 到 `endMarker` 之前最后一个 `]`。
 * 比正则 `\]\s*;` 稳——数组元素内部可能含同类字符，非贪婪匹配会中途截断。
 */
function _sliceJsArray(text: string, marker: string, endMarker: string): string | null {
  const i = text.indexOf(marker)
  if (i < 0) return null
  const s = text.indexOf('[', i)
  if (s < 0) return null
  let end = endMarker ? text.indexOf(endMarker, s + 1) : -1
  if (end < 0) {
    const nv = text.indexOf('var ', s + 1)
    end = nv > 0 ? nv : text.length
  }
  const e = text.lastIndexOf(']', end)
  if (e <= s) return null
  return text.slice(s, e + 1)
}

// ─── 基金公告───────

export interface FundNoticeRow {
  title: string
  pub_time: string
  url: string
}

/**
 * 抓取单只基金公告（东财 FundMNNotice）。
 * 手机端 app 接口；字段名按东财惯例宽松解析（TITLE/notice_date/URL 大小写形态都有）。
 * 返回空数组表示抓不到（调用方回落本地 news_feed，不造假）。
 */
export async function fetchFundNoticeRemote(fundCode: string, limit = 10, timeoutSec = 12): Promise<FundNoticeRow[]> {
  if (!_driver) return []
  try {
    const url =
      `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNNotice` +
      `?appType=ttjj&product=EFund&plat=Android&deviceid=test&FCODE=${fundCode}&pageIndex=1&pageSize=${limit}`
    const res = await withTimeout(
      _driver.get(url, SOURCE_HEADERS, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundNoticeRemote',
    )
    if (res.status !== 200) return []
    const obj = (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as
      { Datas?: Array<Record<string, unknown>>; datas?: Array<Record<string, unknown>> } | null
    const arr = obj?.Datas ?? obj?.datas ?? []
    if (!Array.isArray(arr) || arr.length === 0) return []
    const out: FundNoticeRow[] = []
    for (const r of arr) {
      const title = String(r.TITLE ?? r.title ?? r['标题'] ?? '').trim()
      const pub = String(r.NOTICE_DATE ?? r.notice_date ?? r.PUBLISH_DATE ?? r.date ?? '').trim()
      const link = String(r.URL ?? r.url ?? r.LINK ?? '').trim()
      if (!title) continue
      out.push({ title, pub_time: pub, url: link })
      if (out.length >= limit) break
    }
    if (out.length > 0) console.log(`[notice] ${fundCode} 远端公告 ${out.length} 条`)
    return out
  } catch (e) {
    pushFetchError(`fetchFundNoticeRemote(${fundCode}): ${(e as Error).message}`)
    return []
  }
}

// ─── 基金经理─────────────────// 数据源与净值同源：pingzhongdata 的 `Data_currentFundManager`（现任经理数组）。
// 会话内缓存：详情页反复打开同一基金不重复拉 50 万字符响应。
export interface FundManager {
  name: string
  /** 任职起始时间（源给的描述串，如 "2019-01-10"） */
  workTime: string
  /** 管理规模描述（如 "58.20亿"） */
  fundSize: string
  /** 在管基金数量 */
  fundCount: number | null
}
const _managerCache = new Map<string, FundManager | null>()

export async function fetchFundManager(fundCode: string, timeoutSec = 12): Promise<FundManager | null> {
  if (_managerCache.has(fundCode)) return _managerCache.get(fundCode) ?? null
  if (!_driver) return null
  try {
    const res = await withTimeout(
      _driver.get(ENDPOINT_FUND_PINGZHONG(fundCode), SOURCE_HEADERS, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundManager',
    )
    if (res.status !== 200) return null
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    const mText = _sliceJsArray(text, 'Data_currentFundManager', 'Data_performanceEvaluation')
    if (!mText) { _managerCache.set(fundCode, null); return null }
    let arr: unknown
    try { arr = JSON.parse(mText) } catch { _managerCache.set(fundCode, null); return null }
    const m = Array.isArray(arr) && arr.length > 0 ? (arr[0] as Record<string, unknown>) : null
    if (!m || !m.name) { _managerCache.set(fundCode, null); return null }
    const cnt = Number(m.fundCount)
    const out: FundManager = {
      name: String(m.name),
      workTime: String(m.workTime ?? ''),
      fundSize: String(m.fundSize ?? ''),
      fundCount: Number.isFinite(cnt) ? cnt : null,
    }
    _managerCache.set(fundCode, out)
    return out
  } catch (e) {
    pushFetchError(`fetchFundManager(${fundCode}): ${(e as Error).message}`)
    return null
  }
}

/**
 * 抓取东财 pingzhongdata（**完整历史净值**）。
 * 解析 `Data_netWorthTrend`（单位净值 + 日涨跌%）与 `Data_ACWorthTrend`（累计净值）。
 * 返回按日期升序；空数组表示抓不到。
 */
async function _fetchNavPingzhong(
  fundCode: string,
  timeoutSec: number,
): Promise<Array<{ fund_code: string; nav_date: string; nav: number; nav_acc: number | null; daily_growth: number | null }>> {
  try {
    const res = await withTimeout(
      _driver!.get(ENDPOINT_FUND_PINGZHONG(fundCode), SOURCE_HEADERS, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundNavList.pingzhong',
    )
    if (res.status !== 200) { pushFetchError(`fetchFundNavList.pingzhong(${fundCode}): HTTP ${res.status}`); return [] }
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    // 诊断：响应体大小 + 关键字段是否存在（大响应被桥截断时长度会异常）
    console.log(`[nav][pingzhong] ${fundCode} 响应 ${text.length} 字符; netWorthTrend=${text.includes('Data_netWorthTrend')}; ACWorthTrend=${text.includes('Data_ACWorthTrend')}`)

    // 按「下一个变量名」切片取数组：
    // 用正则 `\]\s*;` 会在数组内部提前截断/取到非法 JSON；用标记定位最稳。
    const unitText = _sliceJsArray(text, 'Data_netWorthTrend', 'Data_ACWorthTrend')
    if (!unitText) { pushFetchError(`fetchFundNavList.pingzhong(${fundCode}): 未找到 Data_netWorthTrend 数组`); return [] }
    let unit: Array<{ x: number; y: number; equityReturn?: number }>
    try {
      unit = JSON.parse(unitText)
    } catch (e) {
      console.log(`[nav][pingzhong] ${fundCode} 单位净值 JSON 解析失败: ${(e as Error).message}; 片段长度=${unitText.length}; 头部=${JSON.stringify(unitText.slice(0, 80))}`)
      pushFetchError(`fetchFundNavList.pingzhong(${fundCode}): 单位净值解析失败 ${(e as Error).message}`)
      return []
    }
    if (!Array.isArray(unit) || unit.length === 0) return []

    const accMap = new Map<number, number>()
    const accText = _sliceJsArray(text, 'Data_ACWorthTrend', 'Data_grandTotal')
    if (accText) {
      try {
        const acc = JSON.parse(accText) as Array<[number, number]>
        for (const pair of acc) if (Array.isArray(pair)) accMap.set(Number(pair[0]), Number(pair[1]))
      } catch { /* 累计净值缺失不影响单位净值 */ }
    }

    const out = unit
      .map(p => {
        const ts = Number(p.x)
        const nav = Number(p.y)
        if (!Number.isFinite(ts) || !Number.isFinite(nav)) return null
        // ts 是当地 0 点 → +8h 再取 UTC 日期，避免跨时区差一天
        const navDate = new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
        const acc = accMap.get(ts)
        const gr = Number(p.equityReturn)
        return {
          fund_code: fundCode,
          nav_date: navDate,
          nav,
          nav_acc: acc != null && Number.isFinite(acc) ? acc : null,
          daily_growth: Number.isFinite(gr) ? gr : null,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (out.length === 0) return []
    const first = out[0].nav_date
    const last = out[out.length - 1].nav_date
    console.log(`[nav][pingzhong] ${fundCode} 解析 ${out.length} 条, ${first} → ${last}, acc命中 ${accMap.size}`)
    // 数据过期（最新点早于 90 天）→ 判为抓取异常，落到其它源，避免用陈旧数据算收益
    const staleDays = (Date.now() - new Date(`${last}T00:00:00Z`).getTime()) / 86400000
    if (staleDays > 90) {
      pushFetchError(`fetchFundNavList.pingzhong(${fundCode}): 数据过期（最新 ${last}，${Math.round(staleDays)} 天前），判为异常`)
      return []
    }
    return out
  } catch (e) {
    pushFetchError(`fetchFundNavList.pingzhong(${fundCode}): ${(e as Error).message}`)
    return []
  }
}

async function _fetchNavSina(fundCode: string, timeoutSec: number): Promise<Array<{ fund_code: string; nav_date: string; nav: number; nav_acc: number | null; daily_growth: number | null }>> {
  try {
    const url = `https://hq.sinajs.cn/list=of${fundCode}`
    const res = await withTimeout(
      _driver!.get(url, { ...SOURCE_HEADERS, Referer: 'https://finance.sina.com.cn/' }, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundNavList.sina',
    )
    if (res.status !== 200) { pushFetchError(`fetchFundNavList.sina(${fundCode}): HTTP ${res.status}`); return [] }
    let text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    const m = text.match(new RegExp(`var\\s+hq_str_of${fundCode}="([^"]*)"`))
    if (!m || !m[1]) return []
    const cols = m[1].split(',')
    if (cols.length < 6) return []
    const nav = Number(cols[1])
    const navAcc = Number(cols[2])
    const growth = Number(cols[4])
    const date = cols[5]
    if (!Number.isFinite(nav) || !date) return []
    console.log(`[fetch] 净值备用源 命中 ${fundCode}: nav=${nav} date=${date}`)
    return [{
      fund_code: fundCode,
      nav_date: date,
      nav,
      nav_acc: Number.isFinite(navAcc) ? navAcc : null,
      daily_growth: Number.isFinite(growth) ? growth : null,
    }]
  } catch (e) {
    pushFetchError(`fetchFundNavList.sina(${fundCode}): ${(e as Error).message}`)
    return []
  }
}

function _parseFundNavList(fundCode: string, raw: unknown): Array<{ fund_code: string; nav_date: string; nav: number; nav_acc: number | null; daily_growth: number | null }> {
  // 东财 H5 字段：FSRQ / NAV / NAVACC / RGROWTH (rate of growth %)
  // 兼容旧字段：date / price
  // 三种来源字段：① fundmobapi `Datas[]` ② `datas.CalendarDay[]` ③ f10/lsjz `Data.LSJZList[]`
  const arr = (raw as { Datas?: Array<Record<string, unknown>> })?.Datas
    ?? (raw as { datas?: { CalendarDay?: Array<Record<string, unknown>> } })?.datas?.CalendarDay
    ?? (raw as { Data?: { LSJZList?: Array<Record<string, unknown>> } })?.Data?.LSJZList
    ?? []
  if (!Array.isArray(arr)) return []
  const out: Array<{ fund_code: string; nav_date: string; nav: number; nav_acc: number | null; daily_growth: number | null }> = []
  for (const r of arr) {
    const date = String(r.FSRQ ?? r.date ?? r['日期'] ?? '').slice(0, 10)
    const nav = Number(r.NAV ?? r.DWJZ ?? r.price ?? r['净值'] ?? NaN)
    if (!date || !Number.isFinite(nav)) continue
    const navAcc = Number(r.NAVACC ?? r.LJJZ ?? r['累计净值'] ?? NaN)
    const gr = Number(r.RGROWTH ?? r.JZZZL ?? r['日增长率'] ?? NaN)
    out.push({
      fund_code: fundCode,
      nav_date: date,
      nav,
      nav_acc: Number.isFinite(navAcc) ? navAcc : null,
      daily_growth: Number.isFinite(gr) ? gr : null,
    })
  }
  return out
}

// ─── 4) 单只基金实时状态（申购 / 赎回 / 限购） ─────

export async function fetchFundStatusRemote(fundCode: string, timeoutSec = 60): Promise<StatusSnapshot | null> {
  if (!_driver) { pushFetchError(`fetchFundStatusRemote(${fundCode}): driver 未注入`); return null }
  try {
    const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?plat=Android&appType=ttjj&deviceid=test&FCODE=${fundCode}&_=${Date.now()}`
    const res = await withTimeout(
      _driver.get(url, SOURCE_HEADERS, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundStatusRemote',
    )
    if (res.status !== 200) { pushFetchError(`fetchFundStatusRemote(${fundCode}): HTTP ${res.status}`); return null }
    return _parseFundStatus(fundCode, res.data)
  } catch (e) {
    pushFetchError(`fetchFundStatusRemote(${fundCode}): ${(e as Error).message}`)
    console.warn('[fetch] fetchFundStatusRemote 失败:', (e as Error).message)
    return null
  }
}

function _parseFundStatus(fundCode: string, raw: unknown): StatusSnapshot | null {
  const obj = raw as { Datas?: Array<Record<string, unknown>> } | null
  if (!obj || !obj.Datas || obj.Datas.length === 0) return null
  const r = obj.Datas[0]
  const rawPur = String(r.PurchaseStatus ?? r.purchase_status ?? r['申购状态'] ?? '')
  const rawRed = String(r.RedemptStatus ?? r.redeem_status ?? r['赎回状态'] ?? '')
  const ps = parseStatus(rawPur, rawRed)
  const purchaseLimit = ps.purchase === 'limited' ? _extractLimit(rawPur) : null
  return {
    fund_code: fundCode,
    status_date: new Date().toISOString().slice(0, 10),
    purchase_status: ps.purchase,
    redeem_status: ps.redeem,
    purchase_limit: purchaseLimit,
    limit_unknown: ps.purchase === 'limited' && purchaseLimit === null,
    raw_purchase: rawPur,
    raw_redeem: rawRed,
    note: `原始状态：申购[${rawPur}] 赎回[${rawRed}]`,
    source: 'em_daily',
    fetched_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    from_cache: false,
  }
}

function _extractLimit(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}

// ─── 5) 基金行业配置 ─────

/**
 * 抓取单只基金的行业配置。
 * 主源：F10 的行业配置接口
 *   `api.fund.eastmoney.com/f10/HYPZ/`（季报披露口径，**必须带 fundf10 的 Referer**，否则返回空 Data）。
 * 备源：fundmobapi 的 FundJGPRData（历史接口，当前多返回 ErrCode 61136 限流）。
 * 返回 [{ industry, weight, report_date }]，空数组表示抓不到（不编造）。
 */
export interface IndustryAllocRow {
  industry: string
  weight: number          // 占净值比例（%）
  report_date: string     // 'YYYY-MM-DD'
}

const F10_HYPZ_HEADERS = {
  'User-Agent': SOURCE_HEADERS['User-Agent'],
  'Referer': 'https://fundf10.eastmoney.com/',
}

export async function fetchIndustryAllocation(fundCode: string, timeoutSec = 30): Promise<IndustryAllocRow[]> {
  if (!_driver) { pushFetchError(`fetchIndustryAllocation(${fundCode}): driver 未注入`); return [] }
  // 主源：F10 行业配置（api.fund.eastmoney.com/f10/HYPZ/）—— 当年无数据时回退上一年
  const thisYear = new Date().getFullYear()
  for (const year of [thisYear, thisYear - 1]) {
    try {
      const url = `https://api.fund.eastmoney.com/f10/HYPZ/?fundcode=${fundCode}&year=${year}`
      const res = await withTimeout(
        _driver.get(url, F10_HYPZ_HEADERS, timeoutSec * 1000),
        timeoutSec * 1000,
        'fetchIndustryAllocation.f10',
      )
      if (res.status !== 200) { pushFetchError(`fetchIndustryAllocation(${fundCode}): HTTP ${res.status} @${year}`); continue }
      const raw = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
      const rows = _parseIndustryFromF10Api(raw)
      if (rows.length > 0) {
        console.log(`[industry][f10] ${fundCode} ${rows[0].report_date} 解析 ${rows.length} 个行业`)
        return rows
      }
    } catch (e) {
      pushFetchError(`fetchIndustryAllocation.f10(${fundCode}@${year}): ${(e as Error).message}`)
    }
  }
  // 备源：FundJGPRData（历史接口）
  try {
    const url = `https://fundmobapi.eastmoney.com/FundJGPRData?appType=ttjj&product=EFund&plat=Android&deviceid=test&FCODE=${fundCode}&pageSize=50`
    const res = await withTimeout(
      _driver.get(url, SOURCE_HEADERS, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchIndustryAllocation',
    )
    if (res.status !== 200) { pushFetchError(`fetchIndustryAllocation(${fundCode}): HTTP ${res.status}`); return [] }
    const result = _parseIndustryAllocation(fundCode, res.data)
    if (result.length > 0) return result
    pushFetchError(`fetchIndustryAllocation(${fundCode}): 接口返回空`)
    return []
  } catch (e) {
    pushFetchError(`fetchIndustryAllocation(${fundCode}): ${(e as Error).message}`)
    return []
  }
}

/**
 * api.fund.eastmoney.com/f10/HYPZ 的返回：
 * { Data: { QuarterInfos: [ { JZRQ:'2026-06-30', HYPZInfo:[ { HYMC:'制造业', ZJZBL:'72.78', SZ:… } ] } ] } }
 * HYPZInfo 为证监会行业分类（门类），权重 0 的行业会被过滤。
 */
function _parseIndustryFromF10Api(raw: unknown): IndustryAllocRow[] {
  const data = (raw as { Data?: { QuarterInfos?: Array<Record<string, unknown>> } } | null)?.Data
  const quarters = data?.QuarterInfos
  if (!Array.isArray(quarters) || quarters.length === 0) return []
  const sorted = [...quarters].sort(
    (a, b) => String(b?.JZRQ ?? '').localeCompare(String(a?.JZRQ ?? '')),
  )
  for (const q of sorted) {
    const reportDate = String(q?.JZRQ ?? '').slice(0, 10)
    const list = Array.isArray(q?.HYPZInfo) ? (q.HYPZInfo as Array<Record<string, unknown>>) : []
    const out: IndustryAllocRow[] = []
    for (const r of list) {
      const industry = String(r?.HYMC ?? '').trim()
      const weight = Number(String(r?.ZJZBL ?? '').replace('%', ''))
      if (!industry || !Number.isFinite(weight) || weight <= 0) continue
      out.push({ industry, weight, report_date: reportDate })
    }
    if (out.length) return out
  }
  return []
}

function _parseIndustryAllocation(_fundCode: string, raw: unknown): IndustryAllocRow[] {
  const arr = (raw as { Datas?: Array<Record<string, unknown>> } | null)?.Datas ?? []
  if (!Array.isArray(arr) || arr.length === 0) return []
  // 东财返回多条历史记录（含不同报告期），取最新的
  const byDate = new Map<string, Record<string, unknown>>()
  for (const r of arr) {
    const reportDate = String(r['报告期'] ?? r['日期'] ?? r.date ?? '').slice(0, 10)
    if (reportDate && !byDate.has(reportDate)) byDate.set(reportDate, r)
  }
  const latestRows = Array.from(byDate.values())
    .sort((a, b) => String(b['报告期'] ?? b['日期'] ?? '').localeCompare(String(a['报告期'] ?? a['日期'] ?? '')))
    .slice(0, 1)
  if (latestRows.length === 0) return []
  const out: IndustryAllocRow[] = []
  for (const r of latestRows) {
    const industry = String(r['行业类别'] ?? r['行业'] ?? '').trim()
    const rawWeight = Number(r['占净值比例'] ?? r.weight ?? NaN)
    const reportDate = String(r['报告期'] ?? r['日期'] ?? '').slice(0, 10)
    if (!industry || !Number.isFinite(rawWeight)) continue
    out.push({ industry, weight: rawWeight, report_date: reportDate })
  }
  return out
}

// ─── 6) 基金重仓股（前十大） ────

export interface FundTopHoldingRow {
  fund_code: string
  stock_code: string
  stock_name: string
  weight_pct: number       // 占净值比例（%）
  report_date: string      // 报告期
  fetched_at: string
}

/**
 * 抓取单只基金前十大重仓股。
 * 主源 FundMNTop10StockList；设备端常返回空 → 加 **F10 jjcc 兜底源**
 * （fundf10.eastmoney.com，网页接口，content 为 HTML 表格，正则解析）。
 * 返回 [{ fund_code, stock_code, stock_name, weight_pct, report_date, fetched_at }]。
 */
export async function fetchFundTopHoldings(fundCode: string, timeoutSec = 30): Promise<FundTopHoldingRow[]> {
  if (!_driver) { pushFetchError(`fetchFundTopHoldings(${fundCode}): driver 未注入`); return [] }
  try {
    const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNTop10StockList?appType=ttjj&product=EFund&plat=Android&deviceid=test&FCODE=${fundCode}`
    const res = await withTimeout(
      _driver.get(url, SOURCE_HEADERS, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundTopHoldings',
    )
    if (res.status === 200) {
      const result = _parseFundTopHoldings(fundCode, res.data)
      if (result.length > 0) return result
    }
    pushFetchError(`fetchFundTopHoldings(${fundCode}): 主源返回空，落 F10 兜底`)
  } catch (e) {
    pushFetchError(`fetchFundTopHoldings(${fundCode}): ${(e as Error).message}（落 F10 兜底）`)
  }
  // 兜底源：东财 F10 基金持仓（jjcc）
  try {
    const year = new Date().getFullYear()
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&topline=10&year=${year}&month=3,6,9,12&code=${fundCode}`
    const res = await withTimeout(
      _driver.get(url, { ...SOURCE_HEADERS, Referer: 'https://fundf10.eastmoney.com/' }, timeoutSec * 1000),
      timeoutSec * 1000,
      'fetchFundTopHoldings.f10',
    )
    if (res.status !== 200) { pushFetchError(`fetchFundTopHoldings.f10(${fundCode}): HTTP ${res.status}`); return [] }
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
    const rows = _parseF10TopHoldings(fundCode, text)
    if (rows.length > 0) {
      console.log(`[top10][f10] ${fundCode} 解析 ${rows.length} 条`)
      return rows
    }
    pushFetchError(`fetchFundTopHoldings.f10(${fundCode}): 解析为空`)
    return []
  } catch (e) {
    pushFetchError(`fetchFundTopHoldings.f10(${fundCode}): ${(e as Error).message}`)
    return []
  }
}

/** F10 jjcc：`var apidata={ content:"<table>…</table>",…};` 提最近报告期的重仓股行 */
function _parseF10TopHoldings(fundCode: string, text: string): FundTopHoldingRow[] {
  // content 是转义的 HTML 字符串；先定位 content，再抓 <tr> 行
  const ci = text.indexOf('content')
  if (ci < 0) return []
  const seg = text.slice(ci, ci + 200000)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  // 报告期行头：<div class="label">2026年2季度股票投资明细</div> 或 <th> 报告日期；从表格里抓「代码 名称 占净值比例」
  const rows: FundTopHoldingRow[] = []
  // 每行结构：<td>1</td><td><a>600000</a>…</td><td>浦发银行</td>…<td>3.21%</td>
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
  let m: RegExpExecArray | null
  // 报告期：优先取 content 里第一个 "YYYY-MM-DD" 形式的日期（季度表头附近）
  const dMatch = seg.match(/(\d{4}-\d{2}-\d{2})/)
  const reportDate = dMatch ? dMatch[1] : ''
  while ((m = trRe.exec(seg))) {
    const tr = m[1]
    const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []
    const cells = tds.map(td => td.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
    if (cells.length < 4) continue
    // 常见列序：序号 | 股票代码 | 股票名称 | …相关… | 占净值比例(%)
    const code = (cells.find(c => /^\d{6}$/.test(c)) || '').slice(0, 6)
    const pctCell = cells.find(c => /^\d+(?:\.\d+)?%$/.test(c))
    if (!code || !pctCell) continue
    const weight = Number(pctCell.replace('%', ''))
    if (!Number.isFinite(weight)) continue
    // 名称：代码后第一个非序号、非百分比、非代码的中文串
    const codeIdx = cells.findIndex(c => c === code)
    const name = (cells[codeIdx + 1] && !/^\d+(?:\.\d+)?%?$/.test(cells[codeIdx + 1]) && cells[codeIdx + 1] !== code)
      ? cells[codeIdx + 1] : ''
    rows.push({
      fund_code: fundCode,
      stock_code: code,
      stock_name: name,
      weight_pct: weight,
      report_date: reportDate,
      fetched_at: now,
    })
    if (rows.length >= 10) break
  }
  return rows
}

function _parseFundTopHoldings(fundCode: string, raw: unknown): FundTopHoldingRow[] {
  // 东财手机端返回：{ Datas: [ { StockCode, StockName, Weight, ReportDate, ... } ] }
  const arr = (raw as { Datas?: Array<Record<string, unknown>> } | null)?.Datas ?? []
  if (!Array.isArray(arr) || arr.length === 0) return []
  const out: FundTopHoldingRow[] = []
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  for (const r of arr) {
    const stockCode = String(r.StockCode ?? r.stock_code ?? r['股票代码'] ?? '').trim()
    const stockName = String(r.StockName ?? r.stock_name ?? r['股票名称'] ?? '').trim()
    const rawWeight = Number(r.Weight ?? r.weight ?? r['占净值比例'] ?? NaN)
    const reportDate = String(r.ReportDate ?? r.report_date ?? r['报告期'] ?? '').slice(0, 10)
    if (!stockCode || !Number.isFinite(rawWeight)) continue
    out.push({
      fund_code: fundCode,
      stock_code: stockCode,
      stock_name: stockName,
      weight_pct: rawWeight,
      report_date: reportDate,
      fetched_at: now,
    })
  }
  return out
}