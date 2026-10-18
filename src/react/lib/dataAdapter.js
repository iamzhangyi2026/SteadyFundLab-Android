// ─────────────────────────────────────────────
// dataAdapter.js · React ↔ client-side data layer 桥接
//
// 职责：把 src/data/init_app.ts + src/core/*.ts 的 TypeScript 接口
//        暴露成 React 友好的纯 JS Promise API。
//
// 设计原则：
//   - 所有操作返回 Promise<{ok, data, error?}>
//   - 数据为空返回 [] 而不是抛错（E3：不造假数据）
//   - 业务错误（如起购）通过 error 字段返回，前端用 Toast/红字呈现
//   - 只在 initApp 之后才能调业务方法；未初始化会返回 ok=false + error
// ─────────────────────────────────────────────

import { initApp } from '../../data/init_app.ts'
import {
  getBudget, appendCapital, setLedgerDb, setOrderDb as setBudgetOrderDb,
} from '../../core/budget.ts'
import {
  setOrderDb, setNavProvider,
  submitOrder, confirmOrder, cancelOrder, checkBeforeSubmit,
} from '../../core/orders.ts'
import { setStatusFetcher } from '../../core/status.ts'
import {
  setFundPoolFetcher, refreshMarketData,
  getPoolProgressLog, clearPoolProgressLog,
} from '../../core/fund_pool.ts'
import {
  setHttpDriver,
  pushFetchError,
  getStructuredErrors,
  fetchFundNameList, fetchFundPurchaseList, fetchFundStatusRemote,
  fetchIndustryAllocation, fetchFundTopHoldings, fetchFundNavList,
} from '../../data/sqlite_fetcher.ts'
import {
  getNavProgressLog, clearNavProgressLog,
} from '../../data/init_app.ts'
import {
  checkTradable,
  analyzeExposure,
  detectStyleDrift,
  calcOverlap,
  saveHoldings,
} from '../../core/holdings.ts'
import { riskReport } from '../../core/risk.ts'
import {
  ALERT_KINDS,
  addAlert as _addAlert,
  listAlerts as _listAlerts,
  deleteAlert as _deleteAlert,
  evaluateAlerts as _evaluateAlerts,
  listHistory as _listHistory,
} from '../../core/alerts.ts'
import {
  rebalanceReport as _rebalanceReport,
  loadTargets as _loadTargets,
  saveTargets as _saveTargets,
  listRebalanceHistory as _listRebalanceHistory,
  evaluateRebalance as _evaluateRebalance,
} from '../../core/rebalance.ts'
import {
  goalReport as _goalReport,
  upsertGoal as _upsertGoal,
  deleteGoal as _deleteGoal,
} from '../../core/goal.ts'
import { openNativeDb, formatDbStats, selectTopN, getDbStats } from '../../data/sqlite_adapter.ts'

let _db = null
let _initialized = false
let _navProvider = null
let _initResult = null

// ─── HTTP 驱动（CapacitorHttp 绕过 WebView CORS 限制） ─────
//
// 自检 + 注入逻辑放在 sqlite_fetcher.ts 的 useRealDriver()：
//   - typeof CapacitorHttp / typeof .get 会打日志
//   - 若不可用会 pushFetchError 进 _errors
// dataAdapter.js 只负责调它
import { useRealDriver as _useRealDriver } from '../../data/sqlite_fetcher.ts'

function buildHttpDriver() {
  // 调用 sqlite_fetcher.useRealDriver() 做注入（用 window.fetch，绕过 CapacitorHttp DNS 问题）
  _useRealDriver()
  return null   // setHttpDriver(null) 跳过；_driver 保留 useRealDriver 注入的那个
}

// ─── 启动初始化 ─────────────────────────────────────

/**
 * 启动数据层。返回 initResult（{nameCount, purchaseCount, navCount, errors}）。
 * @param {object} opts
 * @param {(msg)=>void} opts.log  日志回调（默认 console.log）
 * @param {boolean}     opts.fetchOnStart  是否立即抓取（默认 true）
 */
let _initPromise = null

export async function initDataLayer(opts = {}) {
  // 并发守卫：React StrictMode 会双调用 effect，而 `_initialized` 在 await 之后才置位，
  // 于是两次调用会各开一次 DB 连接 → 其中一个 openNativeDb 报 "already exists" 后
  // 退回内存 mock DB → 那次 init 的所有写入（含净值）静默丢失。此处串行化，只跑一次。
  if (_initialized) return _initResult
  if (!_initPromise) _initPromise = _initDataLayerOnce(opts)
  return _initPromise
}

async function _initDataLayerOnce(opts = {}) {
  if (_initialized) return _initResult
  const log = opts.log ?? (msg => console.log(msg))
  const driver = buildHttpDriver()
  if (driver) setHttpDriver(driver)   // null 跳过（useRealDriver 已注入）
  setStatusFetcher(async (code) => {
    // status.ts 调用方式：(fund_code, _t) => Promise<StatusSnapshot>
    const { fetchFundStatusRemote } = await import('../../data/sqlite_fetcher.ts')
    return await fetchFundStatusRemote(code)
  })
  setFundPoolFetcher(async (endpoint) => {
    if (endpoint === 'fund_name_em') return await fetchFundNameList()
    if (endpoint === 'fund_purchase_info_em') return await fetchFundPurchaseList()
    return []
  })

  // 真机环境：先打开 SQLite 真库，再传给 initApp（避免走内存 mock）
  console.log('[selfcheck] platform =', Capacitor.getPlatform(),
              'isNative =', Capacitor.isNativePlatform())
  let nativeDb = null
  try {
    nativeDb = await openNativeDb()
  } catch (e) {
    // 真机 SQLite 打开/建表失败：记入内部缓冲，界面不提示
    console.error('[init] openNativeDb 失败:', e.message)
    pushFetchError(`openNativeDb: ${e.message}`)
  }
  console.log('[selfcheck] nativeDb =', nativeDb ? 'OK (真机 SQLite)' : 'null (用内存兜底)')

  _initResult = await initApp({
    db: nativeDb ?? undefined,   // null 时 init_app 内部用 MemoryBudgetDb
    httpDriver: driver,
    log,
    fetchOnStart: opts.fetchOnStart !== false,
    onProgress: opts.onProgress ?? (() => {}),
  })
  _db = _initResult.db
  _initialized = true

  // 真库 stats 显示到 logcat（落库条数可直接在日志查看）
  if (_initResult.dbStats) {
    console.log('[init] dbStats =', JSON.stringify(_initResult.dbStats))
  }

  // 注册 nav provider：优先读 nav_daily 表，回退到 0（导致 confirm 抛错，符合预期）
  _navProvider = {
    async getNav(fundCode, asOf) {
      const rows = await _db.query(
        `SELECT nav FROM nav_daily WHERE fund_code=? AND nav_date <= ?
         ORDER BY nav_date DESC LIMIT 1`,
        [fundCode, asOf ?? new Date().toISOString().slice(0, 10)],
      )
      return rows[0]?.nav
    },
  }
  setNavProvider(_navProvider)

  return _initResult
}

export function isInitialized() { return _initialized }
export function getDb() { return _db }
export function getInitResult() { return _initResult }

// 「导出诊断」页面：返回各表行数 + 每表前 N 行
export async function exportDiagnostics(topN = 10) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: null }
  try {
    const stats = await getDbStats(_db)
    const sample = {}
    for (const t of Object.keys(stats)) {
      if (stats[t] > 0) sample[t] = await selectTopN(_db, t, topN)
      else sample[t] = []
    }
    // 最近一次 init 的关键结果
    const lastInit = _initResult ? {
      nameCount: _initResult.nameCount,
      purchaseCount: _initResult.purchaseCount,
      navCount: _initResult.navCount,
      durationMs: _initResult.durationMs,
      errors: _initResult.errors,
    } : null
    return {
      ok: true,
      data: {
        stats,
        sample,
        timestamp: new Date().toISOString(),
        recentErrors: getStructuredErrors(),    // 最近 N 条结构化错误
        poolProgress: getPoolProgressLog(),     // refreshMarketData 各阶段日志
        navProgress: getNavProgressLog(),       // 净值抓取各阶段日志
        lastInit,
      },
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export { formatDbStats, getDbStats }

// ─── 预算快照 ────────────────────────────────────────

export async function fetchBudget() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: null }
  try {
    const data = await getBudget()
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 手动注资（仅用于测试 / 调试） */
export async function addCapital(amount, source = 'manual', memo = '') {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    await appendCapital(amount, source, memo)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 启动资金兜底（不注入任何默认本金）。
 * 装新包可用现金 = 0，本金由用户在资金卡自输（无上限）。
 * 此函数仅保留一项兜底职责：清理历史版本可能留下的重复 initial 流水（幂等）。
 * @returns {{ok:boolean, data?:object, created:false, error?:string}}
 */
let _ensureCapitalInFlight = null
export async function ensureInitialCapital() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: null }
  if (_ensureCapitalInFlight) return _ensureCapitalInFlight
  _ensureCapitalInFlight = (async () => {
    try {
      const cnt = await _db.query(`SELECT COUNT(*) AS n FROM cash_ledger`)
      const hasLedger = (cnt[0]?.n ?? 0) > 0
      if (hasLedger) {
        const dup = await _db.query(`SELECT COUNT(*) AS n FROM cash_ledger WHERE action='initial'`)
        const dupN = dup[0]?.n ?? 0
        if (dupN > 1) {
          await _db.run(
            `DELETE FROM cash_ledger WHERE action='initial'
             AND id NOT IN (SELECT MIN(id) FROM cash_ledger WHERE action='initial')`,
          )
          console.log(`[capital] 清理重复初始资金流水：initial ${dupN} 条 → 1 条`)
        }
      }
      const cur = await getBudget()
      return { ok: true, data: cur, created: false }
    } catch (e) {
      return { ok: false, error: e.message, data: null }
    } finally {
      _ensureCapitalInFlight = null
    }
  })()
  return _ensureCapitalInFlight
}

/** 一键清零重设（09 可逆性）：清余额/持仓/pending，保留流水历史（有入必有出） */
export async function resetBudgetLedger() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const { resetBudget } = await import('../../core/budget.ts')
    await resetBudget()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 在途资金（09 UI 显性化）：待确认买入（冻结）+ 赎回在途（未到账） */
export async function fetchInFlightCapital() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const rows = await _db.query(
      `SELECT type, COALESCE(SUM(amount),0) AS total FROM orders WHERE status='pending' GROUP BY type`,
    )
    const pendingBuy = Number(rows.find(r => r.type === 'buy')?.total ?? 0)
    const pendingSell = Number(rows.find(r => r.type === 'sell')?.total ?? 0)
    return { ok: true, data: { pending_buy: pendingBuy, pending_sell: pendingSell } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ─── 持仓 + 批次 ─────────────────────────────────────

/**
 * 返回聚合后的持仓（按 fund_code 分组）
 * 每条：{ fund_code, fund_name, category, min_purchase, purchase_status, purchase_limit,
 *         raw_purchase, total_shares, total_cost, current_nav, market_value, profit, profit_pct,
 *         lots: [{lot_id, confirm_date, shares, cost_amount, remaining_shares, status, holding_days}] }
 */
export async function fetchPositions() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const rows = await _db.query(`
      SELECT
        l.fund_code, l.lot_id, l.buy_order_id, l.buy_date, l.confirm_date,
        l.shares, l.remaining_shares, l.cost_amount, l.status, l.source,
        f.fund_name, f.category, f.purchase_fee_rate, f.min_purchase, f.is_qdii,
        f.purchase_fee_rate,
        (SELECT nav FROM nav_daily WHERE fund_code=l.fund_code ORDER BY nav_date DESC LIMIT 1) AS current_nav,
        (SELECT purchase_status FROM fund_status WHERE fund_code=l.fund_code ORDER BY status_date DESC LIMIT 1) AS purchase_status,
        (SELECT purchase_limit FROM fund_status WHERE fund_code=l.fund_code ORDER BY status_date DESC LIMIT 1) AS purchase_limit,
        (SELECT raw_purchase FROM fund_status WHERE fund_code=l.fund_code ORDER BY status_date DESC LIMIT 1) AS raw_purchase,
        (SELECT redeem_status FROM fund_status WHERE fund_code=l.fund_code ORDER BY status_date DESC LIMIT 1) AS redeem_status
      FROM lots l
      LEFT JOIN funds f ON f.fund_code = l.fund_code
      WHERE l.status = 'active' AND l.source IN ('real','trade')
      ORDER BY l.confirm_date DESC
    `)

    // 按 (fund_code + 来源) 聚合
    // ⚠️ 隔离：**不能只按 fund_code 聚合** —— 同一只基金若既有截图导入、
    //    又有交易买入，会被合并成一条（份额相加），两套账就分不清了。
    //    故按「基金 + 来源」分别成条：导入的进「真实持仓」，交易买的进「交易持仓」。
    // source 直接读 `lots.source` 列
    const groups = new Map()
    for (const r of rows) {
      const code = r.fund_code
      const source = r.source === 'real' ? 'real' : 'trade'
      const gkey = code + '|' + source
      if (!groups.has(gkey)) {
        groups.set(gkey, {
          fund_code: code,
          source,
          fund_name: r.fund_name,
          category: r.category,
          min_purchase: r.min_purchase,
          purchase_fee_rate: r.purchase_fee_rate,
          is_qdii: !!r.is_qdii,
          purchase_status: r.purchase_status,
          purchase_limit: r.purchase_limit,
          raw_purchase: r.raw_purchase,
          redeem_status: r.redeem_status,
          current_nav: r.current_nav,
          total_shares: 0,
          total_cost: 0,
          lots: [],
        })
      }
      const g = groups.get(gkey)
      g.total_shares += r.remaining_shares ?? 0
      g.total_cost += r.cost_amount ?? 0
      const confirmDate = r.confirm_date ? String(r.confirm_date).slice(0, 10) : null
      const holdingDays = confirmDate
        ? Math.max(0, Math.floor((Date.now() - new Date(confirmDate + 'T00:00:00').getTime()) / 86400000))
        : 0
      g.lots.push({
        lot_id: r.lot_id,
        buy_order_id: r.buy_order_id,
        buy_date: r.buy_date,
        confirm_date: confirmDate,
        shares: r.shares,
        remaining_shares: r.remaining_shares,
        cost_amount: r.cost_amount,
        status: r.status,
        holding_days: holdingDays,
      })
    }

    // 市值 + 浮盈（单位净值 nav，不用 acc_nav）
    // source 已在聚合时确定（'real' = 截图导入 / 'trade' = 交易买入），此处不再重算。
    const positions = [...groups.values()].map(g => {
      const mv = (g.current_nav && g.total_shares) ? g.current_nav * g.total_shares : null
      const profit = mv != null ? mv - g.total_cost : null
      const profit_pct = (profit != null && g.total_cost > 0) ? (profit / g.total_cost) * 100 : null
      return { ...g, market_value: mv, profit, profit_pct }
    })
    return { ok: true, data: positions }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

// ─── 基金池 ─────────────────────────────────────────

export async function fetchFundPool() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const rows = await _db.query(`
      SELECT fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii, status, added_at, note
      FROM funds
      WHERE status = 'active'
      ORDER BY added_at DESC NULLS LAST, fund_code
      LIMIT 200
    `)
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

// ─── 全量抓取条件检查 ──────────────────────────────────────
// import FULL_MARKET_CONFIG at bottom to avoid circular deps (TS→JS bridge)
let _cfg = null
/** 懒加载 FULL_MARKET_CONFIG（避免 JS/TS 循环依赖） */
export async function _loadCfg() {
  if (!_cfg) {
    const m = await import('../../core/config.ts')
    _cfg = m.FULL_MARKET_CONFIG
  }
  return _cfg
}

/** 是否处于夜间时段（local time）*/
export async function isNightWindow(cfg) {
  const h = new Date().getHours()
  // 跨午夜场景：nightStart=23, nightEnd=7 → 正常窗口 [23,24) ∪ [0,7)
  if (cfg.nightStartHour > cfg.nightEndHour) {
    return h >= cfg.nightStartHour || h < cfg.nightEndHour
  }
  return h >= cfg.nightStartHour && h < cfg.nightEndHour
}

/** pool_meta 中 last_refresh 日期是否等于今天（YYYY-MM-DD） */
export async function isTodayRefreshed(db, metaKey) {
  if (!db) return false
  try {
    const rows = await db.query(`SELECT value FROM pool_meta WHERE key=?`, [metaKey])
    const v = rows[0]?.value
    if (!v) return false
    const today = new Date().toISOString().slice(0, 10)
    return v.startsWith(today)
  } catch { return false }
}

/**
 * 分批落库：500 条/批 + 事务包裹 + 单批超时保护
 * 内部函数：refreshFundPool / autoRefresh 共用，直接操作 _db，不调 refreshMarketData
 * 批内用「多行 INSERT」，SQL 就地构造，不再用单条 UPSERT 常量
 */
export async function refreshMarketBatched(db, force = false) {
  if (!db) return { ok: false, error: 'app_not_initialized', inserted: 0 }
  const cfg = await _loadCfg()
  const BATCH_SIZE = cfg.batchSize
  const BATCH_TIMEOUT_MS = cfg.batchTimeoutMs

  // ① 抓数据
  const nameDf = await import('../../core/fund_pool.ts').then(m => m.getNameDf(force))
  const purchaseDf = await import('../../core/fund_pool.ts').then(m => m.getPurchaseDf(force))
  const total = nameDf.length
  console.log(`[fullRefresh] fetched ${total} names, ${purchaseDf.length} purchases`)

  if (total === 0) {
    return { ok: true, inserted: 0, note: '无新数据' }
  }

  // ② 构建 purchase 索引
  const purchaseByCode = new Map(purchaseDf.map(r => [r.fund_code, r]))

  // ③ 分批执行：每批一个事务，内部逐行 run
  const t0 = performance.now()
  let inserted = 0
  let failed = 0
  let batchIdx = 0

  for (let start = 0; start < total; start += BATCH_SIZE) {
    batchIdx++
    const end = Math.min(start + BATCH_SIZE, total)
    const batch = nameDf.slice(start, end)

    // 单批超时保护：超过阈值直接跳过本批
    const elapsed = performance.now() - t0
    if (elapsed > BATCH_TIMEOUT_MS * batchIdx * 1.5) {
      console.warn(`[fullRefresh] 整体超时（${Math.round(elapsed)}ms），中止后续批次`)
      break
    }

    try {
      await db.transaction(async () => {
        // 性能：批内改「多行 INSERT」100 行/语句（800 参数 < 999 上限）——
        // db.run 每条 = 一次原生桥往返（6~17ms），逐条 2.7 万条 = 分钟级写入风暴
        for (let i = 0; i < batch.length; i += 100) {
          const sub = batch.slice(i, i + 100)
          const tuples = sub.map(() => "(?, ?, ?, ?, ?, ?, 'active', ?, ?)").join(', ')
          const params = []
          for (const row of sub) {
            const p = purchaseByCode.get(row.fund_code)
            // 类型优先级：主源档案(fund_type) 为准；申购表仅补费率/起购，不得覆盖真实类型
            const category = (row.fund_type && String(row.fund_type).trim())
              || (p?.category && String(p.category).trim())
              || null
            params.push(
              row.fund_code,
              row.fund_name ?? p?.fund_name ?? '',
              category,
              p?.purchase_fee_rate ?? null,
              p?.min_purchase ?? null,
              String(category ?? '').toUpperCase().includes('QDII') ? 1 : 0,
              new Date().toISOString().slice(0, 19).replace('T', ' '),
              null,
            )
          }
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
      console.log(`[fullRefresh] batch ${batchIdx}: ${start}-${end}/${total} OK inserted=${inserted}`)
    } catch (e) {
      failed += batch.length
      console.warn(`[fullRefresh] batch ${batchIdx} failed:`, e.message)
      // 单批失败不中断，继续下一批
    }
  }

  const elapsed = Math.round(performance.now() - t0)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  try {
    await db.run(
      `INSERT OR REPLACE INTO pool_meta (key, value, updated_at) VALUES ('last_full_refresh', ?, ?)`,
      [now, now],
    )
  } catch (e) {
    console.warn('[fullRefresh] pool_meta write failed:', e.message)
  }

  const note = inserted === 0 && total > 0
    ? `⚠️ 抓到 ${total} 只但全部落库失败`
    : failed > 0
      ? `已落库 ${inserted}/${total}（${failed} 条失败，用时 ${elapsed}ms）`
      : `已落库 ${inserted}/${total}（用时 ${elapsed}ms）`
  console.log(`[fullRefresh] done: inserted=${inserted} failed=${failed} elapsed=${elapsed}ms`)
  return { ok: true, inserted, note }
}

/**
 * 全量刷新基金池（三条件 + 每日一次 + 前台拦截 + 主开关）
 * 满足所有条件 → 执行；任一不满足 → 静默返回，不报错
 *
 * 外部调用者（autoRefresh.js / More.jsx）都应走此入口，
 * 按需抓取（fetchNavForFund / jsFetchAndSaveHoldings）不受此控制。
 *
 * @returns {Promise<{ok: boolean, data?: {inserted:number, note:string}, error?: string}>}
 */
export async function refreshFundPool() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  const cfg = await _loadCfg()

  // ⑥ 主开关
  if (!cfg.ENABLE_FULL_MARKET_REFRESH) {
    console.log('[fullRefresh] 主开关关闭，跳过全量抓取')
    return { ok: true, data: { inserted: 0, note: '全量抓取已关闭（ENABLE_FULL_MARKET_REFRESH=false）' } }
  }

  // ④ 每日一次检查
  const todayRefreshed = await isTodayRefreshed(_db, cfg.lastRefreshMetaKey)
  if (todayRefreshed) {
    console.log('[fullRefresh] 今日已抓过，跳过')
    return { ok: true, data: { inserted: 0, note: '今日已更新，跳过' } }
  }

  // ① 网络条件
  const net = await import('../lib/networkStatus.js').then(m => m.getNetworkAndBatteryStatus())
  if (!net.onWifi) {
    console.log('[fullRefresh] 未连 WiFi，跳过')
    return { ok: true, data: { inserted: 0, note: '未连无线网络，跳过' } }
  }
  // ② 充电条件（getBattery 不可用时降级：仅看 WiFi，但仍提示）
  if (net.batterySupported && !net.charging) {
    console.log('[fullRefresh] 未在充电，跳过')
    return { ok: true, data: { inserted: 0, note: '未在充电，跳过' } }
  }
  // ③ 夜间时段
  const night = await isNightWindow(cfg)
  if (!night) {
    console.log('[fullRefresh] 非夜间时段，跳过')
    return { ok: true, data: { inserted: 0, note: '非夜间时段，跳过' } }
  }

  // ⑤ 前台拦截（App 在前台时不跑全量）
  try {
    const { App } = await import('@capacitor/app')
    const state = await App.getState()
    if (state?.isActive) {
      console.log('[fullRefresh] App 在前台，跳过全量抓取')
      return { ok: true, data: { inserted: 0, note: 'App 在前台，跳过全量抓取' } }
    }
  } catch (_) { /* ignore */ }

  // 所有条件通过 → 执行分批落库
  try {
    const r = await refreshMarketBatched(_db, true)
    return { ok: true, data: r }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 抓取前后 funds 表行数（用于 UI 显示「抓了多少」）
 * @returns {Promise<{ ok: boolean, data?: number, error?: string }>}
 */
export async function getFundsCount() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const rows = await _db.query('SELECT COUNT(*) AS n FROM funds')
    const n = Number(rows?.[0]?.n ?? 0)
    return { ok: true, data: n }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ─── 净值批量补全（前台可跑）─────────────────────────────
// 背景：`refreshFundPool` 只抓**基金列表**（funds 表 2.8 万只），净值靠用户交互单只抓。
//   而「估值洼地 + 趋势向上」筛选必须依赖**净值历史**（分位/回撤/波动）。
//   Android 会冻结后台 WebView 的 JS，全量抓取无法只在后台执行 → 提供前台可跑的批量补全。
// 方案：按 fund_code 顺序抓「本地还没有净值」的基金，
//   天然断点续抓（已抓过的跳过）、限速 300ms、可随时停止。后台自动触发逻辑保持不变。

/** 本地已有净值的基金数（DISTINCT fund_code） */
export async function getNavFundsCount() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const rows = await _db.query('SELECT COUNT(DISTINCT fund_code) AS n FROM nav_daily')
    return { ok: true, data: Number(rows?.[0]?.n ?? 0) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 净值补全进度（模块级状态：二级页切走也不中断抓取） */
const _navPool = { running: false, stop: false, done: 0, total: 0, ok: 0, fail: 0, current: '' }
export function getNavPoolProgress() { return { ..._navPool } }
/** 请求停止（当前这一只抓完即退出循环） */
export function stopNavPool() { _navPool.stop = true }

/**
 * 启动/停止「后台刷新前台服务」（原生保活）。
 * 为什么需要：Android 会冻结退到后台的 App（含 WebView 的 JS 引擎），
 *   导致「夜间 WiFi+充电 自动全量抓取」在后台无法执行。
 *   抓取期间开前台服务把进程提到 FOREGROUND_SERVICE，JS 才能继续跑。
 */
export async function startBackgroundRefresh() {
  try {
    const { registerPlugin } = await import('@capacitor/core')
    await registerPlugin('BackgroundRefresh').start()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
export async function stopBackgroundRefresh() {
  try {
    const { registerPlugin } = await import('@capacitor/core')
    await registerPlugin('BackgroundRefresh').stop()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

function _navNotify() {
  try {
    window.dispatchEvent(new CustomEvent('fundapp:nav-pool', { detail: getNavPoolProgress() }))
  } catch (_) { /* ignore */ }
}

// 只保留最近 NAV_KEEP_ROWS 条净值：
//   pingzhongdata 返回**全历史**（老基金可能 20 年+ ≈ 5000 条），
//   但筛选（screen_rules.navSeries）与分析（analysis.ts win）最多只用 **250 交易日窗口**，
//   存全历史纯浪费磁盘 + 入库时间。取 1500 条（约 6 年）留足富余，
//   即便将来加「近 3/5 年收益」也够用。入库顺序为升序 → 取尾部。
const NAV_KEEP_ROWS = 1500

/** 单只基金净值入库（多行 INSERT，与 fetchNavForFund 同口径；失败逐条兜底） */
async function _saveNavRows(fundCode, navs) {
  const keep = navs.length > NAV_KEEP_ROWS ? navs.slice(navs.length - NAV_KEEP_ROWS) : navs
  const ROWS = 150
  let inserted = 0
  for (let i = 0; i < keep.length; i += ROWS) {
    const batch = keep.slice(i, i + ROWS)
    const tuples = batch.map(() => '(?, ?, ?, ?)').join(', ')
    const params = []
    for (const nv of batch) params.push(nv.fund_code || fundCode, nv.nav_date, nv.nav, nv.nav_acc)
    try {
      await _db.run(
        `INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES ${tuples}`,
        params,
      )
      inserted += batch.length
    } catch (_) {
      for (const nv of batch) {
        try {
          await _db.run(
            'INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)',
            [nv.fund_code || fundCode, nv.nav_date, nv.nav, nv.nav_acc],
          )
          inserted++
        } catch (_) { /* 坏数据不拖累其余 */ }
      }
    }
  }
  return inserted
}

/**
 * 批量补全净值（前台可跑）。每次最多抓 `limit` 只「本地还没有净值」的基金。
 * 断点续抓：已抓过的基金不会重复抓。抓取过程派发 `fundapp:nav-pool` 事件供 UI 显示进度。
 */
export async function refreshNavPool(limit = 300, opts = {}) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  if (_navPool.running) return { ok: false, error: 'already_running' }
  const lim = Math.max(1, Number(limit) || 300)
  const bg = !!opts.background          // 后台模式：开前台服务保活，切后台也能继续抓
  // 并发路数：单只耗时里「网络等待」占大头（pingzhongdata 单文件几百 KB~1MB），
  //   串行时大量时间在等 IO。2~3 路并发重叠等待可显著提速；SQLite 写入由原生侧串行排队，安全。
  //   上限 4，默认 2（兼顾抓取风控「稳」）。
  const concurrency = Math.max(1, Math.min(4, Number(opts.concurrency) || 2))
  const db = _db

  let rows
  try {
    rows = await db.query(`
      SELECT f.fund_code FROM funds f
      WHERE f.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM nav_daily n WHERE n.fund_code = f.fund_code)
      ORDER BY f.fund_code
      LIMIT ?`, [lim])
  } catch (e) {
    return { ok: false, error: e.message }
  }

  _navPool.running = true
  _navPool.stop = false
  _navPool.done = 0
  _navPool.total = rows.length
  _navPool.ok = 0
  _navPool.fail = 0
  _navPool.current = ''
  _navNotify()
  if (bg) await startBackgroundRefresh()

  // 并发 worker 池：cursor 在 JS 单线程里自增是原子的，不会重复领取同一只。
  let cursor = 0
  const worker = async () => {
    while (true) {
      if (_navPool.stop) break
      const i = cursor++
      if (i >= rows.length) break
      const r = rows[i]
      _navPool.current = r.fund_code
      try {
        const navs = await fetchFundNavList(r.fund_code)
        if (navs && navs.length) { await _saveNavRows(r.fund_code, navs); _navPool.ok++ }
        else _navPool.fail++
      } catch (_) { _navPool.fail++ }
      _navPool.done++
      _navNotify()
      await new Promise((res) => setTimeout(res, 300))   // 抓取风控：每路限速
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
  } finally {
    _navPool.running = false
    _navPool.current = ''
    _navNotify()
    if (bg) await stopBackgroundRefresh()
  }
  return {
    ok: true,
    data: {
      done: _navPool.done, total: _navPool.total,
      ok: _navPool.ok, fail: _navPool.fail, stopped: _navPool.stop,
    },
  }
}

/** 全市场搜索（按 code/名称/pinyin 模糊匹配） */
export async function searchFunds(query) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const q = String(query ?? '').trim()
    if (!q) return { ok: true, data: [] }
    const like = `%${q}%`
    const rows = await _db.query(`
      SELECT fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii
      FROM funds
      WHERE status = 'active'
        AND (fund_code LIKE ? OR fund_name LIKE ? OR category LIKE ?)
      ORDER BY fund_code
      LIMIT 50
    `, [like, like, like])
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/** 全市场搜索（不过滤 status，含已停用基金） */
export async function searchFullMarket(query) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const q = String(query ?? '').trim()
    if (!q) return { ok: true, data: [] }
    // 提速：纯数字（用户输代码）→ fund_code 前缀匹配（主键序扫描，避免 2.8 万行全表 LIKE）；
    // 名称/类型关键字 → 三字段模糊 LIKE（LIMIT 50 兜住结果集）
    const isCodeQuery = /^\d{1,6}$/.test(q)
    const like = isCodeQuery ? `${q}%` : `%${q}%`
    const rows = isCodeQuery
      ? await _db.query(`
          SELECT fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii
          FROM funds
          WHERE fund_code LIKE ?
          ORDER BY fund_code
          LIMIT 50
        `, [like])
      : await _db.query(`
          SELECT fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii
          FROM funds
          WHERE fund_code LIKE ? OR fund_name LIKE ? OR category LIKE ?
          ORDER BY fund_code
          LIMIT 50
        `, [like, like, like])
    // 若精确匹配 6 位代码且本地无结果 → 实时抓取单只基金
    if (rows.length === 0 && /^\d{6}$/.test(q)) {
      const live = await fetchFundByCodeLive(q)
      if (live.ok && live.data) return { ok: true, data: [live.data] }
      // 抓不到 → 返回空数组，调用方需自行展示提示
      return { ok: true, data: [], hint: live.error || '未找到该基金' }
    }
    // 有结果或模糊搜索无结果 → 正常返回
    return { ok: true, data: rows, hint: rows.length === 0 ? '没有找到匹配的基金' : null }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/**
 * 实时抓取单只基金并落库（用于搜索兜底）。
 * 依次调用：FundMNBasicInformation（名字/分类）→ FundMNPerInformation（费率/起购）→ FundMNPeriodIc（净值）
 * 成功 → INSERT/UPDATE funds + fund_status + nav_daily；返回基金行。
 * 失败 → 不抛错，返回 { ok:false, error }，调用方展示人话提示。
 */
export async function fetchFundByCodeLive(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const { fetchFundStatusRemote, fetchFundNavList } = await import('../../data/sqlite_fetcher.ts')

    // ① 抓取基本信息（name + category）和申购状态
    const statusSnap = await fetchFundStatusRemote(fundCode, 15)
    if (!statusSnap) {
      return { ok: false, error: '无法获取基金信息' }
    }

    // ② 抓取申购费率 / 起购（东财单只费率 API，直接调底层 HTTP）
    let purchaseFeeRate = null
    let minPurchase = null
    try {
      const { getHttpDriver } = await import('../../data/sqlite_fetcher.ts')
      const driver = getHttpDriver()
      if (driver) {
        const purchaseUrl = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPerInformation?plat=Android&appType=ttjj&deviceid=test&FCODE=${fundCode}&pageIndex=1&pageSize=1`
        const res = await driver.get(purchaseUrl, {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Referer': 'http://fund.eastmoney.com/',
        }, 15000)
        if (res.status === 200) {
          const obj = res.data
          const datas = obj?.Datas ?? obj?.datas ?? []
          if (Array.isArray(datas) && datas.length > 0) {
            const r = datas[0]
            const fee = Number(r.FRRATE ?? r.purchase_fee_rate ?? NaN)
            const min = Number(r.MINSG ?? r.min_purchase ?? NaN)
            if (Number.isFinite(fee)) purchaseFeeRate = fee
            if (Number.isFinite(min)) minPurchase = min
          }
        }
      }
    } catch (_) { /* 费率获取失败不影响主流程 */ }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    // 类型：状态快照无 category 字段 → 从全市场档案（fundcode_search.js，getNameDf 已带类型）查；
    // 查不到留 null（不造「其他」），由可投校验按「缺少类型」明确处理
    let liveCategory = statusSnap.category ?? null
    if (!liveCategory) {
      try {
        const { getNameDf } = await import('../../core/fund_pool.ts')
        const nameDf = await getNameDf(false)
        const hit = nameDf.find(r => r.fund_code === fundCode)
        if (hit?.fund_type) liveCategory = hit.fund_type
      } catch (_) { /* 查类型失败不影响主流程 */ }
    }
    const isQdii = String(liveCategory ?? '').toUpperCase().includes('QDII') ? 1 : 0

    // ③ 落库 funds
    try {
      await _db.run(
        `INSERT INTO funds (fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii, status, added_at, note)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(fund_code) DO UPDATE SET
           fund_name=excluded.fund_name,
           category=excluded.category,
           purchase_fee_rate=COALESCE(excluded.purchase_fee_rate, funds.purchase_fee_rate),
           min_purchase=COALESCE(excluded.min_purchase, funds.min_purchase),
           is_qdii=excluded.is_qdii,
           added_at=excluded.added_at`,
        [fundCode, statusSnap.fund_name ?? '', liveCategory,
         purchaseFeeRate, minPurchase, isQdii, now, null],
      )
    } catch (e) {
      console.warn(`[liveFetch] funds INSERT failed ${fundCode}:`, e.message)
    }

    // ④ 落库 fund_status
    try {
      await _db.run(
        `INSERT INTO fund_status (fund_code, purchase_status, redeem_status, purchase_limit, raw_purchase, raw_redeem, status_date, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fund_code) DO UPDATE SET
           purchase_status=excluded.purchase_status,
           redeem_status=excluded.redeem_status,
           purchase_limit=COALESCE(excluded.purchase_limit, fund_status.purchase_limit),
           raw_purchase=excluded.raw_purchase,
           raw_redeem=excluded.raw_redeem,
           status_date=excluded.status_date,
           fetched_at=excluded.fetched_at`,
        [fundCode, statusSnap.purchase_status ?? '', statusSnap.redeem_status ?? '',
         statusSnap.purchase_limit, statusSnap.raw_purchase ?? '', statusSnap.raw_redeem ?? '',
         statusSnap.status_date, now],
      )
    } catch (e) {
      console.warn(`[liveFetch] fund_status INSERT failed ${fundCode}:`, e.message)
    }

    // ⑤ 抓取净值并落库
    try {
      const navs = await fetchFundNavList(fundCode, 10)
      const ROWS = 150
      for (let i = 0; i < navs.length; i += ROWS) {
        const batch = navs.slice(i, i + ROWS)
        const tuples = batch.map(() => '(?, ?, ?, ?)').join(', ')
        const params = []
        for (const nav of batch) params.push(nav.fund_code, nav.nav_date, nav.nav, nav.nav_acc)
        try {
          await _db.run(
            `INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES ${tuples}`,
            params,
          )
        } catch (_) {
          // 多行失败 → 逐条重试兜底
          for (const nav of batch) {
            try {
              await _db.run(
                `INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`,
                [nav.fund_code, nav.nav_date, nav.nav, nav.nav_acc],
              )
            } catch (_) { /* 单条失败不中断 */ }
          }
        }
      }
      if (navs.length > 0) console.log(`[liveFetch] ${fundCode} nav inserted=${navs.length}`)
    } catch (_) { /* 净值失败不影响主流程 */ }

    // ⑥ 构造返回行（与 searchFullMarket 格式一致）
    return {
      ok: true,
      data: {
        fund_code: fundCode,
        fund_name: statusSnap.fund_name ?? '',
        category: liveCategory,
        purchase_fee_rate: purchaseFeeRate,
        min_purchase: minPurchase,
        is_qdii: isQdii,
      },
    }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/** 检查某只基金是否已有净值数据（用于判断是否需要优先级抓取） */
export async function hasNavDaily(fundCode) {
  if (!_db) return false
  try {
    const rows = await _db.query(`SELECT 1 FROM nav_daily WHERE fund_code=? LIMIT 1`, [fundCode])
    return rows.length > 0
  } catch { return false }
}

/**
 * 盘中实时估值（估算净值 + 估算涨跌幅%）。
 * 数据源：天天基金 fundgz（`jsonpgz({...})`）。仅交易时段有实时值；非交易时段为上一交易日快照。
 * 抓不到 → { ok: true, data: null }（照实返回空，不造假）。
 */
export async function fetchFundEstimate(code) {
  if (!code) return { ok: true, data: null }
  try {
    const { fetchFundEstimate: _fetch } = await import('../../data/sqlite_fetcher.ts')
    const est = await _fetch(String(code), 10)
    return { ok: true, data: est }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: null }
  }
}

/** 批量盘中实时估值（账户页持仓多只）——返回 code → FundEstimate|null 映射 */
export async function fetchFundEstimates(codes) {
  if (!codes || !codes.length) return { ok: true, data: {} }
  try {
    const { fetchFundEstimates: _fetch } = await import('../../data/sqlite_fetcher.ts')
    const map = await _fetch(codes, 12)
    return { ok: true, data: map }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: {} }
  }
}

/** 基金实时快照（最新净值日期/涨跌幅 + 跟踪指数实时行情）——返回 code → FundLiveSnapshot|null 映射 */
export async function fetchFundLiveSnapshot(codes) {
  if (!codes || !codes.length) return { ok: true, data: {} }
  try {
    const { fetchFundLiveSnapshot: _fetch } = await import('../../data/sqlite_fetcher.ts')
    const map = await _fetch(codes, 8)
    return { ok: true, data: map }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: {} }
  }
}

/** 大盘指数（上证/深成/创业板/沪深300）——分析页顶部指数排 */
export async function fetchMarketIndex() {
  try {
    const { fetchMarketIndex: _fetch } = await import('../../data/sqlite_fetcher.ts')
    const list = await _fetch(10)
    return { ok: true, data: list }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: [] }
  }
}

/**
 * 指数日 K 线（push2his）。返回 [{date, open, close, high, low}]，抓不到返回空数组（不造假）。
 */
export async function fetchIndexKlineFor(indexCode, lmt = 120) {
  try {
    const { fetchIndexKline } = await import('../../data/sqlite_fetcher.ts')
    const bars = await fetchIndexKline(String(indexCode), lmt)
    return { ok: true, data: bars }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: [] }
  }
}

/**
 * 指数估值（蛋卷）：PE / PB / 历史分位 / 股息率 / 估值类型（low/mid/high）。
 * codes 省略 → 取默认核心宽基。抓不到返回空数组（不造假）。
 */
export async function fetchIndexValuationFor(codes) {
  try {
    const { fetchIndexValuation } = await import('../../data/sqlite_fetcher.ts')
    const list = await fetchIndexValuation(codes)
    return { ok: true, data: list }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: [] }
  }
}

/**
 * 全球行情（国外指数 + 商品：实时点位/价格 + 涨跌%）。抓不到 → 空数组（不造假）。
 */
export async function fetchGlobalQuotesFor() {
  try {
    const { fetchGlobalQuotes } = await import('../../data/sqlite_fetcher.ts')
    const list = await fetchGlobalQuotes()
    return { ok: true, data: list }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: [] }
  }
}

/**
 * 全球行情「抓 + 落库」：实时抓取国外指数 + 商品，写入 global_quotes 表。
 * 由调度器（App 启动/每日周期）与指数估值页打开时调用，保证数据持续更新、可被其它模块读取。
 * 抓不到/库未就绪 → 返回 ok:false，不抛（落库失败不应阻断页面）。
 */
export async function fetchAndPersistGlobalQuotes() {
  try {
    const { fetchGlobalQuotes } = await import('../../data/sqlite_fetcher.ts')
    const list = await fetchGlobalQuotes()
    const db = getDb()
    if (db && list.length) {
      const ts = localNowStr()
      for (const q of list) {
        await db.run(
          `INSERT OR REPLACE INTO global_quotes (code, kind, name, value, change_pct, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [q.code, q.kind, q.name, q.value, q.change_pct, ts],
        )
      }
    }
    return { ok: true, data: list }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: [] }
  }
}

/**
 * 读取 global_quotes 本地库（调度器已落库的最新值）。页面打开时先读它秒开显示。
 */
export async function getGlobalQuotesFromDb() {
  const db = getDb()
  if (!db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const rows = await db.query(
      `SELECT code, kind, name, value, change_pct, updated_at
       FROM global_quotes ORDER BY kind, code`,
    )
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: [] }
  }
}

/** 本地时间字符串（非 UTC）：YYYY-MM-DD HH:mm:ss（落库时间戳用） */
function localNowStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 指数历史 PE（中证指数官网）：估值分位曲线用。日度序列 [{date, pe}]。
 * 深证系列（399xxx）中证官网不收录 → 返回空数组（不造假）。
 */
export async function fetchIndexPeHistoryFor(indexCode, years = 10) {
  try {
    const { fetchIndexPeHistory } = await import('../../data/sqlite_fetcher.ts')
    const list = await fetchIndexPeHistory(String(indexCode || ''), years)
    return { ok: true, data: list }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: [] }
  }
}

/**
 * 基金深度档案（能力评分 / 规模 / 资产配置 / 持有人结构）。抓不到返回 null（不造假）。
 */
export async function fetchFundProfileFor(fundCode) {
  if (!fundCode) return { ok: true, data: null }
  try {
    const { fetchFundProfile } = await import('../../data/sqlite_fetcher.ts')
    const p = await fetchFundProfile(String(fundCode), 15)
    return { ok: true, data: p }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: null }
  }
}

/**
 * 基准对比：组合曲线（portfolio_daily 每日快照）vs 指数（默认沪深300）。
 * 两条线都归一化到起点=100，按组合快照日对齐基准收盘价。
 * 数据不足（组合快照 < 2 天）→ 返回 { insufficient:true }，不造假。
 */
export async function fetchBenchmarkCompare(indexCode = '000300', lmt = 240, source = 'trade') {
  try {
    // 结构隔离：组合线按 source 取（'trade' 虚拟盘 / 'real' 真实持仓）
    const curve = await fetchPortfolioCurve(400, source)
    const rows = (curve?.data ?? [])
      .map(r => ({ date: String(r.snap_date ?? '').slice(0, 10), v: Number(r.total_assets) }))
      .filter(x => x.date && Number.isFinite(x.v))
      .sort((a, b) => a.date.localeCompare(b.date))

    if (rows.length < 2) {
      return { ok: true, data: { insufficient: true, reason: '组合快照不足 2 天（每日收盘后自动记录）', snapDays: rows.length } }
    }

    const k = await fetchIndexKlineFor(indexCode, lmt)
    const bars = (k?.data ?? []).filter(b => Number.isFinite(b.close))
    const start = rows[0].date
    const end = rows[rows.length - 1].date
    const bSeries = bars.filter(b => b.date >= start && b.date <= end)
    if (bSeries.length < 2) {
      // 区分两种"不足"：指数压根没取到 vs 取到了但区间内没有交易日（如假期）
      const reason = bars.length === 0
        ? '指数数据取不到（网络或数据源问题），稍后重试'
        : `你记录的 ${start} ~ ${end} 区间内没有可比的大盘交易日（可能是假期），等记录满几个交易日后自动出图`
      return { ok: true, data: { insufficient: true, reason, snapDays: rows.length } }
    }

    const dates = rows.map(x => x.date)
    const pBase = rows[0].v
    const bBase = bSeries[0].close
    const portfolio = rows.map(x => +(x.v / pBase * 100).toFixed(2))

    // 基准按组合快照日对齐：取 <= 该日的最近一个收盘
    const benchmark = []
    let bi = 0
    for (const d of dates) {
      while (bi + 1 < bSeries.length && bSeries[bi + 1].date <= d) bi++
      const bar = bSeries[bi]
      benchmark.push(bar && bar.date <= d ? +(bar.close / bBase * 100).toFixed(2) : null)
    }

    const pRet = +(portfolio[portfolio.length - 1] - 100).toFixed(2)
    const lastB = benchmark[benchmark.length - 1]
    const bRet = lastB != null ? +(lastB - 100).toFixed(2) : null
    return {
      ok: true,
      data: {
        insufficient: false,
        indexCode,
        dates,
        portfolio,
        benchmark,
        portfolioRet: pRet,
        benchmarkRet: bRet,
        excess: bRet != null ? +(pRet - bRet).toFixed(2) : null,
        snapDays: rows.length,
      },
    }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: null }
  }
}

/**
 * 本地 OCR：识别持仓截图 → 文本 → 解析候选 → 匹配本地 funds 表。
 * 全程离线（Tesseract.js + 打包的中文语言包），不联网、不用 key。
 * 返回 { ok, text, items:[{code,name,shares,amount,pct,matched}] }。识别不出的不猜。
 */
export async function ocrHoldingsFromImage(image, onProgress) {
  try {
    const { recognizeImage, parseHoldingsFromText } = await import('../../core/ocr.ts')
    const r = await recognizeImage(image, onProgress)
    if (!r.ok) return { ok: false, error: r.error || '识别失败', text: '', items: [] }
    const parsed = parseHoldingsFromText(r.text || '')

    // 识别到的「有 6 位代码」基金：实时抓取资料 + 全量净值补进本地库，再匹配。
    // 否则本地仅约 294 只（全市场 2.4 万），几乎全部「未匹配」→ 导入等于没导。
    // OCR 识别本身离线；此处按识别出的代码按需联网抓取（净值抓取本就联网）。
    const seen = new Set()
    const codes = []
    for (const it of parsed) {
      const code = it.code
      if (code && !seen.has(code)) { seen.add(code); codes.push(code) }
    }
    let done = 0
    for (const code of codes) {
      try {
        await fetchFundByCodeLive(code) // 一次性补 funds + fund_status + 全量 nav_daily
      } catch { /* 单只失败不影响其余 */ }
      done++
      if (typeof onProgress === 'function') {
        onProgress(0, `正在抓取基金资料 ${done}/${codes.length}（${code}）`)
      }
    }

    // 名称匹配：OCR 名称常混入引号等噪声、且可能被截断（如「华夏国证半导体芯片 ”」）
    //   → 先清洗（去符号/空格），再按「全名 → 逐步缩短前缀」多级 LIKE 匹配（长前缀优先，降低误配）。
    //   截图通常没有 6 位代码，名称是唯一线索；本地 funds 覆盖全市场约 2.8 万只，逐级放宽可显著提高命中。
    const cleanName = (s) => String(s || '')
      .replace(/["“”'‘’`《》〈〉<>「」『』()（）[\]【】·、,，.。:：;；!！?？|/\\\-—_+*#%&@~^]/g, '')
      .replace(/\s+/g, '')
      .trim()
    const matchByName = async (rawName) => {
      const n = cleanName(rawName)
      if (n.length < 4) return null
      const tries = []
      for (const len of [n.length, 14, 12, 10, 8, 6]) {
        const t = n.slice(0, len)
        if (t.length >= 6 && !tries.includes(t)) tries.push(t)
      }
      for (const t of tries) {
        const q = await _db.query(
          // 库侧同样去掉空格与半/全角括号，与清洗后的查询串对齐（否则「…混合(QDII)人民币A」全名匹配不上）
          "SELECT fund_code, fund_name FROM funds WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(fund_name,' ',''),'(',''),')',''),'（',''),'）','') LIKE ? LIMIT 1",
          ['%' + t + '%'],
        )
        if (q.length) return { fund_code: q[0].fund_code, fund_name: q[0].fund_name }
      }
      return null
    }

    const items = []
    for (const it of parsed) {
      let matched = null
      try {
        if (_db && it.code) {
          const q = await _db.query('SELECT fund_code, fund_name FROM funds WHERE fund_code=? LIMIT 1', [it.code])
          if (q.length) matched = { fund_code: q[0].fund_code, fund_name: q[0].fund_name }
        }
        if (_db && !matched && it.name) matched = await matchByName(it.name)
      } catch { /* 匹配失败不影响识别结果 */ }
      items.push({ ...it, matched })
    }
    return { ok: true, text: r.text || '', items }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), text: '', items: [] }
  }
}

/** 释放 OCR worker（退出导入面板时调用，回收内存） */
export async function disposeOcr() {
  try {
    const { disposeOcr: _d } = await import('../../core/ocr.ts')
    await _d()
  } catch { /* ignore */ }
}

/** 该基金**近期**净值条数（默认近 400 天）。用于判断历史是否完整：
 *  只看总数会被"只有早年数据"骗过（如 000001 曾只有 2001-2006 的 1145 条），
 *  故只数近期条数——近期不足即视为历史残缺，需要重抓。 */
export async function navCountForFund(fundCode, days = 400) {
  if (!_db) return 0
  try {
    const rows = await _db.query(
      `SELECT COUNT(*) AS n FROM nav_daily WHERE fund_code=? AND nav_date >= date('now', ?)`,
      [fundCode, `-${days} days`],
    )
    return Number(rows[0]?.n ?? 0)
  } catch { return 0 }
}

/** 优先级抓取单只基金的净值并落库，供用户主动搜索时使用 */
export async function fetchNavForFund(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const navs = await fetchFundNavList(fundCode, 20)
    let inserted = 0
    // 性能：改「多行 INSERT」150 行/语句（600 参数 < 999 上限）——
    // 逐条 db.run 每条 = 一次原生桥往返（6~17ms），6000 条历史 ≈ 36~100 秒；多行 ≈ 40 次往返
    const ROWS = 150
    for (let i = 0; i < navs.length; i += ROWS) {
      const batch = navs.slice(i, i + ROWS)
      const tuples = batch.map(() => '(?, ?, ?, ?)').join(', ')
      const params = []
      for (const nav of batch) params.push(nav.fund_code, nav.nav_date, nav.nav, nav.nav_acc)
      try {
        await _db.run(
          `INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES ${tuples}`,
          params,
        )
        inserted += batch.length
      } catch (e) {
        // 多行失败 → 逐条重试兜底（坏数据不拖累其余）
        for (const nav of batch) {
          try {
            await _db.run(
              `INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`,
              [nav.fund_code, nav.nav_date, nav.nav, nav.nav_acc],
            )
            inserted++
          } catch (e2) {
            pushFetchError(`fetchNavForFund INSERT failed ${fundCode} ${nav.nav_date}: ${e2?.message ?? String(e2)}`)
          }
        }
      }
    }
    // 分红跟踪：净值刷新落库后，若该基金当前有持仓，自动识别并落账分红（现金到账 / 红利再投）。
    // 幂等：已处理过的除息日会跳过，不会重复入账。失败不影响净值刷新主流程。
    try {
      const held = await _db.query(
        // 结构隔离：两套系统的持仓都要识别分红（显式取并集）
        "SELECT 1 AS x FROM lots WHERE fund_code=? AND status='active' AND remaining_shares>0 AND source IN ('real','trade') LIMIT 1",
        [fundCode],
      )
      if (held.length) {
        await _processDividends(_db, fundCode)
      }
    } catch (e) {
      pushFetchError(`fetchNavForFund dividend(${fundCode}): ${e?.message ?? String(e)}`)
    }
    console.log(`[nav][priority] ${fundCode} parsed=${navs.length} inserted=${inserted}`)
    return { ok: true, data: { parsed: navs.length, inserted } }
  } catch (e) {
    const errMsg = e?.message ?? String(e)
    pushFetchError(`fetchNavForFund(${fundCode}): ${errMsg}`)
    return { ok: false, error: errMsg }
  }
}

/** 切换关注状态（返回新 is_favorite 值：0 或 1） */
export async function toggleFavorite(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    await _db.run(
      `UPDATE funds SET is_favorite = CASE WHEN is_favorite = 1 THEN 0 ELSE 1 END WHERE fund_code = ?`,
      [fundCode],
    )
    const rows = await _db.query(`SELECT is_favorite FROM funds WHERE fund_code = ?`, [fundCode])
    return { ok: true, data: (rows[0]?.is_favorite ?? 0) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 拉关注列表（is_favorite=1） */
export async function fetchWatchlist() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const rows = await _db.query(`
      SELECT fund_code, fund_name, category, purchase_fee_rate, min_purchase, is_qdii
      FROM funds
      WHERE is_favorite = 1
      ORDER BY fund_code
    `)
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/**
 * 批量取「昨日涨幅」（倒数第二个交易日相对倒数第三个交易日的涨跌 %）。
 * 账户页「昨日收益」用。每只基金取最近 3 条净值（窗口函数，一条 SQL），
 * JS 里算 pct：昨日涨幅 = nav[-2]/nav[-3] - 1。
 * 净值不足 3 条的基金返回 null（不造假）。返回 { [fund_code]: number|null }。
 */
export async function fetchYesterdayPct(codes) {
  if (!_db || !codes || !codes.length) return { ok: true, data: {} }
  try {
    const ph = codes.map(() => '?').join(',')
    const rows = await _db.query(`
      SELECT fund_code, nav_date, nav FROM (
        SELECT fund_code, nav_date, nav,
               ROW_NUMBER() OVER (PARTITION BY fund_code ORDER BY nav_date DESC) AS rn
        FROM nav_daily
        WHERE fund_code IN (${ph})
      ) WHERE rn <= 3
      ORDER BY fund_code, nav_date DESC
    `, codes)
    const byCode = {}
    for (const r of rows) {
      if (!byCode[r.fund_code]) byCode[r.fund_code] = []
      byCode[r.fund_code].push(Number(r.nav))
    }
    const out = {}
    for (const c of codes) {
      const list = byCode[c]
      if (list && list.length >= 3 && list[1] > 0 && list[2] > 0) {
        out[c] = ((list[1] / list[2]) - 1) * 100
      } else {
        out[c] = null
      }
    }
    return { ok: true, data: out }
  } catch (e) {
    return { ok: false, error: e.message, data: {} }
  }
}

/**
 * 批量取「最新净值日涨跌幅」（最新交易日相对前一交易日的涨跌 %）+ 净值日期。
 * 持仓页「当日涨跌」用：取「最新净值日涨跌幅」，不把累计收益率误标为当日。
 * 只取最近 2 条净值；不足 2 条返回 null（不造假）。返回 { [code]: { pct, nav_date } | null }。
 */
export async function fetchLatestNavPct(codes) {
  if (!_db || !codes || !codes.length) return { ok: true, data: {} }
  try {
    const ph = codes.map(() => '?').join(',')
    const rows = await _db.query(`
      SELECT fund_code, nav_date, nav FROM (
        SELECT fund_code, nav_date, nav,
               ROW_NUMBER() OVER (PARTITION BY fund_code ORDER BY nav_date DESC) AS rn
        FROM nav_daily
        WHERE fund_code IN (${ph})
      ) WHERE rn <= 2
      ORDER BY fund_code, nav_date DESC
    `, codes)
    const byCode = {}
    const dateByCode = {}
    for (const r of rows) {
      if (!byCode[r.fund_code]) { byCode[r.fund_code] = []; dateByCode[r.fund_code] = r.nav_date }
      byCode[r.fund_code].push(Number(r.nav))
    }
    const out = {}
    for (const c of codes) {
      const list = byCode[c]
      if (list && list.length >= 2 && list[1] > 0) {
        out[c] = { pct: ((list[0] / list[1]) - 1) * 100, nav_date: dateByCode[c] }
      } else {
        out[c] = null
      }
    }
    return { ok: true, data: out }
  } catch (e) {
    return { ok: false, error: e.message, data: {} }
  }
}

/**
 * OCR 识别结果写入持仓。
 * 规则（不造假）：
 *  - 写「已匹配本地基金 + 至少含份额或金额之一」的条目；两者全无 → 跳过并明示原因，不猜。
 *  - 缺失字段（份额 / 成本金额）落 0，**不自动推算**；由用户到持仓页「修改」手动补全。
 *  - buy_order_id = 'ocr-import-<时间戳>' 标记导入来源（区别于真实订单）。
 *  - buy_date/confirm_date = 入库日（截图里没有真实买入日，不猜）。
 *  - cost_amount = 截图里的持有金额（真实值；若截图给的是市值，用户可在「修改」里更正）。
 *  - 不动交易页预算/现金账本（导入的是存量真实持仓，不是新订单）。
 * 返回 { ok, data: { inserted, skipped: [{name, reason}], incomplete: [{name, missing[]}] } }
 */
export async function importHoldings(items) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const dateOnly = now.slice(0, 10)
  const stamp = Date.now()
  let inserted = 0
  const skipped = []
  const incomplete = []   // 已写入但缺字段（份额/成本），需用户到持仓页「修改」补全
  try {
    for (const it of (items || [])) {
      const code = it?.matched?.fund_code
      const name = it?.matched?.fund_name || it?.name || it?.code || '未识别'
      if (!code) { skipped.push({ name, reason: '未匹配到本地基金' }); continue }
      const rawShares = Number(it?.shares)
      const rawAmount = Number(it?.amount)
      // 截图的「收益率」用于反推真实成本（pct=null 表示截图无收益率）
      const rawPct = it?.pct == null ? NaN : Number(it.pct)
      const hasShares = rawShares > 0
      const hasAmount = rawAmount > 0
      const hasPct = Number.isFinite(rawPct)
      // 不因「缺份额」整条丢弃：
      //   支付宝 / 天天基金的持仓列表截图通常只显示「持有金额」，不显示「份额」（份额要点进详情才有）。
      //   口径：匹配到基金 + 至少有「份额」或「金额」之一 → 就写入；缺失字段落 0（表列 NOT NULL），
      //   由用户在持仓页「修改」（EditHoldingDialog）手动补全。**不自动推算、不猜**。
      if (!hasShares && !hasAmount) {
        skipped.push({ name, reason: '没识别到份额也没识别到金额' })
        continue
      }
      const shares = hasShares ? rawShares : 0
      const amount = hasAmount ? rawAmount : 0
      // 支付宝「持有金额」是**市值**，不是成本。
      //   成本 = 市值 ÷ (1 + 收益率)；有收益率才反推，无收益率退化为「金额=成本」（收益从 0 起，提示补收益率）。
      const denom = 1 + rawPct / 100
      const costAmount = hasAmount ? (hasPct && denom > 0 ? amount / denom : amount) : 0
      const missing = []
      if (!hasShares) missing.push('份额')
      if (!hasAmount) missing.push('成本金额')
      if (hasAmount && !hasPct) missing.push('收益率')
      // 导入前去重——删除该基金已有的 OCR 导入真实批次，避免同一张截图导两次 → 真实侧堆积翻倍。
      //   只删 `source='real' AND buy_order_id LIKE 'ocr-import-%'`（OCR 导入批次），绝不碰其它来源。
      await _db.run(
        `DELETE FROM lots WHERE fund_code=? AND source='real' AND buy_order_id LIKE 'ocr-import-%'`,
        [code],
      )
      await _db.run(
        // 结构隔离：OCR 导入 → source 固定 'real'（真实持仓）；buy_order_id 前缀降为迁移兜底
        `INSERT INTO lots (fund_code, buy_order_id, buy_date, confirm_date, shares, remaining_shares, cost_amount, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'real', ?)`,
        [code, `ocr-import-${stamp}`, dateOnly, dateOnly, shares, shares, costAmount, now],
      )
      inserted++
      if (missing.length) incomplete.push({ name, missing })
    }
    // 风控提醒（10-08）：真实持仓写入成功后派发事件，持仓页回到前台时据此短暂弹出提醒（仅加入才提醒，3 秒隐去）
    if (inserted > 0 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('fundapp:real-holding-added'))
    }
    return { ok: true, data: { inserted, skipped, incomplete } }
  } catch (e) {
    return { ok: false, error: e.message, data: { inserted, skipped, incomplete } }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 导入截图去重：同一张持仓截图重复导入 → 不再重复识别，避免持仓重复
// ═══════════════════════════════════════════════════════════════════════
//   重复导入会把用户手改过的成本/份额覆盖回截图值，故加「图片指纹」层：
//   识别前先比对，命中即跳过。
// 指纹 = FNV-1a 32 位 + 原文长度（免依赖、够用；万一碰撞 → 用户可点「仍要重新导入」放行，不会卡死）。

const IMG_HASH_KEY = 'imported_image_hashes'   // app_settings 键
const IMG_HASH_MAX = 50                        // 只留最近 50 张，防无限增长

/** 计算截图指纹（对 dataURL 全文做 FNV-1a 32 位，附长度降低碰撞） */
export function imageFingerprint(dataUrl) {
  const s = String(dataUrl || '')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // FNV 质数 16777619 的移位展开（避免 32 位乘法精度丢失）
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return s.length.toString(36) + '-' + h.toString(36)
}

/** 读取「已导入截图指纹」列表（最新在前） */
export async function getImportedImageHashes() {
  if (!_db) return { ok: false, data: [] }
  try {
    const rows = await _db.query('SELECT value FROM app_settings WHERE key=?', [IMG_HASH_KEY])
    const raw = rows[0]?.value
    const list = raw ? JSON.parse(raw) : []
    return { ok: true, data: Array.isArray(list) ? list : [] }
  } catch { return { ok: false, data: [] } }
}

/**
 * 查询这张截图是否已导入过。
 * 命中 → 返回记录 `{ h, at, n }`（at = 上次导入时间，n = 上次写入条数）；未命中 → null。
 */
export async function findImportedImage(dataUrl) {
  const fp = imageFingerprint(dataUrl)
  const r = await getImportedImageHashes()
  return r.data.find((x) => x?.h === fp) || null
}

/** 记录一次成功导入的截图指纹（同指纹去重后置顶，只留最近 IMG_HASH_MAX 条） */
export async function markImageImported(dataUrl, count) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const fp = imageFingerprint(dataUrl)
    const r = await getImportedImageHashes()
    // 本地时间（展示给用户看；不能用 toISOString —— 那是 UTC，会差 8 小时）
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    const list = [{ h: fp, at, n: Number(count) || 0 }, ...r.data.filter((x) => x?.h !== fp)].slice(0, IMG_HASH_MAX)
    await jsSettingsSet({ [IMG_HASH_KEY]: JSON.stringify(list) })
    return { ok: true }
  } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
}

/**
 * 为「未匹配」的识别条目手工补 6 位代码 → 抓资料/净值 → 匹配 → 写入真实持仓。
 * 场景：持仓截图没有基金代码、名称又被 OCR 读得不准 → 自动匹配不上；用户在导入面板手填代码兜底。
 * 隔离不变：只写 source='real'；抓取只补 funds / fund_status / nav_daily。
 * 返回 { ok, data: { inserted, skipped, incomplete } }
 */
export async function importHoldingByCode(item, code) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  const c = String(code || '').trim()
  if (!/^\d{6}$/.test(c)) return { ok: false, error: '基金代码必须是 6 位数字' }
  try {
    await fetchFundByCodeLive(c)   // 一次性补 funds + fund_status + 全量 nav_daily
    const q = await _db.query('SELECT fund_code, fund_name FROM funds WHERE fund_code=? LIMIT 1', [c])
    if (!q.length) return { ok: false, error: '没找到该代码对应的基金，请核对代码' }
    const matched = { fund_code: q[0].fund_code, fund_name: q[0].fund_name }
    const res = await importHoldings([{ ...item, code: c, matched }])
    return { ...res, data: { ...(res.data || {}), matched } }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

/**
 * 移除某基金的持仓批次（两套系统通用）。
 * - source='real'：只删 `source='real' AND buy_order_id LIKE 'ocr-import-%'`（OCR 导入的真实持仓），绝不碰其它来源。
 * - source='trade'：删该基金在练手账本（虚拟盘）的全部持仓批次。
 * 删除后派发 fundapp:cycle-done 让持仓页即时刷新。
 */
export async function removeHolding(fundCode, source = 'real') {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    if (source === 'real') {
      await _db.run(
        `DELETE FROM lots WHERE fund_code=? AND source='real' AND buy_order_id LIKE 'ocr-import-%'`,
        [fundCode],
      )
    } else {
      await _db.run(
        `DELETE FROM lots WHERE fund_code=? AND source='trade'`,
        [fundCode],
      )
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('fundapp:cycle-done'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 修改某只真实持仓（OCR 导入批次）的手工纠错。
 * 适用场景：OCR 把基金代码 / 份额 / 成本 / 买入日期读错了，用户在持仓页手动改。
 * ⚠️ 隔离：只动 `source='real' AND buy_order_id LIKE 'ocr-import-%'` 的批次，绝不碰交易盘、不碰其它来源。
 * patch：
 *   - fund_code   6 位代码（读错代码时改；改了会触发 fetchFundByCodeLive 补资料+净值）
 *   - shares      持有份额（剩余份额同步置等：真实持仓无卖出，remaining = shares）
 *   - cost_amount 持仓成本（含费）
 *   - buy_date    买入日期 YYYY-MM-DD（confirm_date 同设为该日）
 * 返回 {ok, error?}
 */
export async function updateRealHolding(fundCode, patch) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const newCode = patch.fund_code != null ? String(patch.fund_code).trim() : fundCode
    const shares = Number(patch.shares)
    const cost = Number(patch.cost_amount)
    const buyDate = patch.buy_date ? String(patch.buy_date).trim() : null
    if (!/^\d{6}$/.test(newCode)) return { ok: false, error: '基金代码必须是 6 位数字' }
    if (!(shares > 0)) return { ok: false, error: '持有份额必须大于 0' }
    if (!(cost > 0)) return { ok: false, error: '持仓成本必须大于 0' }
    if (buyDate && !/^\d{4}-\d{2}-\d{2}$/.test(buyDate)) return { ok: false, error: '买入日期格式应为 YYYY-MM-DD' }

    // 代码改了：best-effort 补目标基金资料/净值（不阻断保存，失败仅提示）
    if (newCode !== fundCode) {
      try { await fetchFundByCodeLive(newCode) } catch { /* ignore */ }
    }

    const sets = ['shares = ?', 'remaining_shares = ?', 'cost_amount = ?']
    const params = [shares, shares, cost]
    if (buyDate) { sets.push('buy_date = ?', 'confirm_date = ?'); params.push(buyDate, buyDate) }
    if (newCode !== fundCode) { sets.push('fund_code = ?'); params.push(newCode) }
    params.push(fundCode) // WHERE fund_code=?

    await _db.run(
      `UPDATE lots SET ${sets.join(', ')} WHERE fund_code=? AND source='real' AND buy_order_id LIKE 'ocr-import-%'`,
      params,
    )
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('fundapp:cycle-done'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 清空预警触发记录（alert_history）。仅清记录，不动预警规则本身。
 */
export async function clearAlertHistory() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    await _db.run('DELETE FROM alert_history')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ─── 订单 ───────────────────────────────────────────

/**
 * 下单（买入）。
 * 校验：预算 / 起购 / 限购 / 暂停申购 → 失败时 error 含可读消息。
 * 返回：{ok, data: {orderId, fundCode, feeRate, ...}, error?}
 */
export async function submitBuy({ fundCode, amount, reason = '' }) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    // 业务前置校验（含起购/限购/暂停）
    // checkBeforeSubmit 的签名是 (orderType, fundCode, amount, decisionSource, reason)，
    //   必须传全 5 个，否则 decisionSource / reason 为 undefined 时 `reason.trim()` 会抛。
    //   其返回字段是 `message`（不是 reason）。
    const check = await checkBeforeSubmit('buy', fundCode, amount, 'human', reason)
    if (!check.ok) return { ok: false, error: check.message, code: check.code }

    const sub = await submitOrder('buy', fundCode, amount, 'human', reason)
    return { ok: true, data: sub }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 下单（赎回，按份额）。
 */
export async function submitSell({ fundCode, shares, reason = '' }) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    // 补 decisionSource / reason 两个参数，错误字段用 message
    const check = await checkBeforeSubmit('sell', fundCode, shares, 'human', reason)
    if (!check.ok) return { ok: false, error: check.message, code: check.code }

    const sub = await submitOrder('sell', fundCode, shares, 'human', reason)
    return { ok: true, data: sub }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 确认订单（把 pending → confirmed → 建 lot / 记赎回流水）。
 * 需要有单位净值数据（nav_daily 表）。
 */
export async function confirmOrderOnDevice(orderId, reason = '') {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const r = await confirmOrder(orderId, 'human', reason)
    return { ok: true, data: r }
  } catch (e) {
    // 把完整堆栈打到 logcat：Toast 只能显示一行，真机排查靠这条
    console.error('[confirm] 确认订单失败:', (e && (e.stack || e.message)) || e)
    return { ok: false, error: e.message }
  }
}

export async function cancelOrderOnDevice(orderId) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    await cancelOrder(orderId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 拉所有 pending 订单 */
export async function fetchPendingOrders() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const rows = await _db.query(`
      SELECT o.*, f.fund_name
      FROM orders o
      LEFT JOIN funds f ON f.fund_code = o.fund_code
      WHERE o.status = 'pending'
      ORDER BY o.created_at DESC
    `)
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/** 拉所有订单（含 pending/confirmed/cancelled） */
export async function fetchAllOrders() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const rows = await _db.query(`
      SELECT o.*, f.fund_name
      FROM orders o
      LEFT JOIN funds f ON f.fund_code = o.fund_code
      ORDER BY o.created_at DESC
      LIMIT 200
    `)
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/** 单只基金 meta（轻量版：起购/限购/状态，用于交易页实时校验） */
export async function fetchFundMeta(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: null }
  try {
    const fundRows = await _db.query(`
      SELECT fund_code, fund_name, category, min_purchase, is_qdii
      FROM funds WHERE fund_code = ? LIMIT 1
    `, [fundCode])
    const fund = fundRows[0] ?? null
    const statusRows = await _db.query(`
      SELECT purchase_status, purchase_limit, raw_purchase, redeem_status, status_date
      FROM fund_status WHERE fund_code = ?
      ORDER BY status_date DESC LIMIT 1
    `, [fundCode])
    const status = statusRows[0] ?? null
    return {
      ok: true,
      data: {
        fund_code: fundCode,
        fund_name: fund?.fund_name,
        category: fund?.category,
        min_purchase: fund?.min_purchase ?? 1,
        is_qdii: !!fund?.is_qdii,
        purchase_status: status?.purchase_status || status?.raw_purchase || '开放申购',
        purchase_limit: status?.purchase_limit ?? null,
        raw_purchase: status?.raw_purchase ?? null,
        redeem_status: status?.redeem_status ?? null,
        status_date: status?.status_date,
      },
    }
  } catch (e) {
    return { ok: false, error: e.message, data: null }
  }
}

/** 单只基金详情（含最新净值） */
export async function fetchFundDetail(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const rows = await _db.query(`SELECT * FROM funds WHERE fund_code = ?`, [fundCode])
    if (rows.length === 0) return { ok: false, error: 'fund_not_found', data: null }
    const fund = rows[0]
    const navs = await _db.query(`
      SELECT nav_date, nav FROM nav_daily
      WHERE fund_code = ?
      ORDER BY nav_date DESC LIMIT 60
    `, [fundCode])
    const status = await _db.query(`
      SELECT * FROM fund_status WHERE fund_code = ?
      ORDER BY status_date DESC LIMIT 1
    `, [fundCode])
    return { ok: true, data: { fund, navs: navs.reverse(), status: status[0] ?? null } }
  } catch (e) {
    return { ok: false, error: e.message, data: null }
  }
}

// ─── 基金详情弹窗的数据源（全部本地 SQLite）──────────

/**
 * 弹窗用的净值包：series（按日期升序）+ 指标统计 + 申购状态。
 * data=null 表示本地无净值 → 弹窗显示「暂无净值数据」。
 */
export async function fetchFundNavBundle(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: null }
  try {
    const rows = await _db.query(
      `SELECT nav_date, nav, acc_nav FROM nav_daily WHERE fund_code=? ORDER BY nav_date ASC`,
      [fundCode],
    )
    if (rows.length === 0) return { ok: true, data: null }
    const series = rows.map(r => ({
      date: r.nav_date,
      nav: Number(r.nav),
      // 累计净值缺失时回退单位净值（navlab 也是这个口径）
      acc_nav: r.acc_nav != null ? Number(r.acc_nav) : Number(r.nav),
    }))
    const { navStats } = await import('../../core/analysis.ts')
    const s = await navStats(_db, fundCode)
    const last = series[series.length - 1]
    const stats = {
      latest_acc_nav: last.acc_nav,
      ret_1m: s.ret_1m,
      ret_3m: s.ret_3m,
      ret_6m: s.ret_6m,
      ret_1y: s.ret_1y,
      // 回撤/波动是风险指标：pct() 会给非负数补「+」，故回撤传负值（沿用弹窗既有约定）
      max_drawdown: s.max_drawdown_pct == null ? null : -Math.abs(s.max_drawdown_pct),
      annual_vol: s.annual_volatility_pct,
      history_days: s.samples,
      latest_date: last.date,
    }
    const st = await _db.query(
      `SELECT * FROM fund_status WHERE fund_code=? ORDER BY status_date DESC LIMIT 1`,
      [fundCode],
    )
    const status = st[0] ?? null
    return {
      ok: true,
      data: {
        series,
        stats,
        purchase_status: status?.purchase_status ?? status?.raw_purchase ?? null,
        purchase_limit: status?.purchase_limit ?? null,
        redeem_status: status?.redeem_status ?? null,
      },
    }
  } catch (e) {
    return { ok: false, error: e.message, data: null }
  }
}

/**
 * 前十大重仓（本地 fund_holdings.source='top_holdings'）。
 * 本地为空时按需抓取一次。
 */
export async function fetchFundTopHoldingsList(fundCode, { fetchIfEmpty = true } = {}) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  const read = () => _db.query(
    `SELECT stock_code, stock_name, weight, report_date FROM fund_holdings
     WHERE fund_code=? AND source='top_holdings'
     ORDER BY weight DESC LIMIT 10`,
    [fundCode],
  )
  try {
    let rows = await read()
    if (rows.length === 0 && fetchIfEmpty) {
      const r = await jsFetchAndSaveHoldings(fundCode)
      if (r.ok) rows = await read()
    }
    return {
      ok: true,
      data: rows.map(r => ({
        stock_code: r.stock_code,
        stock_name: r.stock_name,
        weight: Number(r.weight),
        report_date: r.report_date,
      })),
    }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/** 该基金的公告/资讯 */
export async function fetchFundAnnouncements(fundCode, limit = 20) {
  // 远端直抓：东财公告接口
  try {
    const { fetchFundNoticeRemote } = await import('../../data/sqlite_fetcher.ts')
    const remote = await fetchFundNoticeRemote(fundCode, Math.min(limit, 10))
    if (remote && remote.length > 0) {
      return { ok: true, data: remote.map(r => ({ title: r.title, pub_time: r.pub_time, url: r.url })) }
    }
  } catch { /* 回落本地 */ }
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const { listFundNews } = await import('../../core/news.ts')
    const rows = await listFundNews(_db, fundCode, limit)
    return {
      ok: true,
      data: rows.map(r => ({ title: r.title, pub_time: r.pub_time, url: r.url })),
    }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/**
 * 基金档案：申购状态 / 申购费率 / 分红方式 / 赎回状态。
 * funds 表 + fund_status 最新一条；查不到就给 null，调用方如实展示「未查询到」。
 */
export async function fetchFundArchive(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: null }
  try {
    const fundRows = await _db.query(
      `SELECT fund_code, fund_name, category, purchase_fee_rate, min_purchase, dividend_method, is_qdii
         FROM funds WHERE fund_code = ? LIMIT 1`,
      [fundCode],
    )
    const statusRows = await _db.query(
      `SELECT purchase_status, purchase_limit, raw_purchase, redeem_status, status_date
         FROM fund_status WHERE fund_code = ? ORDER BY status_date DESC LIMIT 1`,
      [fundCode],
    )
    const fund = fundRows[0] ?? null
    const status = statusRows[0] ?? null
    return {
      ok: true,
      data: {
        fund_code: fundCode,
        fund_name: fund?.fund_name ?? null,
        category: fund?.category ?? null,
        purchase_fee_rate: fund?.purchase_fee_rate ?? null,
        min_purchase: fund?.min_purchase ?? null,
        dividend_method: fund?.dividend_method ?? null,
        is_qdii: !!fund?.is_qdii,
        purchase_status: status?.purchase_status ?? status?.raw_purchase ?? null,
        purchase_limit: status?.purchase_limit ?? null,
        redeem_status: status?.redeem_status ?? null,
        status_date: status?.status_date ?? null,
      },
    }
  } catch (e) {
    return { ok: false, error: e.message, data: null }
  }
}

/** 分红公告标题关键词（本地只有标题与日期，不解析正文金额） */
const DIVIDEND_TITLE_RE = /分红|收益分配|派息/

/**
 * 催化事件：基金公告（东财远端直抓，回落本地 news_feed）+ 本地重仓股新闻。
 * 合并按发布时间倒序；分红公告单独抽出来给「分红记录」段用。
 */
export async function fetchFundCatalysts(fundCode, { limit = 20 } = {}) {
  const items = []
  const dividendAnnouncements = []
  try {
    const r = await fetchFundAnnouncements(fundCode, limit)
    for (const a of (r.ok ? r.data : [])) {
      items.push({ kind: 'announce', title: a.title, pub_time: a.pub_time, source: '基金公告' })
      if (DIVIDEND_TITLE_RE.test(a.title)) {
        dividendAnnouncements.push({ title: a.title, pub_time: a.pub_time })
      }
    }
  } catch { /* 公告抓不到 → 只有本地新闻，不留占位 */ }
  try {
    if (_db) {
      const { listFundNews } = await import('../../core/news.ts')
      const rows = await listFundNews(_db, fundCode, limit)
      for (const n of rows) {
        if (n.kind !== 'stock_news') continue
        items.push({ kind: 'stock_news', title: n.title, pub_time: n.pub_time, source: n.source || '重仓股新闻' })
      }
    }
  } catch { /* news_feed 未建 → 跳过，不连累分析 */ }
  return {
    ok: true,
    data: {
      catalysts: items,
      dividendAnnouncements,
    },
  }
}

/**
 * 六段式深度分析（本地代码规则，不调大模型）。
 * 净值包 / 回撤 / 持仓由调用方已拉到的数据传入，本函数只做组装与规则判定，
 * 防止重复查库；档案与催化事件内部现取。
 */
export async function buildDeepAnalysisReport(fundCode, {
  navBundle = null,
  drawdown = null,
  position = null,
  portfolioMv = null,
} = {}) {
  try {
    const [{ buildDeepAnalysis }, archiveR, catalystR] = await Promise.all([
      import('../../core/deep_analysis.ts'),
      fetchFundArchive(fundCode),
      fetchFundCatalysts(fundCode),
    ])
    const archive = archiveR.ok ? archiveR.data : null
    const cat = catalystR.ok ? catalystR.data : { catalysts: [], dividendAnnouncements: [] }
    const series = (navBundle?.series || []).map(p => ({
      date: p.date,
      nav: Number(p.nav) || 0,
      acc_nav: Number(p.acc_nav != null ? p.acc_nav : p.nav) || 0,
    }))
    const stats = navBundle?.stats || {}
    const report = buildDeepAnalysis({
      code: fundCode,
      series,
      stats: {
        ret_1m: stats.ret_1m ?? null,
        ret_3m: stats.ret_3m ?? null,
        ret_6m: stats.ret_6m ?? null,
        ret_1y: stats.ret_1y ?? null,
        annual_volatility_pct: stats.annual_vol ?? null,
        samples: stats.history_days ?? 0,
      },
      drawdown,
      position,
      portfolioMv,
      purchaseStatus: archive?.purchase_status ?? null,
      purchaseFeeRate: archive?.purchase_fee_rate ?? null,
      dividendMethod: archive?.dividend_method ?? null,
      dividendAnnouncements: cat.dividendAnnouncements || [],
      catalysts: cat.catalysts || [],
    })
    return { ok: true, data: report }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: null }
  }
}

/** 基金经理 */
export async function fetchFundManager(fundCode) {
  try {
    const { fetchFundManager: _fetch } = await import('../../data/sqlite_fetcher.ts')
    const m = await _fetch(fundCode, 12)
    return { ok: true, data: m }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), data: null }
  }
}

/**
 * 最新一次「兜底分析」结论。
 * 读 decision_log 里 source='fallback_analysis' 的最新一行，payload 是完整分析。
 */
export async function jsLatestFallbackAnalysis() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: null }
  try {
    const rows = await _db.query(
      `SELECT ts, reason, payload FROM decision_log
        WHERE source = 'fallback_analysis' ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    const row = rows[0]
    if (!row) return { ok: true, data: null }
    let fa = null
    try { fa = JSON.parse(row.payload) } catch { /* payload 解析失败给 null */ }
    return { ok: true, data: fa ? { ...fa, ts: row.ts, conclusion: row.reason || fa.conclusion } : null }
  } catch (e) {
    return { ok: false, error: e.message, data: null }
  }
}

/** 单只基金净值统计（收益/回撤/波动），复用 core/analysis.ts 的 navStats，读本地 nav_daily */
export async function jsNavStats(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: null }
  try {
    const { navStats } = await import('../../core/analysis.ts')
    const s = await navStats(_db, fundCode)
    return { ok: true, data: s }
  } catch (e) {
    return { ok: false, error: e.message, data: null }
  }
}

// ─── 资讯 / 情报 / 数据健康（本地读）──

/** 市场资讯（本地 market_news，由 RSS 抓取入库） */
export async function fetchMarketNewsList(limit = 20) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const { listMarketNews } = await import('../../core/rss_news.ts')
    const rows = await listMarketNews(_db, limit)
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/** 情报事件 + 摘要（本地 intel_events，由 intel_collector 从 market_news 提取） */
export async function fetchIntelList(limit = 20, sinceDays = 7) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: { events: [], summary: null } }
  try {
    const { listIntelEvents, intelSummary } = await import('../../core/intel_collector.ts')
    const [events, summary] = await Promise.all([
      listIntelEvents(_db, { limit }),
      intelSummary(_db, sinceDays),
    ])
    return { ok: true, data: { events, summary } }
  } catch (e) {
    return { ok: false, error: e.message, data: { events: [], summary: null } }
  }
}

/** 数据健康度：各表行数 + 抓取门槛时间 + 最近的抓取错误 */
export async function fetchDataHealth() {
  if (!_db) {
    console.warn('[health] _db 为空（真库尚未就绪）')
    return { ok: false, error: 'app_not_initialized', data: null }
  }
  try {
    const tables = ['funds', 'nav_daily', 'fund_status', 'news_feed', 'market_news', 'intel_events', 'fund_holdings', 'decision_log']
    const rows = []
    for (const t of tables) {
      let n = 0
      try {
        const r = await _db.query(`SELECT COUNT(*) AS n FROM ${t}`)
        n = Number(r[0]?.n ?? 0)
      } catch { n = -1 }   // -1 = 表不存在
      rows.push({ table: t, rows: n })
    }
    let meta = []
    try { meta = await _db.query(`SELECT key, value FROM pool_meta ORDER BY key`) } catch { meta = [] }
    const { getFetchErrors } = await import('../../data/sqlite_fetcher.ts')
    const errors = getFetchErrors()
    if (rows.length === 0) {
      console.warn('[health] 表清单为空（不应发生）')
    }
    return {
      ok: true,
      data: { tables: rows, meta, errors: errors.slice(-20) },
    }
  } catch (e) {
    console.warn('[health] fetchDataHealth 异常:', e && e.message ? e.message : String(e))
    return { ok: false, error: e.message, data: null }
  }
}

// ─── 持仓穿透分析 ──────────────────────────────────────

/**
 * 校验一只基金是否可在本系统交易（场外 vs 场内）。
 * @param {string} fundType  基金类型字段（如 '混合型'/'ETF联接'）
 * @param {string} fundName  基金名称
 */
export async function jsCheckTradable(fundType, fundName) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const [ok, reason] = checkTradable(fundType, fundName)
    return { ok: true, data: { tradable: ok, reason } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 分析单只基金的行业暴露（需先调用 fetchAndSaveIndustryAllocation）。
 * @param {string} fundCode
 */
export async function jsAnalyzeExposure(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const rows = await _db.query(
      `SELECT COALESCE(industry, stock_code) AS industry, weight, report_date FROM fund_holdings
       WHERE fund_code = ? AND source = 'industry_alloc'
       ORDER BY report_date DESC`,
      [fundCode],
    )
    const allocRows = rows.map(r => ({
      industry: r.industry,
      weight: r.weight,
      report_date: r.report_date,
    }))
    const report = analyzeExposure(fundCode, allocRows)
    return { ok: true, data: report }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 详情页用：取单只基金的**行业配置**（穿透明细）。
 * 先读库（fund_holdings · source='industry_alloc'）；库空则抓一次并落库。
 * 只返回**最新报告期**的行（季报口径），空数组表示抓不到（不编造）。
 * @param {string} fundCode
 * @param {{force?:boolean}} [opts] force=true 时忽略缓存直接重抓（「刷新」按钮）
 */
export async function jsFundIndustryAllocation(fundCode, opts = {}) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  const force = !!opts.force
  // industry 列较新；老行（若有）只有 stock_code，用 COALESCE 兼容
  const readRows = () => _db.query(
    `SELECT COALESCE(industry, stock_code) AS industry, weight, report_date FROM fund_holdings
     WHERE fund_code = ? AND source = 'industry_alloc'
     ORDER BY report_date DESC, weight DESC`,
    [fundCode],
  )
  try {
    let rows = force ? [] : await readRows()
    if (rows.length === 0) {
      const fetched = await fetchIndustryAllocation(fundCode, 25)
      if (fetched && fetched.length) {
        await saveHoldings(_db, fundCode, fetched, 'industry_alloc')
        rows = await readRows()
      }
    }
    if (rows.length === 0) return { ok: true, data: [] }
    const latest = rows[0].report_date
    const list = rows
      .filter(r => r.report_date === latest)
      .map(r => ({ industry: r.industry, weight: Number(r.weight) || 0 }))
      .filter(r => r.industry)
    return { ok: true, data: list, report_date: latest }
  } catch (e) {
    return { ok: false, error: e.message, data: [] }
  }
}

/**
 * 检测风格漂移（名称宣称 vs 实际持仓）。
 * @param {string} fundName
 * @param {Array<{industry, weight}>} allocation  来自 jsAnalyzeExposure.data.allocation
 */
export async function jsDetectStyleDrift(fundName, allocation) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const report = detectStyleDrift(fundName, allocation || [])
    return { ok: true, data: report }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 计算两只基金的重仓股重叠度。
 * @param {string} codeA
 * @param {string} codeB
 */
export async function jsCalcOverlap(codeA, codeB) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const rowsA = await _db.query(
      `SELECT stock_code, stock_name FROM fund_holdings
       WHERE fund_code = ? AND source = 'top_holdings'
       ORDER BY weight DESC LIMIT 10`, [codeA])
    const rowsB = await _db.query(
      `SELECT stock_code, stock_name FROM fund_holdings
       WHERE fund_code = ? AND source = 'top_holdings'
       ORDER BY weight DESC LIMIT 10`, [codeB])
    const holdingsA = rowsA.map(r => ({ stock_code: r.stock_code, stock_name: r.stock_name }))
    const holdingsB = rowsB.map(r => ({ stock_code: r.stock_code, stock_name: r.stock_name }))
    const report = calcOverlap(holdingsA, holdingsB)
    return { ok: true, data: report }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 抓取单只基金的行业配置 + 前十大重仓股，并写入 fund_holdings 表。
 * 返回 { industryCount, topHoldingsCount }。
 * @param {string} fundCode
 */
export async function jsFetchAndSaveHoldings(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const [indRows, topRows] = await Promise.all([
      fetchIndustryAllocation(fundCode, 30),
      fetchFundTopHoldings(fundCode, 30),
    ])
    const indCount = await saveHoldings(_db, fundCode, indRows, 'industry_alloc')
    const topCount = await saveHoldings(_db, fundCode, topRows, 'top_holdings')
    return { ok: true, data: { industryCount: indCount, topHoldingsCount: topCount } }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 规则引擎 bindings
// ═══════════════════════════════════════════════════════════════════════
//
// AI 在线 → 执行者（仅执行指令 + 风控拦截，不主动决策）
// AI 离线 → 决策者（按纪律线自主交易，时间敏感操作不漏）
//
// JS 层只负责把 _db 转给 TS 函数；所有阈值 / 阈值解读 / 浮盈和回撤的口径
// 都在 rules.ts，JS 不再重复实现。
// ───────────────────────────────────────────────────────────────────────

import {
  checkDiscipline as _checkDiscipline,
  penaltyRisk as _penaltyRisk,
  checkAccountStop as _checkAccountStop,
  runOfflineCycle as _runOfflineCycle,
} from '../../core/rules.ts'

/**
 * 检查单只基金是否触发纪律线（三条线：profit_take / drawdown_cut / admit_wrong）
 *
 * 必须同时传 currentNav 和 currentAccNav，缺任一 → 报错
 *
 * @param {string} fundCode
 * @param {number} currentNav       单位净值（用于浮盈 / 市值）
 * @param {number} currentAccNav    累计净值（用于回撤，避免误判分红）
 * @param {string} asOf             检查日期 YYYY-MM-DD
 * @param {number|null} benchmarkChangePct  同期基准涨跌幅（可选，admit_wrong 用）
 * @returns {Promise<{ok:true,data:DisciplineLine[]}|{ok:false,error:string}>}
 */
export async function jsCheckDiscipline(fundCode, currentNav, currentAccNav, asOf, benchmarkChangePct = null) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const lines = await _checkDiscipline(_db, fundCode, currentNav, currentAccNav, asOf, benchmarkChangePct)
    return { ok: true, data: lines }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 罚期检查（7 天惩罚性赎回费）
 * @returns {Promise<{ok:true,data:PenaltyRiskResult}|{ok:false,error:string}>}
 */
export async function jsPenaltyRisk(fundCode, asOf) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const r = await _penaltyRisk(_db, fundCode, asOf)
    return { ok: true, data: r }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 账户级回撤止损（峰值法；触发仅告警，不暂停自动交易）
 * @returns {Promise<{ok:true,data:AccountStopResult}|{ok:false,error:string}>}
 */
export async function jsCheckAccountStop() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const r = await _checkAccountStop(_db)
    return { ok: true, data: r }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 离线周期主入口（AI 不在线时由调度器调用）
 * @param {string[]} fundCodes
 * @param {string} asOf
 */
export async function jsRunOfflineCycle(fundCodes, asOf) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const r = await _runOfflineCycle(_db, fundCodes, asOf)
    return { ok: true, data: r }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 定投计划 bindings
// ═══════════════════════════════════════════════════════════════════════

import {
  listPlans as _listPlans,
  upsertPlan as _upsertPlan,
  togglePlan as _togglePlan,
  deletePlan as _deletePlan,
  executeDingtou as _executeDingtou,
} from '../../core/dingtou.ts'
import { timeWeightedReturn as _twr } from '../../core/portfolio.ts'
import { holdingReport as _holdingReport } from '../../core/ledger.ts'
import { appendManualIntel as _appendManualIntel } from '../../core/intel_collector.ts'

/** 定投计划列表 */
export async function jsDingtouList() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try { return { ok: true, data: await _listPlans(_db) } }
  catch (e) { return { ok: false, error: e.message, data: [] } }
}

/** 新增 / 更新定投计划（同一 fund_code + frequency 唯一） */
export async function jsDingtouUpsert(plan) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { await _upsertPlan(_db, plan); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
}

export async function jsDingtouToggle(id, enabled) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { await _togglePlan(_db, id, enabled); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
}

export async function jsDingtouDelete(id) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { await _deletePlan(_db, id); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
}

/** 立即执行一次到期定投（幂等；已紧急暂停则整体跳过） */
export async function jsRunDingtou(asOf) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const stop = await jsEmergencyStopGet()
    const r = await _executeDingtou(_db, asOf, { emergencyStop: !!stop.data })
    return { ok: true, data: r }
  } catch (e) { return { ok: false, error: e.message } }
}

/** 单基金时间加权收益率（TWR，累计净值口径） */
export async function jsTwr(fundCode) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _twr(_db, fundCode) } }
  catch (e) { return { ok: false, error: e.message } }
}

/** 持仓批次报告（含罚期：fee_rate / is_penalty / days_to_penalty_free） */
export async function jsHoldingReport(fundCode, asOf) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try { return { ok: true, data: await _holdingReport(_db, fundCode, asOf) } }
  catch (e) { return { ok: false, error: e.message, data: [] } }
}

/**
 * 组合风险分析：持仓集中度 + 行业暴露。只分析真实持仓（截图导入）。
 * @returns {Promise<{ok, data: RiskReport, error?}>}
 */
export async function jsRiskReport() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await riskReport(_db) } }
  catch (e) { return { ok: false, error: e?.message || String(e) } }
}

// ── 再平衡提醒 ────────────────────────────────────────
/** 再平衡报告：真实持仓实际占比 vs 目标占比 + 偏离 + 调仓建议 */
export async function jsRebalanceReport() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _rebalanceReport(_db) } }
  catch (e) { return { ok: false, error: e?.message || String(e) } }
}

/** 目标权重：Map → 普通对象 { fund_code: weight }，方便 UI 编辑 */
export async function jsRebalanceTargetsGet() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: {} }
  try {
    const m = await _loadTargets(_db)
    const obj = {}
    for (const [k, v] of m.entries()) obj[k] = v
    return { ok: true, data: obj }
  } catch (e) { return { ok: false, error: e.message, data: {} } }
}

/** 保存目标权重（传全部真实持仓基金的目标，空/0 = 未设） */
export async function jsRebalanceTargetsSave(rows) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { await _saveTargets(_db, rows || []); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
}

/** 再平衡提醒记录 */
export async function jsRebalanceHistory() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try { return { ok: true, data: await _listRebalanceHistory(_db) } }
  catch (e) { return { ok: false, error: e.message, data: [] } }
}

/** 评估是否需要提醒（need_rebalance 且过冷却 → 记一条记录，上层据返回发通知） */
export async function jsEvaluateRebalance() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const r = await _evaluateRebalance(_db)
    return { ok: true, data: r }
  } catch (e) { return { ok: false, error: e?.message || String(e) } }
}

// ── 目标规划 ──────────────────────────────────────────
/** 目标报告：目标列表 + 当前本金（真实持仓市值）+ 逐目标推算（达成额/缺口/每月需投） */
export async function jsGoalReport() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _goalReport(_db) } }
  catch (e) { return { ok: false, error: e?.message || String(e) } }
}

/** 新增/更新目标（有 id = 更新） */
export async function jsGoalUpsert(goal) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { const id = await _upsertGoal(_db, goal); return { ok: true, data: { id } } }
  catch (e) { return { ok: false, error: e.message } }
}

export async function jsGoalDelete(id) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { await _deleteGoal(_db, id); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
}

/** 情报手动补录 */
export async function jsAppendIntel(form) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const boards = typeof form.impact_boards === 'string'
      ? form.impact_boards.split(/[,，\s]+/).filter(Boolean)
      : (form.impact_boards || [])
    const r = await _appendManualIntel(_db, { ...form, impact_boards: boards })
    return { ok: true, data: r }
  } catch (e) { return { ok: false, error: e.message } }
}

// ═══════════════════════════════════════════════════════════════════════
// 可编辑设置 + 紧急暂停（app_settings 表；缺省用默认值）
// ═══════════════════════════════════════════════════════════════════════

export const SETTINGS_DEFAULTS = {
  mode: 'auto',                  // auto | rule | external
  heartbeat_timeout_hours: 24,   // AI 心跳超时（小时）
  max_amount_per_order: 5000,    // 单笔金额上限（元）
  max_orders_per_day: 10,        // 单日下单次数上限
  // ── 纪律线参数用户可调，只提示不拦截 ──
  discipline_profit_take: 20,    // 浮盈到 X% 提醒兑现（%）
  discipline_drawdown_cut: 15,   // 从高点回落 X% 提醒减仓（%）
  discipline_stop_loss: -5,      // 亏损 X% 提醒认错离场（%）
  discipline_lookback: 60,       // 回看天数（找近期高点）
  risk_account_stop_pct: 20,     // 账户整体从高点跌 X% 弹提醒（%）
  pos_max_single_pct: 25,        // 单只基金超过总资产 X% 提醒集中（%，仅提醒）
  pos_min_step: 100,             // 建议加仓步长（元）
  purchase_discount: 0.125,      // 申购费折扣（0~1；源数据已折后，此项仅记录）
}

export async function jsSettingsGet() {
  const out = { ...SETTINGS_DEFAULTS }
  if (!_db) return { ok: false, error: 'app_not_initialized', data: out }
  try {
    const rows = await _db.query('SELECT key, value FROM app_settings')
    for (const r of rows) {
      const k = r.key
      if (!(k in out)) continue
      out[k] = typeof SETTINGS_DEFAULTS[k] === 'number' ? Number(r.value) : String(r.value)
    }
    return { ok: true, data: out }
  } catch (e) { return { ok: false, error: e.message, data: out } }
}

export async function jsSettingsSet(obj) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    for (const [k, v] of Object.entries(obj || {})) {
      await _db.run(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [k, String(v), now],
      )
    }
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
}

/** 紧急暂停状态（1=已暂停，自动交易/定投全部停） */
export async function jsEmergencyStopGet() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: false }
  try {
    const rows = await _db.query("SELECT value FROM app_settings WHERE key='emergency_stop'")
    return { ok: true, data: rows[0]?.value === '1' }
  } catch (e) { return { ok: false, error: e.message, data: false } }
}

export async function jsEmergencyStopSet(on) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    await jsSettingsSet({ emergency_stop: on ? '1' : '0' })
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
}

// ═══════════════════════════════════════════════════════════════════════
// 组合每日快照（组合资产曲线的数据源）+ 外链打开
// ═══════════════════════════════════════════════════════════════════════

/** 记录今天的组合快照（幂等：同一天覆盖）。走核心 takeSnapshot，写全字段。 */
export async function recordPortfolioSnapshot(asOf) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const r = await _takeSnapshot(_db, asOf)
    return { ok: true, data: { date: r.snap_date, total: r.total_assets } }
  } catch (e) { return { ok: false, error: e.message } }
}

/** 组合资产曲线（按日期升序） */
export async function fetchPortfolioCurve(limit = 180, source = 'trade') {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    // 结构隔离：快照按 source 取（legacy 历史混账行不参与）
    const rows = await _db.query(
      `SELECT snap_date, total_assets FROM portfolio_daily WHERE source = ? ORDER BY snap_date ASC LIMIT ?`,
      [source, limit],
    )
    return { ok: true, data: rows }
  } catch (e) { return { ok: false, error: e.message, data: [] } }
}

/** 用系统浏览器打开外链（公告 / 资讯原文） */
export async function openExternal(url) {
  if (!url) return { ok: false, error: 'empty_url' }
  try {
    const mod = await import('@capacitor/browser')
    const Browser = mod && mod.Browser
    if (Browser && Browser.open) {
      await Browser.open({ url })
      return { ok: true }
    }
  } catch { /* 回退到 window.open */ }
  try {
    if (typeof window !== 'undefined' && window.open) { window.open(url, '_blank'); return { ok: true } }
  } catch { /* ignore */ }
  return { ok: false, error: 'open_failed' }
}

// ═══════════════════════════════════════════════════════════════════════
// 全模块桥接：筛选 / AI / 汇率 / 宏观 / 分红 / 协调 / 简报 / 新闻质量 /
//   分拣 / 板块新闻 / 健康 / 巡检 / 规则观察 / 审计 / 监控 / 归档 /
//   回顾 / 滞后信号 / 关键词 / 时滞 / 组合快照
// ═══════════════════════════════════════════════════════════════════════

import { screenAll as _screenAll, getPoolStats as _getPoolStats, buildCandidates as _buildCandidates } from '../../core/screener.ts'
import { evaluateFund as _evaluateFund, evaluateMany as _evaluateMany } from '../../core/screen_rules.ts'
import { chat as _llmChat, loadLlmConfig as _loadLlmConfig, isConfigured as _llmIsConfigured, simpleChat as _simpleChat } from '../../core/llm_client.ts'
import { poolStatus as _llmPoolStatus, callLlm as _callLlm } from '../../core/llm_pool.ts'
import { getTools as _getAiTools, callTool as _callAiTool } from '../../core/ai_tools.ts'
import { latestUsdCny as _latestUsdCny, getFxRate as _getFxRate, recordFx as _recordFx } from '../../core/fx.ts'
import { getMacro as _getMacro } from '../../core/macro_data.ts'
import { resolveAlias as _resolveAlias } from '../../core/board_alias.ts'
import { getDividendMethod as _getDivMethod, setDividendMethod as _setDivMethod, detectDividends as _detectDividends, processDividends as _processDividends, listDividends as _listDividends } from '../../core/dividend.ts'
import { status as _coordStatus, touchHeartbeat as _touchHeartbeat, isEmergencyStop as _isEstop, setEmergencyStop as _setEstop } from '../../core/coordinator.ts'
import { generate as _genBriefing, toMarkdown as _briefingMd } from '../../core/briefing.ts'
import { getActiveNews as _getActiveNews } from '../../core/active_news.ts'
import { getFlashNews as _getFlashNews } from '../../core/flash_news.ts'
import { getLowQuality as _getLowQuality, scoreQuality as _scoreQuality } from '../../core/news_quality.ts'
import { triageNews as _triageNews, getTriage as _getTriage, runTriage as _runTriage } from '../../core/triage.ts'
import { getSectorNews as _getSectorNews, refreshSectorNews as _refreshSectorNews } from '../../core/sector_news.ts'
import { runHealthCheck as _runHealthCheck, checkNavHealth as _checkNavHealth, detectAnomalies as _detectAnomalies } from '../../core/health.ts'
import { runInspection as _runInspection, getInspection as _getInspection } from '../../core/inspector.ts'
import { watchRules as _watchRules, getRuleChanges as _getRuleChanges, watchPurchaseStatus as _watchPurchaseStatus, redeemTiersOf as _redeemTiersOf } from '../../core/rule_watch.ts'
import { auditLog as _auditLog, getAudit as _getAudit } from '../../core/audit.ts'
import { monitorPositions as _monitorPositions } from '../../core/monitor.ts'
import { corpusStats as _corpusStats } from '../../core/corpus.ts'
import { reviewPortfolioSummary as _reviewSummary, getPerformanceHistory as _perfHistory, generateReviewReport as _reviewReport, buildReview as _buildReview, buildCalibration as _buildCalibration } from '../../core/review.ts'
import { detectValleySignals as _valleySignals, detectTrendReversal as _trendReversal } from '../../core/lag.ts'
import { extractEventKeys as _extractEventKeys } from '../../core/event_key.ts'
import { detectTimeLag as _detectTimeLag } from '../../core/time_lag.ts'
import { takeSnapshot as _takeSnapshot, curve as _curve, getPortfolioSummary as _portfolioSummary } from '../../core/portfolio.ts'

// 通用包装：统一 {ok, data, error} 形态
async function _wrap(fn, fallback = null) {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: fallback }
  try { return { ok: true, data: await fn(_db) } }
  catch (e) { return { ok: false, error: e?.message || String(e), data: fallback } }
}

// ── 筛选（项目唯一目的）────────────────────────────
export const jsScreenAll = (opts) => _wrap(db => _screenAll(db, opts), [])
export const jsPoolStats = () => _wrap(db => _getPoolStats(db), {})
export const jsBuildCandidates = (days, topN) => _wrap(db => _buildCandidates(db, days, topN), { themes: [] })
export const jsEvaluateFund = (code) => _wrap(db => _evaluateFund(db, code), null)
export const jsEvaluateMany = (codes) => _wrap(db => _evaluateMany(db, codes), [])

// ── AI ───────────────────────────────────────
export async function jsLlmStatus() { return _wrap(db => _llmPoolStatus(db), {}) }
export async function jsLlmGetConfig() { return _wrap(db => _loadLlmConfig(db), {}) }
export async function jsLlmChat(messages, temperature) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const cfg = await _loadLlmConfig(_db)
    const r = await _llmChat(cfg, messages, temperature)
    return { ok: !r.error, data: r, error: r.error }
  } catch (e) { return { ok: false, error: e.message } }
}
export async function jsLlmSimpleChat(prompt, context = '') {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _callLlm(_db, prompt, context) } }
  catch (e) { return { ok: false, error: e.message } }
}
export async function jsAiTools() { return { ok: true, data: _getAiTools() } }
export async function jsAiCallTool(name, params) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _callAiTool(_db, name, params) } }
  catch (e) { return { ok: false, error: e.message } }
}

// ── 汇率 / 宏观 / 板块别名 ─────────────────────────
export const jsFxLatest = () => _wrap(db => _latestUsdCny(db), {})
export const jsFxGet = (pair, date) => _wrap(db => _getFxRate(db, pair, date), {})
export const jsMacroGet = () => _wrap(db => _getMacro(db), {})
export function jsResolveAlias(name) { try { return { ok: true, data: _resolveAlias(name) } } catch (e) { return { ok: false, error: e.message } } }

// ── 分红 ───────────────────────────────────────────
export const jsDividendMethodGet = (code) => _wrap(db => _getDivMethod(db, code), 'cash')
export async function jsDividendMethodSet(code, method) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _setDivMethod(_db, code, method) } }
  catch (e) { return { ok: false, error: e.message } }
}
export const jsDetectDividends = (code, gap) => _wrap(db => _detectDividends(db, code, gap), [])
export const jsProcessDividends = (code) => _wrap(db => _processDividends(db, code), {})
export const jsListDividends = (limit) => _wrap(db => _listDividends(db, limit), [])

/** 一次性处理所有当前持仓基金的分红识别与落账（幂等）。 */
export async function jsRefreshDividends() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const held = await _db.query(
      // 结构隔离：两套系统的持仓都要跑分红（显式取并集）
      "SELECT DISTINCT fund_code FROM lots WHERE status='active' AND remaining_shares>0 AND source IN ('real','trade')",
      [],
    )
    let processed = 0
    for (const { fund_code } of held) {
      try { await _processDividends(_db, fund_code); processed++ }
      catch (e) { pushFetchError(`jsRefreshDividends(${fund_code}): ${e?.message ?? String(e)}`) }
    }
    return { ok: true, data: { funds: held.length, processed } }
  } catch (e) { return { ok: false, error: e.message } }
}

/** 分红跟踪报表：汇总 + 每条分红事件对应的用户实际到账金额 / 红利再投份额。
 *  汇总取真实落账：cash_ledger(action='dividend') 的 SUM = 累计现金分红；
 *  orders(order_id LIKE 'D%') 的 SUM(filled_shares) = 红利再投累计份额。 */
export async function jsDividendReport() {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try {
    const rows = await _db.query(`
      SELECT d.fund_code            AS fund_code,
             COALESCE(f.fund_name, d.fund_code) AS fund_name,
             d.ex_date              AS ex_date,
             d.dividend_per_share   AS dividend_per_share,
             d.reinvest             AS reinvest,
             COALESCE(cl.amount, 0) AS cash_amount,
             COALESCE(o.filled_shares, 0) AS reinvest_shares
      FROM dividends d
      LEFT JOIN funds f ON f.fund_code = d.fund_code
      LEFT JOIN cash_ledger cl ON cl.action='dividend'
            AND cl.fund_code = d.fund_code
            AND cl.memo = d.fund_code || ' ' || d.ex_date || ' 现金分红到账'
      LEFT JOIN orders o ON o.order_id LIKE 'D%'
            AND o.fund_code = d.fund_code
            AND o.reason LIKE '%' || d.ex_date || ' 除息%'
      ORDER BY d.ex_date DESC, d.id DESC
    `, [])
    const sum = await _db.query(`
      SELECT
        (SELECT COALESCE(SUM(amount),0)        FROM cash_ledger WHERE action='dividend') AS cash_total,
        (SELECT COALESCE(SUM(filled_shares),0) FROM orders      WHERE order_id LIKE 'D%') AS reinvest_shares_total,
        (SELECT COUNT(*)                       FROM dividends)  AS event_count,
        (SELECT COUNT(DISTINCT fund_code)      FROM dividends)  AS fund_count
    `, [])
    return { ok: true, data: { rows, summary: sum[0] || {} } }
  } catch (e) { return { ok: false, error: e.message } }
}

// ── 协调（心跳 / 模式 / 紧急停止）───────────────────
export const jsCoordStatus = () => _wrap(db => _coordStatus(db), {})
export const jsTouchHeartbeat = (source, note) => _wrap(db => _touchHeartbeat(db, source, note), {})

// ── 决策简报 ───────────────────────────────────────
export const jsGenerateBriefing = (asOf, question) => _wrap(db => _genBriefing(db, asOf, question), {})
export function jsBriefingMarkdown(b) { try { return { ok: true, data: _briefingMd(b) } } catch (e) { return { ok: false, error: e.message } } }

// ── 新闻（活跃 / 快讯 / 质量）──────────────────────
export const jsActiveNews = (limit) => _wrap(db => _getActiveNews(db, limit), [])
export const jsFlashNews = (limit) => _wrap(db => _getFlashNews(db, limit), [])
export const jsLowQuality = (limit) => _wrap(db => _getLowQuality(db, limit), [])
export function jsScoreQuality(item) { try { return { ok: true, data: _scoreQuality(item) } } catch (e) { return { ok: false, error: e.message } } }

// ── 新闻分拣 ───────────────────────────────────────
export function jsTriageNews(text, category) { try { return { ok: true, data: _triageNews(text, category) } } catch (e) { return { ok: false, error: e.message } } }
export const jsGetTriage = (category, limit) => _wrap(db => _getTriage(db, category, limit), [])
export const jsRunTriage = () => _wrap(db => _runTriage(db), {})

// ── 板块新闻 ───────────────────────────────────────
export const jsGetSectorNews = (boardType, limit) => _wrap(db => _getSectorNews(db, boardType, limit), [])
export async function jsRefreshSectorNews(boards) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _refreshSectorNews(_db, boards) } }
  catch (e) { return { ok: false, error: e.message } }
}

// ── 健康 / 巡检 ────────────────────────────────────
export const jsRunHealthCheck = () => _wrap(db => _runHealthCheck(db), {})
export const jsCheckNavHealth = (code) => _wrap(db => _checkNavHealth(db, code), {})
export const jsDetectAnomalies = (code, window) => _wrap(db => _detectAnomalies(db, code, window), [])
export const jsRunInspection = () => _wrap(db => _runInspection(db), {})
export const jsGetInspection = (limit) => _wrap(db => _getInspection(db, limit), [])

// ── 规则观察 ───────────────────────────────────────
export const jsWatchRules = () => _wrap(db => _watchRules(db), [])
export const jsGetRuleChanges = (limit) => _wrap(db => _getRuleChanges(db, limit), [])
export async function jsWatchPurchaseStatus(codes) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _watchPurchaseStatus(_db, codes) } }
  catch (e) { return { ok: false, error: e.message } }
}
export const jsRedeemTiersOf = (code) => _wrap(db => _redeemTiersOf(db, code), null)

// ── 审计 / 监控 / 归档 ─────────────────────────────
export async function jsAuditLog(action, detail) {
  if (!_db) return { ok: false, error: 'app_not_initialized' }
  try { return { ok: true, data: await _auditLog(_db, action, detail) } }
  catch (e) { return { ok: false, error: e.message } }
}
export const jsGetAudit = (limit) => _wrap(db => _getAudit(db, limit), [])
export const jsMonitorPositions = () => _wrap(db => _monitorPositions(db), {})
export const jsCorpusStats = () => _wrap(db => _corpusStats(db), {})

// ── 回顾 ───────────────────────────────────────────
export const jsReviewSummary = () => _wrap(db => _reviewSummary(db), {})
export const jsPerformanceHistory = (days) => _wrap(db => _perfHistory(db, 'trade', days), [])
export const jsReviewReport = (period) => _wrap(db => _reviewReport(db, 'trade', period), {})
export const jsBuildReview = (days, topN) => _wrap(db => _buildReview(db, days, topN), { items: [] })
export const jsBuildCalibration = (days, topN) => _wrap(db => _buildCalibration(db, days, topN), {})

// ── 滞后信号 ───────────────────────────────────────
export const jsDetectValleySignals = (minDays) => _wrap(db => _valleySignals(db, minDays), [])
export const jsDetectTrendReversal = (code, window) => _wrap(db => _trendReversal(db, code, window), {})

// ── 关键词 / 时滞（纯函数）──────────────────────────
export function jsExtractEventKeys(text) { try { return { ok: true, data: _extractEventKeys(text) } } catch (e) { return { ok: false, error: e.message } } }
export function jsDetectTimeLag(events) { try { return { ok: true, data: _detectTimeLag(events) } } catch (e) { return { ok: false, error: e.message } } }

// ── 组合（快照 / 曲线 / 概要）──────────────────────
export const jsTakeSnapshot = (snapDate) => _wrap(db => _takeSnapshot(db, snapDate), {})
export const jsPortfolioCurve = (limit) => _wrap(db => _curve(db, limit), {})
export const jsPortfolioSummary = () => _wrap(db => _portfolioSummary(db), {})

// ── 涨跌 / 净值预警 ────────────────────────────────
export const ALERT_KIND_META = ALERT_KINDS
export const fetchAlerts = () => _wrap(db => _listAlerts(db), [])
export const fetchAlertHistory = () => _wrap(db => _listHistory(db, 50), [])
export const jsAddAlert = (payload) => _wrap(db => _addAlert(db, payload), {})
export const jsDeleteAlert = (id) => _wrap(db => _deleteAlert(db, id), {})

/**
 * 评估所有预警并（权限允许时）发本地通知。
 * 返回本次新触发的列表；权限被拒不报错，仅不弹通知（触发记录仍落库）。
 */
export async function jsEvaluateAlerts() {
  if (!_db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const triggered = await _evaluateAlerts(_db, { cooldownHours: 24 })
    if (triggered.length) {
      try { await _notifyTriggered(triggered) } catch (e) {
        console.warn('[alerts] 通知发送失败（不影响记录）:', e?.message || e)
      }
    }
    return { ok: true, data: triggered }
  } catch (e) {
    return { ok: false, error: e?.message || String(e), data: [] }
  }
}

/** 把触发的预警排成系统本地通知（需用户授权；授权被拒则静默跳过） */
async function _notifyTriggered(triggered) {
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  const perm = await LocalNotifications.checkPermissions()
  if (perm.display !== 'granted') {
    const req = await LocalNotifications.requestPermissions()
    if (req.display !== 'granted') return
  }
  const base = Date.now()
  await LocalNotifications.schedule({
    notifications: triggered.map((t, i) => {
      const k = ALERT_KINDS[t.kind]
      const val = t.kind.startsWith('nav')
        ? Number(t.triggered_value).toFixed(4)
        : Number(t.triggered_value).toFixed(2) + '%'
      // ⚠️ 不要传 schedule.at：原生层 triggerScheduledNotification 判断
      //    `at < now` 即 return（Logger.error "Scheduled time must be *after* current time"），
      //    而 JS→原生 IPC 有延迟，at 必然 <= 原生当前时间 → 通知永远不显示。
      //    即时通知应不传 schedule，走 notificationManager.notify() 立即显示。
      return {
        id: 700000 + (base % 100000) + i,   // 70 开头，避开其他通知 id
        title: `${t.fund_name || t.fund_code} 触发预警`,
        body: `${k?.label || '预警'} ${t.threshold}${k?.unit || ''}：当前 ${val}`,
        extra: { fundCode: t.fund_code },
      }
    }),
  })
}