// ─── 真机 SQLite 适配器 ─────────────────────────────────────
// 替代内存 MemoryBudgetDb / MemoryLedgerDb：
//   - 真机 Android：用 @capacitor-community/sqlite
//   - 浏览器/web 测试：返回 null，调用方继续走内存兜底
//
// LedgerDb 接口（src/core/ledger.ts:43-50）：
//   run(sql, params?) => { lastInsertId }
//   query<T>(sql, params?) => T[]
//   transaction<T>(fn) => T
import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import type { LedgerDb } from '../core/ledger.ts'
import { ensureTables } from './sqlite_schema.ts'

const DB_NAME = 'fund_app'

let _sqliteConn: SQLiteConnection | null = null
let _ledgerAdapter: LedgerDb | null = null
let _txnDepth = 0 // 嵌套事务深度，避免在已开启事务内重复 BEGIN

/**
 * 真机环境探测。
 * - Android：capacitor 容器，platform = 'android'
 * - 浏览器开发：platform = 'web'
 * - iOS / electron：未在本项目支持范围
 */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/**
 * 打开/创建 fund_app.db，建表，返回 LedgerDb 实例。
 * 非原生平台（浏览器）返回 null，调用方走 MemoryBudgetDb。
 */
export async function openNativeDb(): Promise<LedgerDb | null> {
  if (!isNativePlatform()) {
    console.log('[sqlite] 非原生平台，跳过真 SQLite 初始化（继续用内存兜底）')
    return null
  }
  if (_ledgerAdapter) return _ledgerAdapter

  console.log('[sqlite] 真机 Android，启动 SQLiteConnection ...')
  try {
    _sqliteConn = new SQLiteConnection(CapacitorSQLite)
    // 热重载/重启时，底层连接可能已存在 → 复用，避免 "already exists" 错误
    const existing = await _sqliteConn.isConnection(DB_NAME, false)
    let dbRes: Awaited<ReturnType<typeof _sqliteConn.createConnection>>
    if (existing.result) {
      console.log(`[sqlite] 连接 ${DB_NAME} 已存在，复用`)
      dbRes = await _sqliteConn.retrieveConnection(DB_NAME, false)
    } else {
      dbRes = await _sqliteConn.createConnection(DB_NAME, false, 'no-encryption', 1, false)
    }
    await dbRes.open()
    console.log('[sqlite] 库连接已打开，调用 ensureTables 建表 ...')

    // 建表（10 张表 + market_meta）
    await ensureTables(async (sql: string) => {
      // 迁移里会用 SELECT / PRAGMA 探测列是否存在（如 pragma_table_info），
      // 这类语句必须走 query 通道（execute 不支持查询）。
      if (/^\s*(select|pragma)/i.test(sql)) {
        return await dbRes.query(sql)
      }
      const r = await dbRes.execute(sql, false)
      if (r.changes && (r.changes.changes ?? 0) < 0) {
        console.warn('[sqlite] 建表返回 changes < 0，sql=', sql.slice(0, 60))
      }
      return r
    })
    console.log('[sqlite] 建表完成')

    // 自检：查询每张表行数，方便观察
    for (const t of ['funds', 'nav_daily', 'fund_status', 'orders', 'lots', 'cash_ledger', 'quota_usage', 'news_feed', 'market_news', 'intel_events', 'pool_meta', 'market_meta', 'monthly_budget', 'fund_holdings', 'fund_code_correction_log']) {
      try {
        const r = await dbRes.query(`SELECT COUNT(*) AS n FROM ${t}`)
        const n = r.values?.[0]?.n ?? 0
        console.log(`[sqlite] 自检 ${t}: ${n} 行`)
      } catch (e) {
        console.warn(`[sqlite] 自检 ${t} 失败:`, (e as Error).message)
      }
    }

    // 适配成 LedgerDb 接口
    _ledgerAdapter = {
      // 标记位：init_app.ts 用 '_sqliteBackend' in db 来区分真机 SQLite / 内存 mock
      _sqliteBackend: true,
      async run(sql: string, params: unknown[] = []) {
        const r = await dbRes.run(sql, params, false)
        return { lastInsertId: r.changes?.lastId ?? 0 }
      },
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const r = await dbRes.query(sql, params)
        return (r.values ?? []) as T[]
      },
      async transaction<T>(fn: (tx: LedgerDb) => Promise<T>): Promise<T> {
        _txnDepth++
        try {
          // 已在事务中（深度>1）：直接执行，不做嵌套 BEGIN
          if (_txnDepth > 1) return await fn(_ledgerAdapter as LedgerDb)
          // @capacitor-community/sqlite 的 `dbRes.transaction(fn)` **不会把连接作为参数
          //   传给 fn**（真机报 TypeError: Cannot read properties of undefined (reading 'run')），
          //   而 core 层回调签名是 `async (tx) => tx.run(...)` —— 于是「确认订单」永远成功不了。
          //   这里显式把适配器自身当作 tx 传进去，不再依赖底层透传。
          const txArg = _ledgerAdapter as LedgerDb
          try {
            return await (dbRes as unknown as { transaction?: (fn: () => Promise<T>) => Promise<T> }).transaction
              ? await (dbRes as unknown as { transaction: (fn: () => Promise<T>) => Promise<T> }).transaction(() => fn(txArg))
              : await _manualTransaction(() => fn(txArg), dbRes)
          } finally {
            _txnDepth--
          }
        } catch (e) {
          _txnDepth--
          throw e
        }
      },
    }
    return _ledgerAdapter
  } catch (e) {
    console.error('[sqlite] openNativeDb 失败:', (e as Error).message)
    // 不静默吞：抛给上层（dataAdapter.js）→ pushFetchError → _errors → UI 可见
    throw new Error(`[openNativeDb] ${(e as Error).message}`)
  }
}

async function _manualTransaction<T>(fn: () => Promise<T>, dbRes: Awaited<ReturnType<SQLiteConnection['createConnection']>>): Promise<T> {
  await dbRes.execute('BEGIN', false)
  try {
    const result = await fn()
    await dbRes.execute('COMMIT', false)
    return result
  } catch (e) {
    await dbRes.execute('ROLLBACK', false).catch(() => {})
    throw e
  }
}

/**
 * 自检：返回各表的真实落库条数（用于 UI 显示）
 */
export async function getDbStats(db: LedgerDb): Promise<Record<string, number>> {
  const tables = ['funds', 'nav_daily', 'fund_status', 'orders', 'lots', 'cash_ledger', 'quota_usage', 'news_feed', 'market_news', 'intel_events', 'market_meta', 'pool_meta', 'monthly_budget', 'fund_holdings']
  const out: Record<string, number> = {}
  for (const t of tables) {
    try {
      const r = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)
      out[t] = Number(r[0]?.n ?? 0)
    } catch (e) {
      out[t] = -1
    }
  }
  return out
}

/**
 * 调试行文本：funds/nav_daily/orders/cash_ledger 的真实行数
 */
export async function formatDbStats(db: LedgerDb): Promise<string> {
  const stats = await getDbStats(db)
  return `funds=${stats.funds} nav=${stats.nav_daily} orders=${stats.orders} cash=${stats.cash_ledger}`
}

/**
 * 取某表前 N 行（用于「导出诊断」页面）
 */
export async function selectTopN(db: LedgerDb, table: string, n = 10): Promise<Record<string, unknown>[]> {
  if (!/^[a-z_]+$/i.test(table)) return []
  return await db.query(`SELECT * FROM ${table} LIMIT ${n}`)
}