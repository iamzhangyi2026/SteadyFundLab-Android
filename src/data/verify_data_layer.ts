/**
 * 自测脚本 · 数据层
 *
 * 用内存 mock（MemoryBudgetDb + fake HttpDriver）跑完整启动流程，验证：
 *   1. 建表（funds / nav_daily / orders / lots / cash_ledger / fund_status / quota_usage）
 *   2. 注入 fetcher → 抓到几条基金 + 净值
 *   3. 落库 funds / nav_daily 有行
 *   4. 起购线生效：低于 min_purchase 被拒（提示含「起购」）
 *   5. 限购生效：limited 且超额 → 被拒
 *   6. 口径：成交份额按 nav 算（不用 acc_nav）
 *
 * 真机验证：在 React 端运行 npm run android:build → 装手机 → 打开 App
 * 本脚本负责上述 6 项中的代码层不变量
 */
import { MemoryBudgetDb, setLedgerDb, setOrderDb } from '../core/budget.ts'
import {
  setStatusFetcher, fetchAndSave, type StatusSnapshot,
} from '../core/status.ts'
import {
  setFundPoolFetcher, getNameDf, getPurchaseDf, refreshMarketData,
  lookupPurchaseAsync, _localCacheGet, _localCacheSet,
} from '../core/fund_pool.ts'
import {
  checkBeforeSubmit, submitOrder, confirmOrder,
  type ConfirmResult,
} from '../core/orders.ts'
import { getBudget } from '../core/budget.ts'
import {
  setHttpDriver, fetchFundNameList, fetchFundPurchaseList, fetchFundNavList,
  type HttpDriver,
} from './sqlite_fetcher.ts'
import { initApp, debugDump, debugOrderCheck, type InitResult } from './init_app.ts'

// ─── 验收计数器 ──────────────────────────────────
let pass = 0, fail = 0
function check(label: string, ok: boolean, hint = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else    { fail++; console.log(`  ✗ ${label}${hint ? '：' + hint : ''}`) }
}

// ─── Mock 驱动（模拟真实 HTTP 返回几条基金） ──────
function fakeDriver(): HttpDriver {
  // 模拟东财返回结构
  return {
    get: async (url: string) => {
      if (url.includes('FundMNBasicInformation')) {
        return {
          status: 200,
          data: {
            Datas: [
              { FCODE: '110011', NAME: '易方达中小盘混合', FundType: '混合型-偏股', PURCHASEFEE: '0.0015', MINSUM: '1' },
              { FCODE: '000021', NAME: '测试指数基金', FundType: '股票指数', PURCHASEFEE: '0.001', MINSUM: '1' },
              { FCODE: '000021', NAME: '华夏海外收益债', FundType: 'QDII', PURCHASEFEE: '0.0015', MINSUM: '100' },  // 100 元起
              { FCODE: '510300', NAME: '华泰柏瑞沪深300', FundType: '股票指数', PURCHASEFEE: '0', MINSUM: '1' },
            ],
          },
        }
      }
      if (url.includes('FundMNPeriodIncrease')) {
        return {
          status: 200,
          data: {
            Datas: [
              { NAV_DATE: '2026-09-17', NAV: '8.6' },
              { NAV_DATE: '2026-09-16', NAV: '8.55' },
              { NAV_DATE: '2026-09-15', NAV: '8.5' },
            ],
          },
        }
      }
      return { status: 404, data: null }
    },
  }
}

// ─── 主流程 ───────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  自测 · 数据层（6 项 + 单元）')
  console.log('═══════════════════════════════════════════════════════')

  // ── 用例 1+2+3：建表 + 注入 fetcher + 抓到几条 ──
  console.log('\n=== 用例 1+2+3：建表 + 注入 + 自动抓取 + 落库 ===')
  {
    const driver = fakeDriver()
    const r = await initApp({
      httpDriver: driver,
      initialFundCodes: ['110011', '000021'],
      log: m => {},   // 静默日志
    })
    check('init 不抛错', r.ok, `errors=${JSON.stringify(r.errors)}`)
    check('抓到 4 只基金', r.nameCount === 4, `actual=${r.nameCount}`)
    check('抓到 4 条申购', r.purchaseCount === 4, `actual=${r.purchaseCount}`)
    check('抓到 6 条净值（2 只 × 3 天）', r.navCount === 6, `actual=${r.navCount}`)

    // funds 落库
    const db = r.db
    const funds = await db.query<{ fund_code: string; fund_name: string; min_purchase: number | null }>(
      `SELECT fund_code, fund_name, min_purchase FROM funds WHERE status='active' ORDER BY fund_code`,
    )
    check('funds 表有 4 条', funds.length === 4, `actual=${funds.length}`)
    check('110011 min_purchase=1', funds.find(f => f.fund_code === '110011')?.min_purchase === 1)
    check('000021 min_purchase=100（QDII 高起购）', funds.find(f => f.fund_code === '000021')?.min_purchase === 100)

    // nav_daily 落库
    const navs = await db.query<{ fund_code: string; nav_date: string; nav: number }>(
      `SELECT fund_code, nav_date, nav FROM nav_daily ORDER BY nav_date DESC, fund_code`,
    )
    check('nav_daily 表有 6 条', navs.length === 6, `actual=${navs.length}`)
    check('110011 9/17 净值 8.6', navs.find(n => n.fund_code === '110011' && n.nav_date === '2026-09-17')?.nav === 8.6)

    // 调试输出
    await debugDump(db, m => console.log(`  ${m}`))
  }

  // ── 用例 4：起购线生效 ────────────────────────
  console.log('\n=== 用例 4：起购线生效（QDII 100 元起，提交 50 → 拒）===')
  {
    const driver = fakeDriver()
    const r = await initApp({ httpDriver: driver, log: () => {}, })
    const db = r.db
    setLedgerDb(db); setOrderDb(db)
    await db.run(`INSERT INTO cash_ledger (amount, memo, action, created_at) VALUES (?, 'init', 'initial', ?)`, [100000, '2026-09-20 09:00:00'])
    // 000021 起购 100 元
    const c1 = await checkBeforeSubmit('buy', '000021', 50, 'human', '低于起购')
    check('000021 amount=50 < 起购 100 → 拒绝', !c1.ok)
    check('拒绝原因含「起购」', c1.message.includes('起购'), `actual="${c1.message}"`)
    check('拒绝原因含「100」', c1.message.includes('100'), `actual="${c1.message}"`)
    // 110011 起购 1 元，amount=100 应通过
    const c2 = await checkBeforeSubmit('buy', '110011', 100, 'human', '高于起购')
    check('110011 amount=100 >= 起购 1 → 通过', c2.ok, `reason="${c2.message}"`)
  }

  // ── 用例 5：限购生效 ────────────────────────
  console.log('\n=== 用例 5：限购生效（status=limited + 超额 → 拒）===')
  {
    const driver = fakeDriver()
    const r = await initApp({ httpDriver: driver, log: () => {}, })
    const db = r.db
    setLedgerDb(db); setOrderDb(db)
    // 注入限购快照：500 元/日
    // 注意：SQL 字面量不在 params 中，mock 按位置映射需要严格按 11 参顺序
    // （mock 简化实现：只接受 11 个参数）
    await db.run(
      `INSERT INTO fund_status (fund_code, status_date, purchase_status, redeem_status,
       purchase_limit, limit_unknown, raw_purchase, raw_redeem, note, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['110011', '2026-09-20', 'limited', 'open', 500, 0,
       '限大额（500元）', '开放赎回',
       '原始状态：申购[限大额（500元）] 赎回[开放赎回]', 'em_daily', '2026-09-20 09:00:00'],
    )
    // fetchAndSave 应返回 from_cache=false（今日快照）
    const st = await fetchAndSave(db, '110011')
    check('fetchAndSave 返回有值', st !== null)
    check('purchase_status=limited', st?.purchase_status === 'limited')
    check('purchase_limit=500', st?.purchase_limit === 500)

    // 通过 orders.ts 的 canBuy 验证
    const { canBuy } = await import('../core/status.ts')
    const c1 = canBuy(st!, 1000)  // 1000 > 500 限额
    check('canBuy(amount=1000, limit=500) → 拒绝', !c1.ok)
    check('拒绝原因含「500」或「限购」', c1.reason.includes('500') || c1.reason.includes('限购'), `actual="${c1.reason}"`)
    const c2 = canBuy(st!, 300)   // 300 < 500 通过
    check('canBuy(amount=300, limit=500) → 通过', c2.ok, `reason="${c2.reason}"`)
  }

  // ── 用例 6：口径（成交份额按 nav 算，不看 acc_nav） ──
  console.log('\n=== 用例 6：口径（成交份额按单位净值 nav 算）===')
  {
    const driver = fakeDriver()
    const r = await initApp({ httpDriver: driver, log: () => {}, })
    const db = r.db
    setLedgerDb(db); setOrderDb(db)
    await db.run(`INSERT INTO cash_ledger (amount, memo, action, created_at) VALUES (?, 'init', 'initial', ?)`, [100000, '2026-09-20 09:00:00'])
    const sub = await submitOrder('buy', '110011', 50000, 'human', '口径测试')
    const cof: ConfirmResult = await confirmOrder(sub.orderId, 'human', '口径确认')
    check('confirm 成功', cof.type === 'buy')
    // 净值是 8.6（用 nav，不用 acc_nav）
    // net_amount = 50000 / (1 + 0.0012) ≈ 49940.07
    // fakeDriver 中 110011 PURCHASEFEE='0.0015'，nav=8.6
    // shares = (50000 / 1.0015) / 8.6 ≈ 5805.25
    // fakeDriver 中 110011 PURCHASEFEE='0.0015'，nav=8.6
    // shares = (50000 / 1.0015) / 8.6 ≈ 5805.25
    const expectedShares = Math.floor((50000 / 1.0015 / 8.6) * 1000000) / 1000000
    const actualShares = cof.shares ?? 0
    check('成交份额按单位净值（≈5805.25）', Math.abs(actualShares - expectedShares) < 0.01, `expected=${expectedShares}, actual=${actualShares}`)
    // 验证 lot 表存的也是用 nav 算的份额
    const lots = await db.query<{ shares: number; cost_amount: number; remaining_shares: number }>(
      `SELECT shares, cost_amount, remaining_shares FROM lots WHERE buy_order_id=? AND source='trade'`, [sub.orderId],
    )
    check('lots 非空（确认买入已建批）', lots.length > 0, `expected≥1, got=${lots.length}`)
    if (lots.length > 0) {
      const lot = lots[0]
      check('lots.shares = 成交份额', Math.abs(lot.shares - expectedShares) < 0.01)
      check('lots.remaining_shares = shares', lot.remaining_shares === lot.shares)
    }
  }

  // ── 辅助：数据缺失路径 ────────────────────────────
  console.log('\n=== 辅助：数据缺失路径（未注入 driver → 返回空）===')
  {
    const r = await initApp({ log: () => {}, })   // 不传 httpDriver
    check('未注入 driver → nameCount=0', r.nameCount === 0)
    check('未注入 driver → purchaseCount=0', r.purchaseCount === 0)
    check('未注入 driver → navCount=0', r.navCount === 0)
    // 未注入 httpDriver → fetcher 为 null → refreshMarketData 直接返回空
    // errors 数组也为空（无异常，只是没拉到数据）
    check('未注入 driver → 静默成功（ok=true，errors=空）', r.ok && r.errors.length === 0)
  }

  // ── 辅助：净值只用 nav，不用 acc_nav（fetchFundNavList 解析） ─
  console.log('\n=== 辅助：fetchFundNavList 只取 nav 字段 ===')
  {
    const driver: HttpDriver = {
      get: async () => ({
        status: 200,
        data: {
          Datas: [
            { NAV_DATE: '2026-09-17', NAV: '8.6', ACCNAV: '12.4' },   // 故意造两个字段
            { NAV_DATE: '2026-09-16', NAV: '8.55', ACCNAV: '12.3' },
          ],
        },
      }),
    }
    setHttpDriver(driver)
    const navs = await fetchFundNavList('110011')
    check('fetchFundNavList 返回 2 条', navs.length === 2)
    check('navs 不含 acc_nav（不缓存累计净值）', !('acc_nav' in navs[0]))
    check('navs[0].nav=8.6（用单位净值）', navs[0].nav === 8.6)
  }

  // ── 总结 ──────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  结果：✅ ${pass} 通过，❌ ${fail} 失败`)
  console.log('═══════════════════════════════════════════════════════')
  const __proc = (globalThis as { process?: { exit?: (code: number) => void } }).process
  __proc?.exit?.(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('FATAL', e)
  const __proc = (globalThis as { process?: { exit?: (code: number) => void } }).process
  __proc?.exit?.(2)
})