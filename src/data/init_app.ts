// ─────────────────────────────────────────────
// init_app.ts · App 启动初始化
//
// 启动序列（4 步，异步不阻塞 UI）：
//   1) 打开/建库（@capacitor-community/sqlite）
//   2) 建表（不存在才建；详见 sqlite_schema.ts）
//   3) 注入真实 fetcher（HTTP；详见 sqlite_fetcher.ts）
//   4) 触发一次抓取（基金列表 + 净值）
//
// 数据缺失兜底：
//   - 拿不到 → 返回空，不造假
//   - 启动失败 → 仍然能进 App，只是数据为空
// ─────────────────────────────────────────────

import type { LedgerDb } from '../core/budget.ts'
import {
  MemoryBudgetDb, setLedgerDb, setOrderDb,
} from '../core/budget.ts'
import { setOrderDb as setOrdersDb } from '../core/orders.ts'
import {
  setStatusFetcher, fetchAndSave, type StatusSnapshot,
} from '../core/status.ts'
import {
  setFundPoolFetcher, getNameDf, getPurchaseDf, refreshMarketData,
  getPoolProgressLog, clearPoolProgressLog,
  importSeedFunds, fundsCount,
} from '../core/fund_pool.ts'
import { getSeedFunds, SEED_COUNT } from './seed_funds.ts'
import {
  setHttpDriver, getHttpDriver,
  fetchFundNameList, fetchFundPurchaseList, fetchFundNavList,
  fetchFundStatusRemote,
  fetchIndustryAllocation, fetchFundTopHoldings,
  getFetchErrors, pushFetchError,
  type HttpDriver,
} from './sqlite_fetcher.ts'
import { setAnalysisFetchers, type SectorFlowRow } from '../core/analysis.ts'
import { setRssFetcher } from '../core/rss_news.ts'
import { setLlmHttp } from '../core/llm_client.ts'
import { setIsInitializing } from '../react/lib/autoRefresh.js'

// 净值抓取进度日志（诊断"0 只"的关键）
const _navProgressLog: Array<{ ts: string; phase: string; msg: string }> = []
function _navLog(phase: string, msg: string): void {
  const entry = { ts: new Date().toISOString(), phase, msg }
  _navProgressLog.push(entry)
  if (_navProgressLog.length > 30) _navProgressLog.shift()
  console.log(`[nav][${phase}]`, msg)
}
export function getNavProgressLog(): Array<{ ts: string; phase: string; msg: string }> {
  return [..._navProgressLog]
}
export function clearNavProgressLog(): void { _navProgressLog.length = 0 }

// ─── 类型 ────────────────────────────────────────────

export interface InitOptions {
  /** 已开好的 SQLite db（Capacitor 真机环境用）；不传则用内存 mock */
  db?: LedgerDb
  /** 已实例化的 HTTP 驱动（真机环境 = CapacitorHttp）；不传则不发请求 */
  httpDriver?: HttpDriver
  /** 调试日志函数 */
  log?: (msg: string) => void
  /** 启动时是否触发一次抓取（默认 true） */
  fetchOnStart?: boolean
  /** 启动时抓取的基金代码列表（默认空：用 fetchFundNameList 拉全市场） */
  initialFundCodes?: string[]
  /** 进度回调：每完成一步就调用，用于 UI 显示「已获取 N 只」 */
  onProgress?: (nameCount: number, navCount: number) => void
}

export interface InitResult {
  ok: boolean
  db: LedgerDb
  /** 抓到几条基金 */
  nameCount: number
  /** 抓到几条申购信息 */
  purchaseCount: number
  /** 抓到几只基金的最新净值 */
  navCount: number
  /** 整体耗时（ms） */
  durationMs: number
  /** 抓取失败的步骤（空数组 = 全部成功） */
  errors: string[]
  /** 真机 SQLite 库各表行数自检；内存 mock 为 undefined */
  dbStats?: Record<string, number>
}

// ─── 全局 AbortController ────────────────────────────────
let _abortController: AbortController | null = null

/** 返回当前 init 的 AbortSignal；下次 init 前由调用方 releaseAbortController */
export function getAbortSignal(): AbortSignal {
  if (!_abortController) _abortController = new AbortController()
  return _abortController.signal
}

/** 结束本次 init，释放 controller */
export function releaseAbortController(): void {
  _abortController?.abort()
  _abortController = null
}

// ─── 主入口 ──────────────────────────────────────────
//  init 秒级完成。池刷新 + 净值抓取全部 fire-and-forget，不阻塞 UI。
// onProgress 仅用于通知"池抓取完成了多少只"，不等待净值完成。
export async function initApp(opts: InitOptions = {}): Promise<InitResult> {
  const t0 = performance.now()
  const log = opts.log ?? (msg => console.log(msg))
  const onProgress = opts.onProgress ?? (() => {})
  const errors: string[] = []

  releaseAbortController()
  _abortController = new AbortController()

  // ── 1) 打开/建库 ──────────────────────────────────
  const db: LedgerDb = opts.db ?? new MemoryBudgetDb()
  setLedgerDb(db)
  setOrderDb(db)             // budget.ts 内部 orderDb
  setOrdersDb(db as LedgerDb as unknown as Parameters<typeof setOrdersDb>[0])  // orders.ts 内部 _db
  log('[init] step 1: db 就绪')

  // ── 2) 建表（不存在才建） ────────────────────────
  log('[init] step 2: 表结构就绪（建表由 sqlite_adapter 完成）')

  // ── 3) 注入 fetcher ────────────────────────────
  setHttpDriver(opts.httpDriver ?? getHttpDriver())   // 保留 useRealDriver() 已注入的 _driver
  const _hasDriver = opts.httpDriver ?? getHttpDriver()
  setStatusFetcher(_hasDriver
    ? async (code: string, _t: number) => fetchFundStatusRemote(code)
    : null,
  )
  setFundPoolFetcher(_hasDriver
    ? async (endpoint: string, _t: number) => {
        if (endpoint === 'fund_name_em') return await fetchFundNameList(15)         // 15s 超时
        if (endpoint === 'fund_purchase_info_em') return await fetchFundPurchaseList(15)
        return []
      }
    : null,
  )
  // 注入穿透分析 fetcher（行业配置 + 重仓股，供 analysis.ts 调用）
  setAnalysisFetchers({
    penetration: _hasDriver
      ? async (code: string) => {
          const rows = await fetchFundTopHoldings(code, 30)
          return rows.map(r => ({
            fund_code: r.fund_code,
            stock_code: r.stock_code,
            stock_name: r.stock_name,
            weight_pct: r.weight_pct,
            report_date: r.report_date,
            fetched_at: r.fetched_at,
          }))
        }
      : null,
    // 板块行情。
    // 东财 push2 / push2delay 在部分网络环境连接被服务端直接断掉
    //   （原生 HTTP 报 unexpected end of stream），板块信号与大盘指数会双双"数据缺失"。
    // 主源改为**新浪行业板块** money.finance.sina.com.cn/q/view/newFLJK.php?param=industry
    //   （纯文本、无反爬、设备端可达）；该源无资金流字段 → net_inflow 置 0，
    //   analysis.ts 自动退化为按涨跌幅排序，UI 另展示成交额，**不编造资金流**。
    // 备源保留东财 push2（换网络环境仍可能通）。
    sector: _hasDriver
      ? async () => {
          const today = new Date().toISOString().slice(0, 10)
          // ── 主源：新浪行业板块 ──
          try {
            const res = await (_hasDriver as HttpDriver).get(
              'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=industry',
              {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
                'Referer': 'https://finance.sina.com.cn/',
              },
              15000,
            )
            if (res.status === 200) {
              const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
              const rows = _parseSinaSectorRows(text, today)
              if (rows.length > 0) return rows
            }
          } catch { /* 落备源 */ }
          // ── 备源：东财 push2 ──
          const path = '/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f12,f14,f2,f3,f62,f184'
          const headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
            'Referer': 'https://quote.eastmoney.com/',
          }
          const urls = [
            `https://push2.eastmoney.com${path}`,
            `https://push2delay.eastmoney.com${path}`,
          ]
          let lastErr: unknown = null
          for (const url of urls) {
            try {
              const res = await (_hasDriver as HttpDriver).get(url, headers, 15000)
              if (res.status !== 200) { lastErr = new Error(`HTTP ${res.status} @ ${new URL(url).host}`); continue }
              const obj = res.data as { data?: { diff?: Array<Record<string, unknown>> } } | null
              const diff = obj?.data?.diff ?? []
              if (!diff.length) { lastErr = new Error(`空数据 @ ${new URL(url).host}`); continue }
              const rows = diff
                .map(d => ({
                  board_name: String(d.f14 ?? ''),
                  change_pct: Number(d.f3 ?? 0),
                  net_inflow: Number(d.f62 ?? 0),
                  fetch_date: today,
                }))
                .filter(r => r.board_name)
              if (rows.length > 0) return rows
              lastErr = new Error(`解析为空 @ ${new URL(url).host}`)
            } catch (e) {
              lastErr = e
            }
          }
          throw lastErr instanceof Error ? lastErr : new Error('板块两源均失败')
        }
      : null,
  })

  // RSS 抓取器：市场资讯（财联社 / 华尔街见闻 / 金十数据）。
  // 这三个是纯 HTTP 源、**无反爬**，所以能在端上直接抓（基金公告那类带 JS 反爬的则不能）。
  setRssFetcher(_hasDriver
    ? async (url: string, timeoutSec: number) => {
        const res = await (_hasDriver as HttpDriver).get(url, {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, application/json, */*',
        }, timeoutSec * 1000)
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
        return typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      }
    : null,
  )
  log(`[init] step 3: fetcher 注入（${(_hasDriver ? '真实 HTTP' : 'mock/不发请求')}）`)

  // ── 3.5) 预置种子导入（种子策略：首次安装秒级可用，不再一上来抓全市场）──
  // 只在本地库「几乎为空」时导入（< 100 条）；覆盖式写入，绝不 DELETE。
  try {
    const before = await fundsCount(db)
    if (before < 100) {
      const t0 = Date.now()
      log(`[init] step 3.5: 导入预置种子（${SEED_COUNT} 只，本地库现有 ${before} 条）…`)
      const r = await importSeedFunds(db, getSeedFunds())
      log(`[init] step 3.5 完成：导入 ${r.imported} 只，funds 表共 ${r.total} 条（${Date.now() - t0}ms）`)
    } else {
      log(`[init] step 3.5: 跳过（本地库已有 ${before} 条）`)
    }
  } catch (e) {
    // 种子导入失败不影响启动：后续分层抓取仍会补全
    log(`[init] step 3.5 失败（不影响启动）：${(e as Error)?.message || e}`)
  }

  // AI 调用通道：真机走 NativeHttp.post（OpenAI 兼容 /chat/completions，绕过 WebView CORS/DNS）；
  // Web/浏览器环境回退到 fetch。密钥等配置由 core/llm_client 从 app_settings 读取。
  setLlmHttp(async (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => {
    const nh = (globalThis as unknown as { NativeHttp?: { post?: (o: unknown) => Promise<{ result?: string }> } }).NativeHttp
    if (nh && typeof nh.post === 'function') {
      const res = await nh.post({ url, timeout: timeoutMs, headers, body })
      return { status: 200, data: res?.result ?? '' }
    }
    const resp = await fetch(url, { method: 'POST', headers, body })
    const text = await resp.text()
    return { status: resp.status, data: text }
  })

  // ── 4) 触发池刷新 + 首批净值：全部 fire-and-forget ────
  //  init 不再等待网络请求。池刷新完成后通过 onProgress 通知 UI；
  //      净值抓取在后台异步进行，不影响 App 启动。
  if (opts.fetchOnStart !== false) {
    ;(async () => {
      setIsInitializing(true)
      try {
        log('[init] step 4a: 抓取全市场基金列表 …（后台）')
        const nameDf = await getNameDf(false)   // 用本地缓存（fund_pool.ts CACHE_TTL_MS = 24h）
        const nameCount = nameDf.length
        log(`[init] step 4a 完成：${nameCount} 只基金${nameDf.length > 0 ? '（命中缓存）' : ''}`)
        onProgress(nameCount, 0)  // navCount=0（还没抓）

        log('[init] step 4b: 抓取申购/费率信息 …（后台）')
        const purchaseDf = await getPurchaseDf(false)
        const purchaseCount = purchaseDf.length
        log(`[init] step 4b 完成：${purchaseCount} 条申购信息`)

        log('[init] step 4c: 落库 funds 表 …（后台）')
        const r = await refreshMarketData(db, false)
        log(`[init] step 4c 完成：落库 ${r.inserted} 条（name=${r.name_count}, purchase=${r.purchase_count}）`)

        // 首批净值的抓取目标 = **持仓优先**：
        //   **有持仓就抓持仓**（lots 里 status='active'，哪怕只有 1 只），
        //   没有持仓时才用 initialFundCodes / 前 5 只预热。
        //   （若只抓市场顺序前 5 只，与持仓无关 → 持仓基金的详情页/净值曲线/分析页全空。）
        let heldCodes: string[] = []
        try {
          const held = await db.query<{ fund_code: string }>(
            // 口径**必须与持仓列表一致**（`react/lib/dataAdapter.js:316`）：
            //   WHERE status='active' AND source IN ('real','trade')
            //
            // ⚠️ 刻意**不加 `remaining_shares > 0`**：
            //   截图 OCR 导入的真实持仓**只有金额、份额为 0**（支付宝/天天基金列表页
            //   只显示持有金额，份额要点进详情才有）—— 加了这个条件会把真实持仓全过滤掉，
            //   于是净值永远抓不到，详情页继续空着。
            "SELECT DISTINCT fund_code FROM lots "
            + "WHERE status='active' AND source IN ('real','trade')"
          )
          heldCodes = held.map((r) => r.fund_code).filter(Boolean)
        } catch {
          // lots 表可能尚未建（首次装）—— 忽略，走兜底
        }
        // 关注（is_favorite=1）同样要抓净值：与持仓合并去重（同一只基金只抓一次，
        // 落同一行 nav_daily / funds —— 真实持仓 / 沙盒交易 / 关注共用一份真实行情）。
        try {
          const fav = await db.query<{ fund_code: string }>(
            "SELECT fund_code FROM funds WHERE is_favorite = 1"
          )
          const favCodes = fav.map((r) => r.fund_code).filter(Boolean)
          heldCodes = Array.from(new Set([...heldCodes, ...favCodes]))
        } catch {
          // funds 表可能尚未建（首次装）—— 忽略，走兜底
        }
        const codes = heldCodes.length > 0
          ? heldCodes
          : (opts.initialFundCodes ?? nameDf.slice(0, 5).map((r) => r.fund_code))
        console.log('[init] step 4d diag: nameDf.length=', nameDf.length,
                    'heldCodes=', heldCodes.length, 'codes=', codes.slice(0, 5).join(','))
        log(`[init] step 4d: 抓取 ${codes.length} 只基金净值 …（后台）`)
        _navLog('start', `codes=${codes.length} codes_list=${codes.slice(0, 5).join(',')}`)
        let parsedTotal = 0
        let dbFailCount = 0
        let navCount = 0
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i]
          try {
            const navs = await fetchFundNavList(code, 15)
            parsedTotal += navs.length
            _navLog('fetch', `${i + 1}/${codes.length} ${code} parsed=${navs.length}`)
            let insertOk = 0
            // 性能：多行 INSERT（150 行/语句，600 参数 < 999 上限）——
            // 逐条 db.run 每条 = 一次原生桥往返，6000 条历史 ≈ 36~100 秒/只
            const ROWS = 150
            for (let s = 0; s < navs.length; s += ROWS) {
              const batch = navs.slice(s, s + ROWS)
              const tuples = batch.map(() => '(?, ?, ?, ?)').join(', ')
              const params: unknown[] = []
              for (const nv of batch) params.push(nv.fund_code, nv.nav_date, nv.nav, nv.nav_acc)
              try {
                await db.run(
                  `INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES ${tuples}`,
                  params,
                )
                insertOk += batch.length
              } catch (e) {
                // 多行失败 → 逐条重试兜底（坏数据不拖累其余）
                for (const nv of batch) {
                  try {
                    await db.run(
                      `INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`,
                      [nv.fund_code, nv.nav_date, nv.nav, nv.nav_acc],
                    )
                    insertOk++
                  } catch (e2) {
                    dbFailCount++
                    pushFetchError(`nav_daily INSERT failed ${code} ${nv.nav_date}: ${(e2 as Error).message}`)
                  }
                }
              }
            }
            navCount += insertOk
            onProgress(nameCount, navCount)  // 每抓完一只通知进度
          } catch (e) {
            log(`[init] step 4d 失败 ${code}: ${(e as Error).message}`)
            _navLog('fail', `${i + 1}/${codes.length} ${code} err=${(e as Error).message}`)
          }
        }
        log(`[init] step 4d 完成：共 ${navCount} 条净值落库（解析 ${parsedTotal} 条，db 失败 ${dbFailCount} 条）`)
        _navLog('done', `navCount=${navCount} parsedTotal=${parsedTotal} dbFail=${dbFailCount}`)
      } catch (e) {
        const errMsg = `(e as Error).message`
        log(`[init] step 4 FAILED: ${errMsg}`)
        errors.push(`抓取失败：${errMsg}`)
      } finally {
        setIsInitializing(false)
      }
    })()
  }

  // ── 5) 自检真库行数（仅真机 SQLite 走 query） ──
  const fetcherErrors = getFetchErrors()
  const allErrors = [...errors, ...fetcherErrors]
  const isRealDb = '_sqliteBackend' in (db as object)
  let dbStats: Record<string, number> | undefined
  if (isRealDb) {
    try {
      const tables = ['funds', 'nav_daily', 'orders', 'lots', 'cash_ledger', 'monthly_budget', 'fund_holdings', 'fund_code_correction_log']
      dbStats = {}
      for (const t of tables) {
        try {
          const r = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)
          dbStats[t] = Number(r[0]?.n ?? 0)
        } catch { dbStats[t] = -1 }
      }
      log(`[init] step 5: 真库自检 ${JSON.stringify(dbStats)}`)
    } catch (e) {
      errors.push(`真库自检失败: ${(e as Error).message}`)
    }
  }
  const result: InitResult = {
    ok: allErrors.length === 0,
    db,
    nameCount: 0,
    purchaseCount: 0,
    navCount: 0,
    durationMs: Math.round(performance.now() - t0),
    errors: allErrors,
    dbStats,
  }
  log(`[init] 完成：✓ 秒级返回（后台抓取进行中）durationMs=${result.durationMs} dbStats=${JSON.stringify(dbStats)}`)
  return result
}

// ─── 全量 schema（一次执行） ─────────────────────────

const SCHEMA_ALL_IN_ONE = `
CREATE TABLE IF NOT EXISTS funds (
  fund_code TEXT PRIMARY KEY,
  fund_name TEXT NOT NULL,
  category TEXT,
  purchase_fee_rate REAL,
  min_purchase REAL DEFAULT 1.0,
  is_qdii INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  added_at TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS nav_daily (
  fund_code TEXT NOT NULL,
  nav_date TEXT NOT NULL,
  nav REAL NOT NULL,
  acc_nav REAL,
  PRIMARY KEY (fund_code, nav_date)
);
CREATE TABLE IF NOT EXISTS fund_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code TEXT NOT NULL,
  status_date TEXT NOT NULL,
  purchase_status TEXT NOT NULL,
  redeem_status TEXT NOT NULL,
  purchase_limit REAL,
  limit_unknown INTEGER DEFAULT 0,
  raw_purchase TEXT,
  raw_redeem TEXT,
  note TEXT,
  source TEXT DEFAULT 'em_daily',
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  fund_code TEXT NOT NULL,
  amount REAL NOT NULL,
  nav_date TEXT,
  status TEXT NOT NULL,
  decision_source TEXT,
  reason TEXT,
  fee_rate REAL,
  fee_purchase REAL,
  net_amount REAL,
  confirm_date TEXT,
  filled_nav REAL,
  filled_shares REAL,
  filled_net_amount REAL,
  expected_arrival_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lots (
  lot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code TEXT NOT NULL,
  buy_order_id TEXT NOT NULL,
  buy_date TEXT NOT NULL,
  confirm_date TEXT NOT NULL,
  shares REAL NOT NULL,
  remaining_shares REAL NOT NULL,
  cost_amount REAL NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  memo TEXT NOT NULL,
  action TEXT NOT NULL,
  fund_code TEXT,
  order_id TEXT,
  shares REAL DEFAULT 0,
  cost_amount REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code TEXT NOT NULL,
  used_date TEXT NOT NULL,
  used_amount REAL NOT NULL,
  PRIMARY KEY (fund_code, used_date)
);
CREATE TABLE IF NOT EXISTS fund_code_correction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_code TEXT NOT NULL,
  fixed_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  logged_at TEXT NOT NULL
);
`

// ─── 调试输出 ─────────────────────

/** 打印「抓到几条 + 前几条基金名/净值」便于真机日志观察 */
export async function debugDump(db: LedgerDb, logger: (msg: string) => void = console.log): Promise<void> {
  try {
    const funds = await db.query<{ fund_code: string; fund_name: string; category: string; min_purchase: number | null }>(
      `SELECT fund_code, fund_name, category, min_purchase FROM funds
       WHERE status='active' ORDER BY added_at DESC LIMIT 5`,
    )
    logger(`[debug] funds 前 5 条：`)
    for (const f of funds) {
      logger(`  · ${f.fund_code}  ${f.fund_name}  [${f.category}]  起购=${f.min_purchase ?? '未知'}`)
    }
    const navs = await db.query<{ fund_code: string; nav_date: string; nav: number }>(
      `SELECT fund_code, nav_date, nav FROM nav_daily ORDER BY nav_date DESC LIMIT 10`,
    )
    logger(`[debug] nav_daily 前 10 条：`)
    for (const n of navs) {
      logger(`  · ${n.fund_code}  ${n.nav_date}  ${n.nav}`)
    }
  } catch (e) {
    logger(`[debug] dump 失败：${(e as Error).message}`)
  }
}

/** 测一笔订单：验证成交份额口径（成交份额 = nav ÷ amount）+ 起购线 + 限购 */
export async function debugOrderCheck(db: LedgerDb, logger: (msg: string) => void = console.log): Promise<void> {
  try {
    // 假设 110011 已落库
    const st = await fetchAndSave(db, '110011')
    if (st) {
      logger(`[debug] 110011 状态：purchase=${st.purchase_status} redeem=${st.redeem_status} from_cache=${st.from_cache}`)
      logger(`[debug] raw: 申购[${st.raw_purchase}] 赎回[${st.raw_redeem}]`)
    } else {
      logger(`[debug] 110011 无状态快照（fetchAndSave 返回 null）`)
    }
  } catch (e) {
    logger(`[debug] debugOrderCheck 失败：${(e as Error).message}`)
  }
}

// 仅用于类型导出（让调用方知道 HttpDriver 怎么注入）
export type { HttpDriver }

/**
 * 解析新浪行业板块文本：
 *   var S_Finance_bankuai_industry = {"hangye_ZA01":"hangye_ZA01,农业,16,9.828,0.348,3.679,772991490,5723859279,sh601118,10.017,6.370,0.580,海南橡胶", ...}
 * 字段（按逗号切）：[0]板块代码 [1]板块名 [2]公司家数 [3]均价 [4]涨跌额
 *                  [5]涨跌幅% [6]成交量(股) [7]成交额(元) [8..]领涨股信息
 * 该源**无资金流字段** → net_inflow 固定 0（宁缺毋编）；成交额另存 amount 供 UI 展示。
 */
function _parseSinaSectorRows(text: string, today: string): SectorFlowRow[] {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return []
  let obj: Record<string, string>
  try { obj = JSON.parse(text.slice(s, e + 1)) as Record<string, string> } catch { return [] }
  const out: SectorFlowRow[] = []
  for (const v of Object.values(obj)) {
    const f = String(v).split(',')
    if (f.length < 8) continue
    const name = (f[1] ?? '').trim()
    const pct = Number(f[5])
    const amount = Number(f[7])
    if (!name || !Number.isFinite(pct)) continue
    out.push({
      board_name: name,
      change_pct: pct,
      net_inflow: 0,
      amount: Number.isFinite(amount) ? amount : undefined,
      fetch_date: today,
    })
  }
  return out
}