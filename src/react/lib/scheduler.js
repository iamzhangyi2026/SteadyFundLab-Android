// scheduler.js · 兜底调度器（AI 不在线时的离线周期）
//
// 触发：App 启动后一次（每天最多一次，用 pool_meta 记录上次执行日期）。
// 范围：**持仓 + 关注**的基金。
// 产出：每只基金一条决策记录（止盈/回撤止损/认错 → 赎回；未触发 → 不动），
//       写入 decision_log，供「决策速览」展示。

import {
  getDb, fetchPositions, fetchWatchlist, jsRunOfflineCycle, jsRunDingtou,
  recordPortfolioSnapshot, jsFetchAndSaveHoldings,
} from './dataAdapter'

/** pool_meta 里记录"上次跑离线周期"的日期。
 *  key 带版本号：改调度逻辑时 +1 可让当天重新跑一次（同时触发历史重复行清理）。 */
const META_KEY = 'last_offline_cycle_v12'

function _nowStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function _todayStr() { return _nowStr().slice(0, 10) }

/**
 * 增量穿透落库：给定基金代码，逐只抓「行业配置 + 前十大重仓」写入 fund_holdings。
 * 单只两次请求、间隔 300ms（避开源站限流）；单只失败不影响其它。
 * 调用方可**后台触发不必 await**（新买入/新关注后立刻有穿透数据，不用等第二天周期）。
 * @returns {Promise<number>} 取到数据的基金数
 */
export async function refreshPenetrationFor(codes = []) {
  const list = [...new Set((codes || []).filter(Boolean))]
  let hit = 0
  for (const code of list) {
    try {
      const hr = await jsFetchAndSaveHoldings(code)
      const d = (hr && hr.data) || {}
      if (hr && hr.ok && ((d.industryCount || 0) > 0 || (d.topHoldingsCount || 0) > 0)) hit++
    } catch { /* 单只失败继续 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return hit
}

/**
 * 纪律线 → 决策动作。
 * profit_take(止盈) / drawdown_cut(回撤止损) / admit_wrong(认错) → redeem；
 * 未触发 → hold（照实记录"不动"，不是什么都不写）。
 */
function _linesToAction(entry) {
  const lines = (entry && entry.lines) || []
  if (lines.length === 0) {
    return {
      action: 'hold',
      reason: (entry && entry.note) || '纪律线未触发，维持不动（不操作也是一种决策）',
    }
  }
  const first = lines[0]
  const label =
    first.type === 'profit_take' ? '止盈'
      : first.type === 'drawdown_cut' ? '回撤止损'
        : '认错'
  const ratio = first.suggested_ratio >= 1
    ? '清仓'
    : `减仓 ${Math.round((first.suggested_ratio || 0) * 100)}%`
  return {
    action: 'redeem',
    reason: `${label}触发：${first.detail} → 建议${ratio}`,
  }
}

/**
 * 跑一次离线周期并落库。
 * @param {{force?: boolean}} opts force=true 时忽略「今天已跑过」
 *
 * 并发守卫：`start()` 可能被 React StrictMode 双调用，两次会**同时**读到
 * "今天还没跑" 再各自写一遍 → decision_log 出现重复行。
 * 异步初始化必须用 in-flight promise 去重，不能用布尔标志。
 */
let _running = null

export async function runOfflineCycleOnce(opts = {}) {
  if (_running) return _running
  _running = _runOfflineCycleOnce(opts)
    .then(r => { _notifyCycleDone(); return r })
    .catch(e => { _notifyCycleDone(); throw e })
    .finally(() => { _running = null })
  return _running
}

/** 广播"本轮周期结束（无论真跑还是跳过）"，让页面立刻重载数据 */
function _notifyCycleDone() {
  try {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new Event('fundapp:cycle-done'))
    }
  } catch { /* 非浏览器环境忽略 */ }
}

async function _runOfflineCycleOnce(opts = {}) {
  const force = !!opts.force
  const db = getDb()
  if (!db) return { ok: false, error: 'app_not_initialized' }
  // 全球行情：接入调度器周期刷新（与每日离线决策解耦，受 30min 节流保护）
  await refreshGlobalQuotes()
  try {
    const today = _todayStr()
    if (!force) {
      const rows = await db.query(`SELECT value FROM pool_meta WHERE key=?`, [META_KEY])
      if (rows[0] && rows[0].value && String(rows[0].value).startsWith(today)) {
        return { ok: true, data: { skipped: true } }
      }
    }

    // 顺带刷新「市场资讯 + 情报事件」（每天一次，与决策周期同步）
    // market_news ← RSS（财联社/华尔街见闻/金十）；intel_events ← 从 market_news 关键词提取
    try {
      const { fetchMarketNews } = await import('../../core/rss_news.ts')
      const nr = await fetchMarketNews(db)
      console.log(`[scheduler] 资讯抓取：源 ${nr.sources_succeeded}/${nr.sources_attempted} 成功，入库 ${nr.inserted} 条`)
      if (nr.errors && nr.errors.length) console.warn('[scheduler] 资讯源错误:', JSON.stringify(nr.errors).slice(0, 200))
      const { collectIntelEvents } = await import('../../core/intel_collector.ts')
      const ir = await collectIntelEvents(db)
      console.log('[scheduler] 情报提取:', JSON.stringify(ir).slice(0, 200))
    } catch (e) {
      console.warn('[scheduler] 资讯/情报刷新失败:', (e && e.message) || e)
    }

    // 定投执行（每天一次；幂等：本期已投则跳过；已紧急暂停则整体跳过）
    try {
      const dr = await jsRunDingtou(today)
      if (dr.ok && dr.data) {
        console.log(`[scheduler] 定投执行：到期 ${dr.data.due}，下单 ${dr.data.placed}，失败 ${dr.data.failed}`)
      } else if (!dr.ok) {
        console.warn('[scheduler] 定投执行失败:', dr.error)
      }
    } catch (e) {
      console.warn('[scheduler] 定投执行异常:', (e && e.message) || e)
    }

    // 组合每日快照（组合资产曲线的数据源）
    try {
      const sr = await recordPortfolioSnapshot(today)
      if (sr.ok) console.log(`[scheduler] 组合快照：${sr.data.date} 总资产 ${sr.data.total}`)
    } catch (e) {
      console.warn('[scheduler] 组合快照失败:', (e && e.message) || e)
    }

    // 兜底分析：AI 离线/未配置时，本地兜底分析照常上，
    // 方法 = 本地选基算法的筛选+评分，只读本地库。
    // 产出落 decision_log（source='fallback_analysis'），决策速览 / AI 小管家兜底可直接引用。
    try {
      const { runFallbackAnalysis } = await import('../../core/fallback_analysis.ts')
      const fa = await runFallbackAnalysis(db, today)
      await db.run(
        `INSERT INTO decision_log (ts, source, action, fund_code, fund_name, reason, payload, created_at)
         VALUES (?, 'fallback_analysis', 'review', NULL, NULL, ?, ?, ?)`,
        [_nowStr(), fa.conclusion, JSON.stringify(fa), _nowStr()],
      )
      console.log(`[scheduler] 兜底分析：全池 ${fa.pool_size} 只 → 候选 ${fa.candidates.length} 只`)
    } catch (e) {
      console.warn('[scheduler] 兜底分析失败:', (e && e.message) || e)
    }

    // 范围：持仓 + 关注
    const [posR, wlR] = await Promise.all([fetchPositions(), fetchWatchlist()])
    const codes = [...new Set([
      ...(posR.ok ? (posR.data || []).map(p => p.fund_code) : []),
      ...(wlR.ok ? (wlR.data || []).map(f => f.fund_code) : []),
    ])].filter(Boolean)

    if (codes.length === 0) {
      await db.run(
        `INSERT OR REPLACE INTO pool_meta (key, value, updated_at) VALUES (?, ?, ?)`,
        [META_KEY, today, _nowStr()],
      )
      return { ok: true, data: { skipped: true, reason: 'no_funds' } }
    }

    // 穿透落库：行业配置 + 前十大重仓 → fund_holdings。
    // 范围限「持仓 + 关注」，逐只顺序抓 + 300ms 间隔，
    // 避开源站限流（fundmobapi 返 ErrCode 61136）；单只失败不影响其它。
    try {
      const hit = await refreshPenetrationFor(codes)
      console.log(`[scheduler] 穿透落库：${codes.length} 只中 ${hit} 只取到数据`)
    } catch (e) {
      console.warn('[scheduler] 穿透落库失败:', (e && e.message) || e)
    }

    const r = await jsRunOfflineCycle(codes, today)
    if (!r.ok) return { ok: false, error: r.error }
    const actions = (r.data && r.data.actions) || []
    const nameRows = await db.query(`SELECT fund_code, fund_name FROM funds`)
    const nameOf = new Map(nameRows.map(x => [x.fund_code, x.fund_name]))

    const ts = _nowStr()
    let written = 0
    for (const e of actions) {
      const { action, reason } = _linesToAction(e)
      await db.run(
        `INSERT INTO decision_log (ts, source, action, fund_code, fund_name, reason, payload, created_at)
         VALUES (?, 'offline_cycle', ?, ?, ?, ?, ?, ?)`,
        [
          ts, action, e.fund_code, nameOf.get(e.fund_code) || null, reason,
          JSON.stringify({ lines: e.lines || [], penalty: e.penalty || null, note: e.note || null }),
          ts,
        ],
      )
      written++
    }

    // 去重（**必须在插入之后**，否则新行不会被合并）：
    // 按「天 + 来源 + 基金 + 动作」只留最早一条。
    // 不能按 ts 去重——并发两次运行会差 1~2 秒，ts 不同就漏掉；
    // 而调度器每天最多跑一次，**同一天同一只基金同一动作只可能是重复**。
    await db.run(
      `DELETE FROM decision_log WHERE id NOT IN (
         SELECT MIN(id) FROM decision_log GROUP BY date(ts), source, fund_code, action
       )`,
    )

    await db.run(
      `INSERT OR REPLACE INTO pool_meta (key, value, updated_at) VALUES (?, ?, ?)`,
      [META_KEY, today, ts],
    )
    console.log(`[scheduler] 离线周期完成：${codes.length} 只 → ${written} 条决策`)
    // 广播"本轮周期结束"：让各页面**立刻重载**，而不是靠猜延时（init 约 28s 才就绪，
    // 调度器实际在它之后才跑，固定 setTimeout 必然早于数据）。
    try {
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new Event('fundapp:cycle-done'))
      }
    } catch { /* 忽略：非浏览器环境 */ }
    return { ok: true, data: { funds: codes.length, written } }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

/** 决策日志（倒序，供「决策速览」展示） */
export async function fetchDecisionLog(limit = 10) {
  const db = getDb()
  if (!db) return { ok: false, error: 'app_not_initialized', data: [] }
  try {
    const rows = await db.query(
      `SELECT ts, source, action, fund_code, fund_name, reason
       FROM decision_log ORDER BY ts DESC, id DESC LIMIT ?`,
      [limit],
    )
    return { ok: true, data: rows }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), data: [] }
  }
}

/**
 * 启动调度：App 启动后跑一次（"每天一次"由 runOfflineCycleOnce 内部把关）。
 * 延后 8s 是为了等 initDataLayer 把真库打开（否则 getDb() 仍是 null）。
 */
export function startScheduler() {
  setTimeout(() => {
    runOfflineCycleOnce()
      .then(r => { if (!r.ok) console.warn('[scheduler] 离线周期失败:', r.error) })
      .catch(e => console.warn('[scheduler] 离线周期异常:', (e && e.message) || e))
  }, 8000)
  // 全球行情：App 启动即刷新一次（落库），由 refreshGlobalQuotes 内部节流（30min），不重复抓
  setTimeout(() => {
    refreshGlobalQuotes()
      .then(r => { if (!r.ok && !r.skipped) console.warn('[scheduler] 全球行情刷新失败:', r.error) })
      .catch(e => console.warn('[scheduler] 全球行情刷新异常:', (e && e.message) || e))
  }, 12000)
}

/**
 * 刷新全球行情并落库（接入调度器，而非只在页面打开时抓一次）。
 * 节流：默认 30 分钟内不重复抓（实时行情 intraday 变化，30min 足够；force=true 忽略节流）。
 * 失败静默（不阻断其它调度）。
 */
const GLOBAL_QUOTES_META = 'last_global_quotes_refresh'
export async function refreshGlobalQuotes(force = false) {
  const db = getDb()
  if (!db) return { ok: false, error: 'app_not_initialized' }
  try {
    if (!force) {
      try {
        const rows = await db.query(`SELECT value FROM pool_meta WHERE key=?`, [GLOBAL_QUOTES_META])
        const last = rows[0] && rows[0].value
        if (last) {
          const t = new Date(String(last).replace(/-/g, '/')).getTime()
          if (!Number.isNaN(t) && (Date.now() - t) / 60000 < 30) {
            return { ok: true, skipped: true }
          }
        }
      } catch { /* 表/键不存在 → 视为未刷新，继续 */ }
    }
    const { fetchAndPersistGlobalQuotes } = await import('./dataAdapter')
    const r = await fetchAndPersistGlobalQuotes()
    const ts = _nowStr()
    try {
      await db.run(`INSERT OR REPLACE INTO pool_meta (key, value, updated_at) VALUES (?, ?, ?)`, [GLOBAL_QUOTES_META, ts, ts])
    } catch { /* 忽略：写时间戳失败不影响行情本身 */ }
    if (r.ok) console.log(`[scheduler] 全球行情刷新：${r.data.length} 条落库（${ts}）`)
    else console.warn('[scheduler] 全球行情抓取失败:', r.error)
    return r
  } catch (e) {
    console.warn('[scheduler] 全球行情刷新异常:', (e && e.message) || e)
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}
