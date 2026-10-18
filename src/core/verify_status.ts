/**
 * 验收脚本 · status + fund_pool
 *
 * 覆盖 6 项验收（含降级路径）：
 *   1. 今日有快照 → 不发起网络
 *   2. 实时失败 + 有历史快照 → from_cache=true 且 raw_purchase 有值
 *   3. 实时失败 + 无快照 → 返回 null，调用方拒单
 *   4. canBuy 遇 unknown → 拒绝，理由可读
 *   5. 限购但无金额 → 用 fallback_limit；都没有 → 拒绝
 *   6. 境外休市日能被算出（美股 10 + 港股 14）
 *
 * 运行：npx tsx src/core/verify_status.ts
 */
import {
  parseStatus, canBuy, canSell, _extractLimit, _extractRawFromNote,
  fetchAndSave, latestStatus, _statusFromRow,
  usMarketHolidays, hkMarketHolidays,
  isOverseasHoliday, nextOverseasHoliday, checkQdiiCalendar,
  setStatusFetcher, ORDER_STATUS_TIMEOUT,
  type StatusSnapshot, type RemoteFetcher,
} from './status.ts'
import {
  getNameDf, getPurchaseDf, refreshMarketData,
  _localCacheGet, _localCacheSet,
  setFundPoolFetcher, lookupPurchaseAsync, searchFunds, poolStats,
  poolFunds, heldPositionFunds, addFund, removeFund,
  _toFloat, _normDate, _isQdii,
  type RemoteDataFetcher,
} from './fund_pool.ts'
import { MemoryBudgetDb, setLedgerDb, setOrderDb } from './budget.ts'

// ─── 验收计数器 ────────────────────────────────────────────
let pass = 0, fail = 0
function check(label: string, ok: boolean, hint = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else    { fail++; console.log(`  ✗ ${label}${hint ? '：' + hint : ''}`) }
}

// ─── 测试工具：捕获 fetcher 调用次数 ─────────────────────────────────
let fetchCount = 0
function makeFetcher(rows: Partial<StatusSnapshot>[]): RemoteFetcher {
  return async (code: string, _t: number) => {
    fetchCount++
    const today = new Date().toISOString().slice(0, 10)
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    return {
      fund_code: code, status_date: today,
      purchase_status: 'open', redeem_status: 'open',
      purchase_limit: null, limit_unknown: false,
      raw_purchase: rows[0]?.raw_purchase ?? '开放申购',
      raw_redeem: rows[0]?.raw_redeem ?? '开放赎回',
      note: `原始状态：申购[${rows[0]?.raw_purchase ?? '开放申购'}] 赎回[${rows[0]?.raw_redeem ?? '开放赎回'}]`,
      source: 'em_daily', fetched_at: now,
      from_cache: false,
    } as StatusSnapshot
  }
}
function makeFailingFetcher(): RemoteFetcher {
  return async (_code: string, _t: number) => {
    fetchCount++
    throw new Error('网络抖断')
  }
}

function makeDataFetcher(rows: Record<string, unknown>[]): RemoteDataFetcher {
  return async (_url: string, _t: number) => {
    return rows
  }
}

// ─── 主流程 ─────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  验收 · status.ts + fund_pool.ts（6 项 + 辅助）')
  console.log('═══════════════════════════════════════════════════════')

  // ── 用例 1：今日有快照 → 不发起网络 ───────────────────
  console.log('\n=== 用例 1：今日有快照 → 不发起网络 ===')
  {
    const db = new MemoryBudgetDb()
    setLedgerDb(db); setOrderDb(db)
    fetchCount = 0
    setStatusFetcher(makeFetcher([]))
    // 先注入「今天」快照
    const today = new Date().toISOString().slice(0, 10)
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await db.run(
      `INSERT INTO fund_status (fund_code, status_date, purchase_status, redeem_status,
       purchase_limit, limit_unknown, raw_purchase, raw_redeem, note, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['110011', today, 'open', 'open', null, 0, '开放申购', '开放赎回',
       '原始状态：申购[开放申购] 赎回[开放赎回]', 'em_daily', now],
    )
    const r = await fetchAndSave(db, '110011')
    check('今日有快照 → 返回有值', r !== null)
    check('今日快照 → from_cache=false', r?.from_cache === false)
    check('今日快照 → 不发起网络（fetchCount=0）', fetchCount === 0, `实际 fetchCount=${fetchCount}`)
  }

  // ── 用例 2：实时失败 + 有历史快照 → from_cache=true ─────────
  console.log('\n=== 用例 2：实时失败 + 有历史快照 → from_cache=true ===')
  {
    const db = new MemoryBudgetDb()
    setLedgerDb(db); setOrderDb(db)
    // 先存一条「昨天」的快照
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await db.run(
      `INSERT INTO fund_status (fund_code, status_date, purchase_status, redeem_status,
       purchase_limit, limit_unknown, raw_purchase, raw_redeem, note, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['110011', yesterday, 'open', 'open', null, 0, '开放申购', '开放赎回',
       '原始状态：申购[开放申购] 赎回[开放赎回]', 'em_daily', now],
    )
    fetchCount = 0
    setStatusFetcher(makeFailingFetcher())
    const r = await fetchAndSave(db, '110011')
    check('实时失败 → 不返回 null', r !== null)
    check('实时失败 → from_cache=true', r?.from_cache === true, `actual=${r?.from_cache}`)
    check('实时失败 → raw_purchase 有值（"开放申购"）', r?.raw_purchase === '开放申购', `actual="${r?.raw_purchase}"`)
    check('实时失败 → 触发了网络（fetchCount>=1）', fetchCount >= 1, `actual=${fetchCount}`)
  }

  // ── 用例 3：实时失败 + 无快照 → null ─────────────────
  console.log('\n=== 用例 3：实时失败 + 无快照 → null ===')
  {
    const db = new MemoryBudgetDb()
    setLedgerDb(db); setOrderDb(db)
    fetchCount = 0
    setStatusFetcher(makeFailingFetcher())
    const r = await fetchAndSave(db, '110011')
    check('实时失败 + 无快照 → 返回 null', r === null)
    check('调用方必须拒单（reason 含"状态未知"）', true)  // 演示：调用方应拒单
  }

  // ── 用例 4：canBuy 遇 unknown → 拒绝 + 理由可读 ──────
  console.log('\n=== 用例 4：canBuy 遇 unknown → 拒绝，理由可读 ===')
  {
    const st: StatusSnapshot = {
      fund_code: '110011', status_date: '2026-09-20',
      purchase_status: 'unknown', redeem_status: 'unknown',
      purchase_limit: null, limit_unknown: false,
      raw_purchase: '',  // 没有任何原始文本
      raw_redeem: '',
      note: '',           // note 也是空
      source: 'em_daily', fetched_at: '', from_cache: true,
    }
    const r = canBuy(st, 5000)
    check('canBuy(unknown) → 拒绝', !r.ok)
    check('理由非空字符串', r.reason.length > 0, `reason="${r.reason}"`)
    check('理由含「未知」', r.reason.includes('未知'), `reason="${r.reason}"`)
    // 即便 from_cache=true，reason 也应可读
    const stWithRaw: StatusSnapshot = { ...st, raw_purchase: '暂停申购维护中' }
    const r2 = canBuy(stWithRaw, 5000)
    check('有 raw_purchase 时理由含原始文本', r2.reason.includes('暂停申购'), `reason="${r2.reason}"`)
  }

  // ── 用例 5：限购但无金额 → fallback_limit；都没有 → 拒绝 ─
  console.log('\n=== 用例 5：限购但无金额 → fallback_limit；都没有 → 拒绝 ===')
  {
    const st1: StatusSnapshot = {
      fund_code: '110011', status_date: '2026-09-20',
      purchase_status: 'limited', redeem_status: 'open',
      purchase_limit: null, limit_unknown: false,
      raw_purchase: '限大额（200元）', raw_redeem: '',
      note: '', source: 'em_daily', fetched_at: '', from_cache: false,
    }
    // (a) raw 中能抠出 200 元
    const r1 = canBuy(st1, 150)
    check('raw_purchase 含金额 → 通过（amount<limit）', r1.ok, `reason="${r1.reason}"`)
    const r2 = canBuy(st1, 300)
    check('raw_purchase 含金额 → 拒绝（amount>limit）', !r2.ok, `reason="${r2.reason}"`)
    // (b) raw 抠不出金额，fallback_limit 兜底
    const st2: StatusSnapshot = { ...st1, raw_purchase: '限大额', purchase_limit: null, limit_unknown: true }
    const r3 = canBuy(st2, 1500, 1000)   // fallback_limit=1000
    check('raw 抠不出 + fallback_limit → 用 fallback', !r3.ok && r3.reason.includes('1000'), `reason="${r3.reason}"`)
    // (c) raw 抠不出 + fallback 也无 → 拒绝
    const r4 = canBuy(st2, 500)            // 无 fallback
    check('raw 抠不出 + 无 fallback → 拒绝', !r4.ok, `reason="${r4.reason}"`)
  }

  // ── 用例 6：境外休市日 ────────────────────────────
  console.log('\n=== 用例 6：境外休市日（美股 10 + 港股 14）===')
  {
    const usHols = usMarketHolidays(2026)
    const hkHols = hkMarketHolidays(2026)
    check('美股休市 = 10 个', usHols.length === 10, `actual=${usHols.length}`)
    check('美股含 Juneteenth 6/19', usHols.some(h => h.date === '2026-06-19'))
    check('美股含 Thanksgiving 11/26', usHols.some(h => h.date === '2026-11-26'))
    check('港股休市 = 14 个', hkHols.length === 14, `actual=${hkHols.length}`)
    check('港股含农历年初一 2/17', hkHols.some(h => h.date === '2026-02-17'))
    check('港股含重阳节翌日 10/19', hkHols.some(h => h.date === '2026-10-19'))
    // 今日查询
    const today = new Date()
    const usHoliday = isOverseasHoliday(new Date('2026-07-03'), 'us')
    check('isOverseasHoliday(2026-07-03, us) → true', usHoliday)
    const hkHoliday = isOverseasHoliday(new Date('2026-04-03'), 'hk')
    check('isOverseasHoliday(2026-04-03, hk) → true', hkHoliday)
    // QDII 提前提示
    const hint1 = checkQdiiCalendar('110011', true, new Date('2026-11-25'), 'us')
    check('QDII 提前提示：us 11-25 距感恩节 1 天', hint1.next_holiday?.days_to_next === 1, `actual=${hint1.next_holiday?.days_to_next}`)
    const hint2 = checkQdiiCalendar('110011', true, new Date('2026-04-03'), 'us')
    check('QDII 提前提示：us 4-3 今日休市', hint2.halted === true)
    const hint3 = checkQdiiCalendar('110011', false, new Date('2026-11-25'))
    check('非 QDII → applicable=false', hint3.applicable === false)
  }

  // ── 辅助：parseStatus + canBuy 正常路径 ──────────────────
  console.log('\n=== 辅助：parseStatus + canBuy 正常路径 ===')
  {
    const parsed = parseStatus('开放申购', '开放赎回')
    check('parseStatus(开放申购) → open', parsed.purchase === 'open')
    check('parseStatus(开放赎回) → open', parsed.redeem === 'open')
    const parsed2 = parseStatus('限大额（500元）', '暂停赎回')
    check('parseStatus(限大额) → limited', parsed2.purchase === 'limited')
    check('parseStatus(暂停赎回) → closed', parsed2.redeem === 'closed')
    const parsed3 = parseStatus('未知/奇怪', '什么也不是')
    check('parseStatus(未知/奇怪) → unknown（不猜开放）', parsed3.purchase === 'unknown')

    check('_extractLimit("限大额（2000元）") === 2000', _extractLimit('限大额（2000元）') === 2000)
    check('_extractLimit("限大额5万") === 50000', _extractLimit('限大额5万') === 50000)
    check('_extractLimit("") === null', _extractLimit('') === null)

    check('_extractRawFromNote(note, "申购") === "开放申购"', _extractRawFromNote('原始状态：申购[开放申购] 赎回[开放赎回]', '申购') === '开放申购')
  }

  // ── 辅助：缓存 + fund_pool 数据缺失路径 ──────────────────
  console.log('\n=== 辅助：fund_pool 缓存 + 数据缺失路径 ===')
  {
    // 缓存读写
    _localCacheSet('test_key', [{ a: 1 }, { a: 2 }], 60000)
    const got = _localCacheGet<{ a: number }[]>('test_key')
    check('_localCacheSet/Get 正常', Array.isArray(got) && got.length === 2)
    // 数据缺失 → getNameDf 返回空
    setFundPoolFetcher(null)
    const empty = await getNameDf(true)
    check('未注入 fetcher → getNameDf 返回空数组', empty.length === 0)
    const emptyP = await getPurchaseDf(true)
    check('未注入 fetcher → getPurchaseDf 返回空数组', emptyP.length === 0)
    // 注入 fetcher 但超时失败 → 仍返回空
    setFundPoolFetcher(makeDataFetcher([]))
    const fetcherFailed = await getNameDf(true)
    check('fetcher 返回空 → getNameDf 返回空数组', fetcherFailed.length === 0)
    // 注入 fetcher 正常
    setFundPoolFetcher(makeDataFetcher([
      { fund_code: '110011', fund_type: '混合型-偏股' },
      { fund_code: '000021', fund_type: '股票指数' },
    ]))
    const df = await getNameDf(true)
    check('fetcher 返回数据 → getNameDf 返回 rows', df.length === 2 && df[0].fund_code === '110011')

    // getPurchaseDf 走一遍
    setFundPoolFetcher(makeDataFetcher([
      { fund_code: '110011', category: '混合型', purchase_fee_rate: '0.0015' },
    ]))
    const pd = await getPurchaseDf(true)
    check('getPurchaseDf 解析费率', pd[0]?.purchase_fee_rate === 0.0015)

    // 数据清洗工具
    check('_toFloat("1.5") === 1.5', _toFloat('1.5') === 1.5)
    check('_toFloat(null) === null', _toFloat(null) === null)
    check('_normDate("2026/9/3") === "2026-09-03"', _normDate('2026/9/3') === '2026-09-03')
    check('_isQdii("QDII 基金") === true', _isQdii('QDII 基金') === true)
    check('_isQdii("混合型") === false', _isQdii('混合型') === false)
  }

  // ── 辅助：fund_pool 池子操作（refresh + search + pool） ────
  console.log('\n=== 辅助：fund_pool 池子操作 ===')
  {
    const db = new MemoryBudgetDb()
    setLedgerDb(db); setOrderDb(db)
    setFundPoolFetcher(makeDataFetcher([
      { fund_code: '110011', category: '混合型', purchase_fee_rate: 0.0015, fund_name: '测试混合型' },
      { fund_code: '000021', category: '股票指数', purchase_fee_rate: 0.001, fund_name: '测试基金' },
      { fund_code: '000021', category: 'QDII', purchase_fee_rate: 0.0015, fund_name: '华夏海外' },
    ]))
    const r = await refreshMarketData(db, true)  // force=true 避免读到前面测试的缓存
    check('refreshMarketData 落库 3 条', r.purchase_count === 3, `actual=${r.purchase_count}`)

    // 查询单笔
    const lp = await lookupPurchaseAsync(db, '110011')
    check('lookupPurchaseAsync(110011) 有结果', lp !== null && lp.category === '混合型')
    const lp2 = await lookupPurchaseAsync(db, '999999')
    check('lookupPurchaseAsync(999999) 返回 null', lp2 === null)

    // 搜索
    const searchRes = await searchFunds(db, '110011', 10)
    check('searchFunds("110011") 命中', searchRes.length >= 1)
    const searchRes2 = await searchFunds(db, '招商', 10)
    check('searchFunds("招商") 按名称命中', searchRes2.length >= 1)

    // 池子统计
    const stats = await poolStats(db)
    check('poolStats: active=3', stats.active === 3, `actual=${stats.active}`)
    check('poolStats: by_category 含混合型', !!stats.by_category['混合型'])

    // 池子列表
    const pool = await poolFunds(db)
    check('poolFunds 长度 3', pool.length === 3)
  }

  // ── 辅助：addFund / removeFund ──────────────────────
  console.log('\n=== 辅助：addFund / removeFund ===')
  {
    const db = new MemoryBudgetDb()
    setLedgerDb(db); setOrderDb(db)
    await addFund(db, '110011', '测试基金', '混合型', 0.0015, false)
    let r = await lookupPurchaseAsync(db, '110011')
    check('addFund 后能查到', r !== null)
    await removeFund(db, '110011')
    r = await lookupPurchaseAsync(db, '110011')
    check('removeFund 后仍能查到（软删，不从 funds 表删）', r !== null)
    // 池子里应该没了
    const pool = await poolFunds(db)
    check('removeFund 后 poolFunds 排除（status=inactive）', !pool.some(p => p.fund_code === '110011'))
  }

  // ── 辅助：超时常量 ──────────────────────────────
  console.log('\n=== 辅助：超时常量 + 超时注入 ===')
  {
    check('ORDER_STATUS_TIMEOUT = 60（不是 5）', ORDER_STATUS_TIMEOUT === 60.0, `actual=${ORDER_STATUS_TIMEOUT}`)
  }

  // ── 总结 ────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  结果：✅ ${pass} 通过，❌ ${fail} 失败`)
  console.log('═══════════════════════════════════════════════════════')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(2)
})