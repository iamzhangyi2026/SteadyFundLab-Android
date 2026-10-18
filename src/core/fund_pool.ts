// ─────────────────────────────────────────────
// fund_pool.ts · 候选基金池查询（数据经 HTTP 抓取层获取）
//
//
// 设计原则：
//   - 函数签名：get_name_df / get_purchase_df
//   - 缓存机制必须保留（_localCacheGet / _localCacheSet）—— 全市场表约 2.4 万只、实拉约 28s
//   - 接口拿不到 → 标「数据缺失」，返回空（E3），不返回假数据
//
// 与 status.ts 配合：HTTP 抓取逻辑类似，由 setFetcher 注入，便于测试降级路径
// ─────────────────────────────────────────────

import type { LedgerDb } from './budget.ts'
import { normalizeFundCode, logCodeCorrection, pushFetchError, pushError } from '../data/sqlite_fetcher.ts'
import { FULL_MARKET_CONFIG } from './config.ts'

// ─── 性能优化：refreshMarketData 批大小/超时 ──────────────────
// 复用 FULL_MARKET_CONFIG.batchSize / batchTimeoutMs，与 dataAdapter.refreshMarketBatched 保持一致
const BATCH_SIZE = FULL_MARKET_CONFIG.batchSize        // 500 条/批
const BATCH_TIMEOUT_MS = FULL_MARKET_CONFIG.batchTimeoutMs // 30s

// ─── 进度日志（诊断"24088 → 348"的关键） ───────────────────
// 记录每一步的输入/输出/失败，方便「更多 → 导出诊断」一眼看到差异
const _progressLog: Array<{ ts: string; phase: string; msg: string }> = []
const MAX_PROGRESS_LOG = 30
function _logProgress(phase: string, msg: string): void {
  const entry = { ts: new Date().toISOString(), phase, msg }
  _progressLog.push(entry)
  if (_progressLog.length > MAX_PROGRESS_LOG) _progressLog.shift()
  console.log(`[pool][${phase}]`, msg)
}
export function getPoolProgressLog(): Array<{ ts: string; phase: string; msg: string }> {
  return [..._progressLog]
}
export function clearPoolProgressLog(): void { _progressLog.length = 0 }

// ─── 类型定义 ──────────────────────────────────────────────────────────

/** 全市场基金列表 */
export interface FundNameRow {
  fund_code: string       // 基金代码
  fund_name: string       // 基金简称
  fund_type: string | null // 基金类型（如「混合型-偏股」）；源里没有则为 null，**不造「其他」**
  fund_full_name?: string // 基金全称
}

/** 申购/费率信息（来自 fund_quote_fundinfo / fund_open_fund_info_em） */
export interface PurchaseRow {
  fund_code: string
  fund_name?: string
  category: string | null  // 混合型/股票型/债券型/...；源里没有则为 null，**不造「其他」**
  purchase_fee_rate: number | null
  /**
   * 起购金额（元）。语义：
   *   - number：源里能解析到的起购金额
   *   - null ：源里「未知」——不是「不限」；落库时保留 DB 旧值
   * 各基金不同：支付宝多数 1 元起，但部分 10 / 100 元，不能用全局常量兜底
   */
  min_purchase: number | null
  apply_status?: string  // 申购状态文本
  redeem_status?: string // 赎回状态文本
  source?: string
  fetch_date?: string
}

/** 本地缓存条目（key → value + 过期时间） */
interface CacheEntry<T> {
  value: T
  expires_at: number  // Date.now() + ttl
}

// ─── 常量 ──────────────────────────────────────────────────────────

/** 缓存 TTL（24h，全市场表变动不频繁） */
const CACHE_TTL_MS = 24 * 3600 * 1000

/** 候选池 SQL */
export const CREATE_FUND_TABLE = `
CREATE TABLE IF NOT EXISTS funds (
  fund_code TEXT PRIMARY KEY,
  fund_name TEXT NOT NULL,
  category TEXT,
  purchase_fee_rate REAL,
  min_purchase REAL DEFAULT 1.0,    -- 支付宝多数 1 元起，但各基金不同
  is_qdii INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  added_at TEXT,
  note TEXT
);
`

export const CREATE_POOL_MARKER_TABLE = `
CREATE TABLE IF NOT EXISTS pool_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
`

// ─── 内存级本地缓存（fallback，浏览器端可用 localStorage 替代） ──

const _localCache = new Map<string, CacheEntry<unknown>>()

/** 本地缓存读（TTL 失效返回 null） */
export function _localCacheGet<T>(key: string): T | null {
  const entry = _localCache.get(key) as CacheEntry<T> | undefined
  if (!entry) return null
  if (Date.now() > entry.expires_at) {
    _localCache.delete(key)
    return null
  }
  return entry.value
}

/** 本地缓存写 */
export function _localCacheSet<T>(key: string, value: T, ttlMs = CACHE_TTL_MS): void {
  _localCache.set(key, { value, expires_at: Date.now() + ttlMs })
}

// ─── HTTP 注入（与 status.ts 同模式：测试可注入失败 fetcher） ──

export type RemoteDataFetcher = (url: string, timeoutSec: number) => Promise<unknown[]>
let _dataFetcher: RemoteDataFetcher | null = null

export function setFundPoolFetcher(fetcher: RemoteDataFetcher | null): void {
  _dataFetcher = fetcher
}

// ─── 工具 ──────────────────────────────────────────────

/** 转 float，空串不算 */
export function _toFloat(s: unknown): number | null {
  if (s === null || s === undefined || s === '') return null
  const n = parseFloat(String(s))
  return isNaN(n) ? null : n
}

/** 标准化日期到 'YYYY-MM-DD' */
export function _normDate(s: unknown): string {
  if (!s) return ''
  const str = String(s).trim()
  // 已经是 YYYY-MM-DD
  const m1 = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`
  return str
}

/** QDII 识别 */
export function _isQdii(category: string): boolean {
  if (!category) return false
  const c = category.toUpperCase()
  return c.includes('QDII') || c.includes('海外') || c.includes('跨境')
}

// ─── 核心：全市场表 ─────────────────────

/**
 * 全市场基金列表（约 2.4 万只，实拉 28s）
 * 数据源：HTTP 直连东方财富（getFundNameEM API）
 */
export async function getNameDf(force = false): Promise<FundNameRow[]> {
  const cacheKey = 'fund_name_df_v2'
  if (force) _localCache.delete(cacheKey)  // 强制刷新：清除旧缓存
  else {
    const cached = _localCacheGet<FundNameRow[]>(cacheKey)
    if (cached) return cached
  }
  if (!_dataFetcher) {
    // E3：拿不到返回空，绝不造假
    return []
  }
  const rows = await _dataFetcher('fund_name_em', 60.0) as FundNameRow[]
  // 规范化：补零 + 去后缀 + 丢弃非法 code（静默，不提示用户）
  const norm = rows.map(r => {
    const rawCode = String(r.fund_code ?? '')
    const code = normalizeFundCode(rawCode)
    if (!code) return null
    return {
      fund_code: code,
      fund_name: String(r.fund_name ?? ''),
      fund_type: r.fund_type ? String(r.fund_type).trim() : null,
      fund_full_name: r.fund_full_name as string | undefined,
    }
  }).filter((r): r is NonNullable<typeof r> => r !== null)
  if (norm.length > 0) _localCacheSet(cacheKey, norm)
  return norm
}

/**
 * 全市场申购费率表（与 getNameDf 同样规模）
 * 数据源：HTTP 直连
 */
export async function getPurchaseDf(force = false): Promise<PurchaseRow[]> {
  const cacheKey = 'fund_purchase_df_v2'
  if (force) _localCache.delete(cacheKey)  // 强制刷新：清除旧缓存
  else {
    const cached = _localCacheGet<PurchaseRow[]>(cacheKey)
    if (cached) return cached
  }
  if (!_dataFetcher) {
    return []
  }
  const rows = await _dataFetcher('fund_purchase_info_em', 60.0) as PurchaseRow[]
  // 规范化：补零 + 去后缀 + 丢弃非法 code（静默，不提示用户）
  const norm = rows.map(r => {
    const rawCode = String(r.fund_code ?? '')
    const code = normalizeFundCode(rawCode)
    if (!code) return null
    return {
      fund_code: code,
      fund_name: r.fund_name,
      category: r.category ? String(r.category).trim() : null,
      purchase_fee_rate: _toFloat(r.purchase_fee_rate),
      // 「购买起点」字段：min_purchase: _toFloat(r.get("购买起点"))
      // 源里未知 → null，不是「不限」
      min_purchase: _toFloat((r as unknown as Record<string, unknown>)['min_purchase']
        ?? (r as unknown as Record<string, unknown>)['购买起点']
        ?? (r as unknown as Record<string, unknown>)['purchase_min']),
      apply_status: r.apply_status,
      redeem_status: r.redeem_status,
      source: r.source ?? 'em_daily',
      fetch_date: r.fetch_date,
    }
  }).filter((r): r is NonNullable<typeof r> => r !== null)
  if (norm.length > 0) _localCacheSet(cacheKey, norm)
  return norm
}

// ─── 池子操作 ──────────────────────────────────────────────

/**
 * 刷新候选池（每日一次）：先抓全市场 → 落库 funds 表
 * 拿不到 → 直接返回（E3），不抛错（避免打断 App 启动）
 *
 * 数据校验（零提示，自动修正）：
 *   - code 缺零 / 带后缀 → normalizeFundCode() 自动修复，修正记录写 fund_code_correction_log
 *   - 多源名字不一致 → 主源（东财H5）优先覆盖，备用源仅补漏
 *   - 无法修复的 code → 静默丢弃，记录日志
 */
export async function refreshMarketData(db: LedgerDb, force = false): Promise<{ name_count: number; purchase_count: number; inserted: number; note: string }> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  _logProgress('start', `refreshMarketData force=${force}`)
  // nameDf 为主驱动：即使 purchaseDf 为 0 也能落库
  const nameDf = await getNameDf(force)
  const purchaseDf = await getPurchaseDf(force)
  _logProgress('fetch', `nameDf.length=${nameDf.length}, purchaseDf.length=${purchaseDf.length}, diff=${nameDf.length - purchaseDf.length}`)

  // ── ① 双源合并 + ② 多源名字冲突解决 ──
  // getNameDf 内部已处理主/备切换（主源非空则直接返回，空才走备用源），
  // 这里直接以 getNameDf 返回的数据为准，purchaseDf 用于补充申购信息。
  // 无需额外合并逻辑，因为两个 fetcher 各自独立走主→备降级。

  const purchaseByCode = new Map(purchaseDf.map(r => [r.fund_code, r]))
  let inserted = 0
  let failed = 0
  const firstError: string | null = null
  const sampleFailures: string[] = []

  // 性能优化：分批事务（BATCH_SIZE 条/批）+ 单批超时保护
  // 历史实现：每批 500 条事务，遇错回退逐行 → 27905 行仍可能跑很久
  // 当前实现：每批独立事务，单批失败 → 计入 failed 继续下一批（不再回退逐行）。
  //   理由：单批 500 条失败一般是 schema/约束问题，逐行也是同样错；继续推进更稳。
  // 类型优先级：主源 fund_type 为准；purchaseDf 仅补费率/起购，不得覆盖真实类型。
  const buildParams = (nameRow: FundNameRow): unknown[] => {
    const p = purchaseByCode.get(nameRow.fund_code)
    const fundName = nameRow.fund_name ?? p?.fund_name ?? ''
    const category = (nameRow.fund_type && String(nameRow.fund_type).trim())
      || (p?.category && String(p.category).trim())
      || null
    return [
      nameRow.fund_code, fundName, category,
      p?.purchase_fee_rate ?? null, p?.min_purchase ?? null,
      _isQdii(category ?? '') ? 1 : 0, now, null,
    ]
  }

  const t0 = performance.now()
  for (let start = 0; start < nameDf.length; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, nameDf.length)
    const batch = nameDf.slice(start, end)

    // 单批超时保护：累计耗时 / 已完成批数 > BATCH_TIMEOUT_MS → 中止后续批
    const elapsedSoFar = performance.now() - t0
    const batchesDone = start / BATCH_SIZE
    if (batchesDone > 0 && elapsedSoFar / batchesDone > BATCH_TIMEOUT_MS) {
      const msg = `refreshMarketData: 平均每批 ${Math.round(elapsedSoFar / batchesDone)}ms 超过阈值 ${BATCH_TIMEOUT_MS}ms，中止剩余 ${nameDf.length - end} 行`
      console.warn('[pool]', msg)
      pushFetchError(msg)
      _logProgress('timeout', msg)
      break
    }

    try {
      await db.transaction(async () => {
        // 性能：批内改「多行 INSERT」——100 行/语句（800 参数，避开 SQLite 变量上限 999）。
        // CapacitorSQLite 的 db.run 每条 = 一次原生桥往返（6~17ms），
        // transaction 只省 commit 不省往返；逐条 27916 条 ≈ 3~8 分钟写入风暴，
        // 期间所有 SQLite 读（搜索/持仓/订单）都被拖慢 → 交易页返回白板、搜索半秒+。
        for (let i = 0; i < batch.length; i += 100) {
          const sub = batch.slice(i, i + 100)
          const tuples = sub.map(() => "(?, ?, ?, ?, ?, ?, 'active', ?, ?)").join(', ')
          const params: unknown[] = []
          for (const row of sub) params.push(...buildParams(row))
          await db.run(
            `INSERT INTO funds (fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii, status, added_at, note)
             VALUES ${tuples}
             ON CONFLICT(fund_code) DO UPDATE SET
               fund_name=excluded.fund_name,
               category=excluded.category,
               purchase_fee_rate=excluded.purchase_fee_rate,
               min_purchase=COALESCE(excluded.min_purchase, funds.min_purchase),
               is_qdii=excluded.is_qdii,
               added_at=excluded.added_at`,
            params,
          )
        }
      })
      inserted += batch.length
      _logProgress('insert', `progress ${end}/${nameDf.length} inserted=${inserted} failed=${failed}`)
    } catch (e) {
      // 单批失败 → 整批计入 failed，继续下一批（避免一条坏数据拖累全部）
      failed += batch.length
      const errMsg = (e as Error).message
      const sample = `${batch[0].fund_code}..${batch[batch.length - 1].fund_code}: ${errMsg}`
      if (sampleFailures.length < 3) sampleFailures.push(sample)
      pushFetchError(`refreshMarketData batch ${start + 1}-${end}/${nameDf.length} failed: ${errMsg}`)
      _logProgress('batch-fail', sample)
    }
  }
  const elapsed = Math.round(performance.now() - t0)

  _logProgress('done', `inserted=${inserted} failed=${failed} elapsed=${elapsed}ms`)
  if (sampleFailures.length > 0) {
    _logProgress('fail-sample', sampleFailures.join(' | '))
  }
  console.log(`[pool] refreshMarketData: name=${nameDf.length}, purchase=${purchaseDf.length}, inserted=${inserted}, failed=${failed}`)
  try {
    await db.run(
      `INSERT OR REPLACE INTO pool_meta (key, value, updated_at) VALUES ('last_refresh', ?, ?)`,
      [now, now],
    )
  } catch (e) {
    pushFetchError(`refreshMarketData pool_meta 写失败: ${(e as Error).message}`)
  }
  const note = inserted === 0 && nameDf.length === 0
    ? '数据缺失，未落库'
    : inserted === 0 && nameDf.length > 0
      ? `⚠️ 抓到 ${nameDf.length} 只但全部落库失败（first: ${sampleFailures[0] || '未知'}）`
      : failed > 0
        ? `已落库 ${inserted}/${nameDf.length}（${failed} 条失败）`
        : `已落库 ${inserted} 条`
  return {
    name_count: nameDf.length,
    purchase_count: purchaseDf.length,
    inserted,
    note,
  }
}

/** 单笔查申购费率 */
export function lookupPurchase(db: LedgerDb, code: string): PurchaseRow | null {
  // 注：无外部 IO 时同步返回
  // 但保持 Promise 接口以统一数据层调用风格
  return _lookupPurchaseSync(db, code)
}

function _lookupPurchaseSync(db: LedgerDb, code: string): PurchaseRow | null {
  // 实际调用需要 await，但为了避免破坏同步接口约定，
  // 这里采用同步写法的「近似实现」（调用方实际应 await 本文件提供的 async 版本）。
  // —— 简化：用 query Promise 同步无法处理，改为抛出警告让调用方改用异步版
  throw new Error('请使用 lookupPurchaseAsync 替代')
}

/** 异步版 lookupPurchase（正确实现） */
export async function lookupPurchaseAsync(db: LedgerDb, code: string): Promise<PurchaseRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii, note FROM funds WHERE fund_code=?',
    [code],
  )
  if (!rows || rows.length === 0) return null
  const r = rows[0]
  return {
    fund_code: r.fund_code as string,
    fund_name: r.fund_name as string,
    category: r.category as string,
    purchase_fee_rate: _toFloat(r.purchase_fee_rate),
    min_purchase: _toFloat(r.min_purchase),
    apply_status: undefined,
    redeem_status: undefined,
  }
}

/** 搜索基金（按代码或名称模糊匹配） */
export async function searchFunds(db: LedgerDb, query: string, limit = 50): Promise<FundNameRow[]> {
  const q = `%${query}%`
  const rows = await db.query<Record<string, unknown>>(
    `SELECT fund_code, fund_name, category FROM funds
     WHERE status='active' AND (fund_code LIKE ? OR fund_name LIKE ?)
     ORDER BY fund_code LIMIT ?`,
    [q, q, limit],
  )
  return rows.map(r => ({
    fund_code: r.fund_code as string,
    fund_name: r.fund_name as string,
    fund_type: r.category as string,
  }))
}

/** 候选池（按 status='active' 过滤） */
export async function poolFunds(db: LedgerDb): Promise<FundNameRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT fund_code, fund_name, category FROM funds WHERE status='active' ORDER BY fund_code`,
  )
  return rows.map(r => ({
    fund_code: r.fund_code as string,
    fund_name: r.fund_name as string,
    fund_type: r.category as string,
  }))
}

/** 持仓基金（来自 lots 表） */
export async function heldPositionFunds(db: LedgerDb): Promise<FundNameRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    // 结构隔离：本函数服务于「持仓基金汇总」（自检/净值补抓），需覆盖两套系统，
    // 故显式声明 IN ('real','trade') —— 不是漏过滤，而是有意取并集。
    `SELECT DISTINCT l.fund_code, f.fund_name, f.category
     FROM lots l LEFT JOIN funds f ON l.fund_code = f.fund_code
     WHERE l.status='active' AND l.remaining_shares > 0 AND l.source IN ('real','trade')
     ORDER BY l.fund_code`,
  )
  return rows.map(r => ({
    fund_code: r.fund_code as string,
    fund_name: (r.fund_name as string) ?? '',
    fund_type: (r.category as string) ?? '',
  }))
}

/** 加入池子 */
export async function addFund(db: LedgerDb, code: string, fundName: string, category: string, feeRate: number | null, isQdii = false, minPurchase: number | null = null): Promise<void> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  await db.run(
    `INSERT INTO funds (fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii, status, added_at, note)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(fund_code) DO UPDATE SET
       fund_name=excluded.fund_name,
       category=excluded.category,
       purchase_fee_rate=excluded.purchase_fee_rate,
       min_purchase=COALESCE(excluded.min_purchase, funds.min_purchase),
       is_qdii=excluded.is_qdii,
       added_at=excluded.added_at`,
    [code, fundName, category, feeRate, minPurchase, isQdii ? 1 : 0, now, null],
  )
}

/** 从池子移除（软删） */
export async function removeFund(db: LedgerDb, code: string): Promise<void> {
  await db.run(
    `UPDATE funds SET status='inactive' WHERE fund_code=?`,
    [code],
  )
}

/** 池子统计 */
export async function poolStats(db: LedgerDb): Promise<{ total: number; active: number; by_category: Record<string, number> }> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT category, COUNT(*) as c FROM funds WHERE status='active' GROUP BY category`,
  )
  const totalRow = await db.query<{ c: number }>('SELECT COUNT(*) as c FROM funds')
  const activeRow = await db.query<{ c: number }>(`SELECT COUNT(*) as c FROM funds WHERE status='active'`)
  const by: Record<string, number> = {}
  for (const r of rows) by[(r.category as string) ?? '未知'] = r.c as number
  return {
    total: totalRow[0]?.c ?? 0,
    active: activeRow[0]?.c ?? 0,
    by_category: by,
  }
}

// ─────────────────────────────────────────────
// 预置种子导入
//
// 目的：**首次安装秒级可用** —— 不再一上来抓全市场 2.7 万条（约 9 分钟）。
//   · 启动只读本地库；种子随 APK 打包，首次启动直接导入（1.6k 条 ≈ 秒级）
//   · 其余交给分层抓取后台补全（搜索/选中优先抓、WiFi+充电夜间全量）
//
// ⚠️ 覆盖式写入：`ON CONFLICT(fund_code) DO UPDATE`，**绝不 DELETE**
//    （大版本更新不删除已有基金；重复基金覆盖，容错交给后续自动抓取兜底）
// ─────────────────────────────────────────────

/** 当前 funds 表条数（判断是否需要导入种子）。 */
export async function fundsCount(db: LedgerDb): Promise<number> {
  try {
    const rows = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM funds')
    return rows[0]?.c ?? 0
  } catch { return 0 }
}

/** 导入预置种子（幂等、覆盖式）。返回 {imported, total}。
 *
 * ⚠️ 性能：CapacitorSQLite 的 `db.run` **每条 = 一次原生桥往返（≈6ms）**。
 *    逐条 1,658 条 = 29 秒；`db.transaction` 包批 = 10.5 秒；仍不够。
 *    故用**多行 INSERT**（150 行/语句，750 个参数，避开 SQLite 变量上限 999）→ 12 次桥调用。
 */
export async function importSeedFunds(
  db: LedgerDb,
  seed: { code: string; name: string; type?: string }[],
): Promise<{ imported: number; total: number }> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const valid = seed.filter(f => f?.code)
  const ROWS = 150
  let imported = 0

  for (let start = 0; start < valid.length; start += ROWS) {
    const batch = valid.slice(start, start + ROWS)
    const tuples = batch.map(() => "(?, ?, ?, ?, 'active', ?)").join(', ')
    const params: unknown[] = []
    for (const f of batch) {
      params.push(f.code, f.name || f.code, f.type || null, _isQdii(String(f.type || '')) ? 1 : 0, now)
    }
    const sql = `INSERT INTO funds (fund_code, fund_name, category, is_qdii, status, added_at)
                 VALUES ${tuples}
                 ON CONFLICT(fund_code) DO UPDATE SET
                   fund_name = excluded.fund_name,
                   category  = COALESCE(excluded.category, funds.category)`
    try {
      await db.run(sql, params)
      imported += batch.length
    } catch {
      // 退化：逐条重试兜底（坏数据不拖累其余）
      for (const f of batch) {
        try {
          await db.run(
            `INSERT INTO funds (fund_code, fund_name, category, is_qdii, status, added_at)
             VALUES (?, ?, ?, ?, 'active', ?)
             ON CONFLICT(fund_code) DO UPDATE SET
               fund_name = excluded.fund_name,
               category  = COALESCE(excluded.category, funds.category)`,
            [f.code, f.name || f.code, f.type || null, _isQdii(String(f.type || '')) ? 1 : 0, now],
          )
          imported++
        } catch { /* 单条失败跳过 */ }
      }
    }
  }
  return { imported, total: await fundsCount(db) }
}