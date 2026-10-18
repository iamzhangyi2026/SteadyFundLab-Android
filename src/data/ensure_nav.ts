/**
 * ensureFundNav —— 确保某只基金的净值已入库（抓取 + 落库）。
 *
 * 首批净值只覆盖种子基金（init_app.ts 取前 5 只），与持仓无关：
 * 下单确认后 `nav_daily` 里可能仍没有这只基金的净值，详情页 / 净值曲线 /
 * 分析页读本地库会全空（持仓列表的净值涨跌来自列表接口快照，看着正常）。
 *
 * 本函数给「买入确认」这类路径用：确认成功后补抓一次，fire-and-forget，
 * **失败只记录、不抛出**（抓取失败不能连累下单结果）。
 */

import { fetchFundNavList } from './sqlite_fetcher.ts'

/** 只声明用到的 db 能力，避免和 core 层类型互相牵扯。 */
interface NavDb {
  run: (sql: string, params?: unknown[]) => Promise<unknown>
}

/**
 * 抓取并落库单只基金净值，返回落库条数（0 = 没抓到或全失败）。
 *
 * @param db      带 `run` 的 db 句柄（如 orders 的 `OrderDb`）
 * @param fundCode 基金代码
 * @param timeoutSec 单次抓取超时（秒），默认 15
 */
export async function ensureFundNav(
  db: NavDb,
  fundCode: string,
  timeoutSec = 15,
): Promise<number> {
  const code = String(fundCode || '').trim()
  if (!code) return 0

  const navs = await fetchFundNavList(code, timeoutSec)
  if (!navs.length) return 0

  const ROWS = 150 // 与 init_app 一致：多行 INSERT，参数 < SQLite 999 上限
  let inserted = 0
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
      inserted += batch.length
    } catch {
      // 多行失败 → 逐条兜底（坏数据不拖累其余行）
      for (const nv of batch) {
        try {
          await db.run(
            `INSERT OR REPLACE INTO nav_daily (fund_code, nav_date, nav, acc_nav) VALUES (?, ?, ?, ?)`,
            [nv.fund_code, nv.nav_date, nv.nav, nv.nav_acc],
          )
          inserted++
        } catch {
          // 抓取侧失败已由 pushFetchError 记录；这里不再重复报
        }
      }
    }
  }
  return inserted
}
