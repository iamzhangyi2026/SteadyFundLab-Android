// src/lib/portfolio_tools.js · 组合工具（C2 每日收益 / C5 基准对比 / C12 风险 / C16 再平衡 / C17 目标）
// ------------------------------------------------------------
// 全部是纯计算：输入账本行 + 历史净值 + 行业配置，输出可展示的结构。
// 口径与 realLedger.calcHolding 一致：成本 = 市值 ÷ (1 + 收益率%)，
// 份额缺失时用导入净值等比换算。算不出的字段一律 null，不填 0 冒充。

const DAY = 86400000

/* 数据源会偶发把净值口径整个换掉（单日跳到三倍、累计净值同步跳变），
   明显异于正常公募（单日涨跌停 ±10% 传导）。凡区间跨越该点的收益类指标
   一律降级，不把失真数字当结果展示。详见 lib/navSanitize.js。 */
import { detectJumps } from './navSanitize.js'
import { toLocalDateStr } from './date.js'

/** 收集参与计算的各基金在 [fromDate, toDate] 窗口内的跳变点 */
function collectJumps(histByCode, codes, fromDate, toDate) {
  const out = []
  for (const c of codes) {
    const hist = histByCode[c]
    if (!Array.isArray(hist) || hist.length < 2) continue
    for (const j of detectJumps(hist)) {
      if (j.date >= fromDate && j.date <= toDate) out.push({ code: c, ...j })
    }
  }
  return out
}

function sharesOf(r) {
  if (r.shares != null && Number.isFinite(Number(r.shares))) return Number(r.shares)
  if (r.amount != null && r.nav_at_import != null && Number(r.nav_at_import) > 0) {
    return Number(r.amount) / Number(r.nav_at_import)
  }
  return null
}

function costOf(r) {
  // 统一行（holdingsModel）直接给 cost；旧账本行按 charges 口径反推
  if (r.cost != null && Number.isFinite(Number(r.cost))) return Number(r.cost)
  if (r.amount != null && r.pct != null) return Number(r.amount) / (1 + Number(r.pct) / 100)
  return r.amount != null ? Number(r.amount) : null
}

function alignNav(hist, dates) {
  // hist 升序；给每个目标日期取「不晚于该日」的最后一个净值
  const out = []
  let j = 0
  let last = null
  for (const d of dates) {
    while (j < hist.length && hist[j].date <= d) {
      last = hist[j].nav
      j++
    }
    out.push(last)
  }
  return out
}

/**
 * 每日收益序列（C2）
 * @param {Array} holdings 账本行
 * @param {Record<string, Array<{date,nav}>>} histByCode 每只基金的单位净值历史（升序）
 * @param {number} days 最近交易日数量
 * @returns {{rows: Array<{date, mv, pnl, pnlPct}>, total: number|null}}
 *   pnl = 当日收益（份额 × 当日净值变化）；mv = 当日总市值
 */
export function dailyPnlSeries(holdings, histByCode, days = 10) {
  const usable = holdings
    .map((r) => ({ r, sh: sharesOf(r), hist: r.code ? histByCode[r.code] : null }))
    .filter((x) => x.sh != null && x.sh > 0 && Array.isArray(x.hist) && x.hist.length >= 2)

  if (usable.length === 0) return { rows: [], total: null }

  // 以最短的历史长度为准，保证每只基金在每一天都有净值
  const len = Math.min(...usable.map((x) => x.hist.length))
  const take = Math.max(2, Math.min(days + 1, len))
  const dates = usable[0].hist.slice(-take).map((p) => p.date)

  const rows = []
  let prevMv = null
  for (let i = 0; i < dates.length; i++) {
    let mv = 0
    let ok = true
    for (const u of usable) {
      const aligned = alignNav(u.hist, [dates[i]])[0]
      if (aligned == null) {
        ok = false
        break
      }
      mv += u.sh * aligned
    }
    if (!ok) continue
    const pnl = prevMv != null ? mv - prevMv : null
    rows.push({
      date: dates[i],
      mv: +mv.toFixed(2),
      pnl: pnl == null ? null : +pnl.toFixed(2),
      pnlPct: pnl != null && prevMv ? +((pnl / prevMv) * 100).toFixed(2) : null,
    })
    prevMv = mv
  }
  const withPnl = rows.filter((x) => x.pnl != null)
  const total = withPnl.length ? +withPnl.reduce((s, x) => s + x.pnl, 0).toFixed(2) : null
  const untrusted = collectJumps(histByCode, usable.map((x) => x.r.code), dates[0], dates[dates.length - 1])
  return { rows: rows.slice(-days), total, untrusted }
}

/**
 * 组合 vs 基准（C5）
 * @param {Array} holdings 账本行
 * @param {Record<string, Array<{date,nav}>>} histByCode 基金单位净值历史
 * @param {Array<{date,close}>} benchmark 基准指数日线（升序）
 * @returns {{series: Array<{date, portfolio, benchmark}>, portfolioPct, benchmarkPct, excess, benchmarkName}|null}
 */
export function benchmarkCompare(holdings, histByCode, benchmark, benchmarkName = '沪深300') {
  const usable = holdings
    .map((r) => ({ r, sh: sharesOf(r), hist: r.code ? histByCode[r.code] : null }))
    .filter((x) => x.sh != null && x.sh > 0 && Array.isArray(x.hist) && x.hist.length >= 2)
  if (usable.length === 0 || !benchmark || benchmark.length < 2) return null

  const len = Math.min(...usable.map((x) => x.hist.length))
  const take = Math.min(len, benchmark.length, 250)
  const fundDates = usable[0].hist.slice(-take).map((p) => p.date)
  // 只保留基准也覆盖到的日期
  const dates = fundDates.filter((d) => benchmark.some((b) => b.date === d))
  if (dates.length < 2) return null

  const benchAt = (d) => {
    let v = null
    for (const b of benchmark) {
      if (b.date <= d) v = b.close
      else break
    }
    return v
  }

  const mvAt = (d) => {
    let mv = 0
    for (const u of usable) {
      const nav = alignNav(u.hist, [d])[0]
      if (nav == null) return null
      mv += u.sh * nav
    }
    return mv
  }

  const baseMv = mvAt(dates[0])
  const baseBench = benchAt(dates[0])
  if (baseMv == null || baseBench == null || baseMv === 0 || baseBench === 0) return null

  const series = []
  for (const d of dates) {
    const mv = mvAt(d)
    const b = benchAt(d)
    if (mv == null || b == null) continue
    series.push({
      date: d,
      portfolio: +(((mv / baseMv) - 1) * 100).toFixed(2),
      benchmark: +(((b / baseBench) - 1) * 100).toFixed(2),
    })
  }
  if (series.length < 2) return null
  const last = series[series.length - 1]
  const untrusted = collectJumps(
    histByCode,
    usable.map((x) => x.r.code),
    dates[0],
    dates[dates.length - 1],
  )
  /* 区间跨越异常跳变：收益百分比一律置空，只留走势与跳变说明。
     硬算会得到 +226% 这类失真数。 */
  const bad = untrusted.length > 0
  return {
    series,
    portfolioPct: bad ? null : last.portfolio,
    benchmarkPct: bad ? null : last.benchmark,
    excess: bad ? null : +(last.portfolio - last.benchmark).toFixed(2),
    benchmarkName,
    untrusted,
  }
}

/**
 * 组合风险：单基金占比 + 行业加权暴露（C12）
 * @param {Array} holdings 账本行（需带 live.nav 或 nav_at_import）
 * @param {Record<string, {allocation: Array<{industry, weight}>}>} exposureByCode
 */
export function portfolioRisk(holdings, exposureByCode = {}) {
  const rows = holdings.map((r) => {
    const sh = sharesOf(r)
    let mv = r.mv != null && Number.isFinite(Number(r.mv)) ? Number(r.mv) : null
    if (mv == null) {
      const nav = r.live?.nav ?? r.nav_at_import ?? null
      if (sh != null && nav != null) mv = sh * nav
      else if (r.amount != null) mv = Number(r.amount)
    }
    return { r, mv }
  })
  const total = rows.reduce((s, x) => s + (x.mv ?? 0), 0)
  if (total <= 0) return { total: null, positions: [], industries: [], topPosition: null, hhi: null }

  const positions = rows
    .map((x) => ({
      code: x.r.code,
      name: x.r.name,
      mv: x.mv,
      pct: x.mv != null ? +((x.mv / total) * 100).toFixed(2) : null,
    }))
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))

  const ind = {}
  for (const x of rows) {
    const exp = x.r.code ? exposureByCode[x.r.code] : null
    if (!exp?.allocation?.length || x.mv == null) continue
    const w = x.mv / total
    for (const a of exp.allocation) {
      ind[a.industry] = (ind[a.industry] || 0) + w * a.weight
    }
  }
  const industries = Object.entries(ind)
    .map(([industry, weight]) => ({ industry, weight: +weight.toFixed(2) }))
    .sort((a, b) => b.weight - a.weight)

  // 集中程度 = Σ(单只占比²)，越接近 1 越集中；等权 4 只 = 0.25
  const hhi = +positions.reduce((s, p) => s + ((p.pct ?? 0) / 100) ** 2, 0).toFixed(4)

  return {
    total: +total.toFixed(2),
    positions,
    industries,
    topPosition: positions[0] || null,
    hhi,
  }
}

/**
 * 再平衡（C16）：目标比例 vs 实际比例 → 建议买卖金额
 * @param {Array} holdings 账本行
 * @param {Record<string, number>} targets { code: 目标占比% }；不传则等权
 */
export function rebalancePlan(holdings, targets = {}) {
  const risk = portfolioRisk(holdings)
  if (risk.total == null || risk.positions.length === 0) return null
  const n = risk.positions.length
  const rows = risk.positions.map((p) => {
    const target = targets[p.code] != null ? Number(targets[p.code]) : 100 / n
    const actual = p.pct ?? 0
    const diff = +(actual - target).toFixed(2)
    return {
      ...p,
      target: +target.toFixed(2),
      diff,
      amount: +(((target - actual) / 100) * risk.total).toFixed(2),
      action: Math.abs(diff) < 1 ? '保持' : diff > 0 ? '减仓' : '加仓',
    }
  })
  const totalTarget = rows.reduce((s, r) => s + r.target, 0)
  return { total: risk.total, rows, totalTarget: +totalTarget.toFixed(2) }
}

/* 目标规划的完整版在 lib/goal.js（多目标 / 目标日期 / 增删改持久化） */

/**
 * 持有以来收益率（近似）
 * ------------------------------------------------------------
 * 口径说明（诚实）：
 *   - 单基金 TWR = 从「导入日」到最新日的**累计净值**涨幅（剔除分红跳空）；
 *   - 组合 TWR = 各基金 TWR 按当前市值加权平均。
 *   ⚠️ 这是近似：账本没有逐笔申购/赎回现金流，无法做严格的日频 TWR 分割。
 *      结果标注「导入以来」与「近似」，不冒充精确 TWR。
 *
 * @param {Array} holdings 账本行（带 live 或 amount）
 * @param {Record<string, Array<{date,nav,acc_nav}>>} histByCode
 * @returns {{rows:Array<{code,name,ret,mv,startDate}>, twr:number|null, since:string|null}}
 */
export function portfolioTwr(holdings, histByCode = {}) {
  const rows = []
  let missing = 0
  let skippedJump = 0
  for (const r of holdings || []) {
    const hist = r.code ? histByCode[r.code] : null
    if (!Array.isArray(hist) || hist.length < 2) continue
    /* 字段名必须是 nav：detectJumps 按 navSanitize.js 的约定读 .nav。
       值取累计净值——分红除息不会让它跳空，不会被误判成数据源异常。 */
    const acc = hist
      .map((p) => {
        const v = p.acc_nav != null ? p.acc_nav : p.nav
        return v != null && v > 0 ? { date: p.date, nav: v } : null
      })
      .filter(Boolean)
    if (acc.length < 2) continue

    /* 起始日优先级：导入时间 → 导入时净值日期。
       ⚠️ 两者都没有就不算这只基金：退回净值历史起点会把「成立以来涨幅」
       冒充成「持有以来 TWR」。 */
    const since = r.created_at
      ? toLocalDateStr(r.created_at)
      : (r.nav_date_at_import || '').slice(0, 10)
    if (!since) {
      missing++
      continue
    }
    const start = acc.find((p) => p.date >= since)
    if (!start) {
      missing++
      continue
    }
    const last = acc[acc.length - 1]
    if (!(start.nav > 0)) continue

    /* 起始→结束跨越异常跳变：这只不参与加权。
       不拿跨口径的区间涨幅冒充持有收益。 */
    const startIdx = acc.indexOf(start)
    if (detectJumps(acc.slice(startIdx)).length > 0) {
      skippedJump++
      continue
    }

    const sh = sharesOf(r)
    const nav = r.live?.nav ?? r.nav_at_import ?? null
    const mv = r.mv != null && Number.isFinite(Number(r.mv)) ? Number(r.mv) : sh != null && nav != null ? sh * nav : r.amount ?? null

    rows.push({
      code: r.code,
      name: r.name || r.code,
      ret: +(((last.nav / start.nav) - 1) * 100).toFixed(2),
      mv,
      startDate: start.date,
    })
  }

  const total = rows.reduce((s, x) => s + (x.mv ?? 0), 0)
  const twr =
    total > 0
      ? +rows.reduce((s, x) => s + x.ret * ((x.mv ?? 0) / total), 0).toFixed(2)
      : null
  const since = rows.length ? rows.map((r) => r.startDate).sort()[0] : null
  return { rows, twr, since, missing, skippedJump }
}

/**
 * 重仓股重叠（C12 补充）
 * @param {Array} holdings 账本行
 * @param {Record<string, Array<{dm,name,ratio}>>} stocksByCode 每只基金前十大重仓股
 * @returns {Array<{a,b,count,weight,common}>} 按重叠权重降序
 *   weight = Σ min(两只基金各自权重)，代表「实际重叠的仓位」
 */
export function stockOverlap(holdings, stocksByCode = {}) {
  const list = (holdings || []).filter(
    (r) => r.code && Array.isArray(stocksByCode[r.code]) && stocksByCode[r.code].length > 0,
  )
  const pairs = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = stocksByCode[list[i].code]
      const b = stocksByCode[list[j].code]
      const bMap = new Map(b.map((s) => [s.dm, s]))
      const common = []
      for (const s of a) {
        const t = bMap.get(s.dm)
        if (!t) continue
        common.push({
          name: s.name || s.dm,
          ratioA: s.ratio,
          ratioB: t.ratio,
        })
      }
      if (common.length === 0) continue
      const weight = common.reduce((sum, c) => sum + Math.min(c.ratioA, c.ratioB), 0)
      pairs.push({
        a: list[i].name || list[i].code,
        b: list[j].name || list[j].code,
        count: common.length,
        weight: +weight.toFixed(2),
        common: common.sort((x, y) => Math.min(y.ratioA, y.ratioB) - Math.min(x.ratioA, x.ratioB)),
      })
    }
  }
  return pairs.sort((x, y) => y.weight - x.weight)
}
