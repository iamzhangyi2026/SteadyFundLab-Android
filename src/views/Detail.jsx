/**
 * 基金详情页
 * ------------------------------------------------------------
 * 六段内容：
 *   ① 单位净值 + 日涨跌 + 近 90 日迷你走势（纯 SVG，不引图表库）
 *   ② 分析：区间表现 / 最大回撤 / 年化波动 + 回撤修复 + 定投回测
 *   ③ 费率
 *   ④ 费率试算 —— 申购费（外扣法）与赎回费（自然日阶梯）
 *   ⑤ 记录模拟买入
 *   ⑥ 资讯：基金公告 + 前几大重仓股新闻
 *
 * 真实持仓入口（from='holding' 或该基金已真实持有）追加两段：
 *   ⓪ 持仓条：份额 / 成本 / 市值 / 持仓涨跌幅 / 盈亏
 *   ⓪ 深度分析：六段式（核心结论 / 硬指标 / 催化事件 / 估值与业绩 / 关注信号 / 投资建议）
 *
 * ⚠️ 数据全部来自公开接口的实时抓取，只作学习与策略验证，
 *    不构成投资建议。
 * ⚠️ 区间涨幅用**累计净值**算（历史表现口径），日涨跌用**单位净值**算 ——
 *    两者口径不同，别混用。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  fetchFund,
  latestNetWorth,
  dayChange,
  rangeReturn,
  recentSeries,
  fmtNavDate,
} from '../lib/eastmoney.js'
import {
  calcPurchase,
  holdingDays,
  redeemFeeRate,
  penaltyFreeDays,
  PURCHASE_DISCOUNT,
} from '../lib/fees.js'
import Stat from '../components/Stat.jsx'
import FundAnalysis from '../components/FundAnalysis.jsx'
import FundInsight from '../components/FundInsight.jsx'
import FundNewsCard from '../components/FundNewsCard.jsx'
import DeepAnalysisCard from '../components/DeepAnalysisCard.jsx'
import FundProfileCard from '../components/FundProfileCard.jsx'
import { AiChatPanel } from '../components/AiPanel.jsx'
import { usePullRefresh } from '../lib/usePullRefresh.js'
import { loadRealHoldings, calcHolding } from '../lib/realLedger.js'
import { addSimHolding, countSimHolding } from '../lib/simLedger.js'
import { loadFundNews } from '../lib/fundNews.js'
import { drawdownRecovery, annualVol } from '../lib/navlab.js'
import { buildDeepAnalysis } from '../lib/deep_analysis.js'
import { detectJumps } from '../lib/navSanitize.js'
import { toSeries } from '../lib/navCache.js'
import { buildDecision } from '../lib/ai.js'
import { fetchHoldingsLive } from '../lib/live.js'
import { seedFund } from '../lib/seed.js'

export default function Detail({ code, from = 'watch' }) {
  /* 首屏：有内置种子就直接出数（秒开），后台再抓真实数据覆盖。
     种子只有候选池那几只，其他基金仍走 loading。 */
  const [state, setState] = useState(() => {
    const s = seedFund(code)
    return s
      ? { status: 'ok', d: s, error: null, fromSeed: true }
      : { status: 'loading', d: null, error: null }
  })
  const [reloadKey, setReloadKey] = useState(0)

  /* 这只基金是否已经真实持有 —— 按账本判断，不按入口判断。
     已经买了的基金，无论从持仓、自选还是发现点进来，都不显示
     定投回测 / 申购费试算 / 赎回费试算 / 记录模拟买入（这些是「买之前」的工具）。 */
  const isHeld = useMemo(
    () => !!code && loadRealHoldings().some((r) => r.code === code),
    [code, reloadKey],
  )
  /* 交易工具（费率试算 / 记录模拟买入）**恒显示**。
      前的逻辑是「持仓基金藏起来」（from==='holding' 或 isHeld 时不显示），
     指出这正是「买入不开放、人控没打开」——这些是纯本地沙盒操作，
     不动真钱，没有理由按持仓状态隐藏；藏了用户就失去了控制入口。 */
  const showTradeTools = true
  /* 深度分析：持仓基金默认展开；非持仓基金也能手动展开（
     要求「所有功能都开放」——不把六段式锁死在持仓入口后面）。 */
  const [deepOpen, setDeepOpen] = useState(false)
  const showDeep = from === 'holding' || isHeld || deepOpen

  // 下拉刷新：重新抓这只基金的净值
  usePullRefresh(() => setReloadKey((k) => k + 1))

  useEffect(() => {
    let alive = true
    /* 有种子先顶上（不闪骨架），没有才进 loading；
       网络结果回来后覆盖，失败则保留种子数据 + 不打断浏览。 */
    const s = seedFund(code)
    if (s) setState({ status: 'ok', d: s, error: null, fromSeed: true })
    else setState({ status: 'loading', d: null, error: null })

    fetchFund(code)
      .then((d) => alive && setState({ status: 'ok', d, error: null, fromSeed: false }))
      .catch((e) => {
        if (!alive) return
        if (s) setState({ status: 'ok', d: s, error: e.message, fromSeed: true })
        else setState({ status: 'error', d: null, error: e.message })
      })
    return () => {
      alive = false
    }
  }, [code, reloadKey])

  /* ── 全部派生数据（含 hook）统一在 early-return 之前计算 ──
     d 在 loading / error 时为 null，下面用可选链 / 空值兜底，
     保证任何渲染路径下 hook 数量一致、且不抛错。 */
  const d = state.d
  const last = d ? latestNetWorth(d.netWorth) : null
  const nav = last ? last.y : null
  const chg = d ? dayChange(d.netWorth) : null
  const cls = chg == null || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down'
  const series = d ? recentSeries(d.netWorth, 90) : []
  /* 实际渠道折扣 = 折后费率 / 原始费率；写死 1.25 折会与接口数据矛盾 */
  const impliedDiscount =
    d && d.rate && d.sourceRate && d.sourceRate > 0 ? (d.rate / d.sourceRate) * 10 : null

  /* 分析用净值序列：统一走 navCache.toSeries（与组合分析/筛选同一口径），
     不再各自手工拼 {date,nav,acc_nav}，避免多处口径漂移。 */
  const fullSeries = d ? toSeries(d) : []
  const accLast = d && d.accWorth?.length ? d.accWorth[d.accWorth.length - 1].y : null

  /* 数据源异常跳变防护：区间收益 / 回撤 / 波动凡跨越跳变点一律降级。
     不把「跨口径差值」当收益展示（001594 ：近1年 +226%）。 */
  const jumps = d ? detectJumps(fullSeries) : []
  const jumpDateSet = new Set(jumps.map((j) => j.date))
  const rangeSafe = (accWorth, days) => {
    if (!accWorth || accWorth.length < 2) return null
    const lastX = accWorth[accWorth.length - 1].x
    const start = accWorth.find((p) => p.x >= lastX - days * 86400000) || accWorth[0]
    const startDate = fmtNavDate(start.x)
    const endDate = fmtNavDate(lastX)
    for (const jd of jumpDateSet) {
      if (jd > startDate && jd <= endDate) return null
    }
    return rangeReturn(accWorth, days)
  }
  const r1y = d ? rangeSafe(d.accWorth, 365) : null
  const r6m = d ? rangeSafe(d.accWorth, 182) : null
  const r3m = d ? rangeSafe(d.accWorth, 91) : null
  const r1m = d ? rangeSafe(d.accWorth, 30) : null

  const dd = useMemo(
    () => (jumpDateSet.size > 0 ? null : drawdownRecovery(fullSeries)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullSeries, jumpDateSet.size],
  )
  const vol = useMemo(
    () => (jumpDateSet.size > 0 ? null : annualVol(fullSeries)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullSeries, jumpDateSet.size],
  )

  /* ── 深度分析（真实持仓入口） ──────────────────────────────
     持仓 / 组合数据读本机账本；实时净值走 live.js（有缓存，失败静默降级）；
     公告与重仓股新闻与资讯卡共用同一份 24h 缓存，不重复抓。 */
  const myHolding = useMemo(
    () => (showDeep && code ? loadRealHoldings().find((r) => r.code === code) || null : null),
    [showDeep, code, reloadKey],
  )
  const portfolioMv = useMemo(() => {
    if (!showDeep) return null
    const list = loadRealHoldings()
    const total = list.reduce((s, r) => s + (calcHolding(r).mv ?? 0), 0)
    return total > 0 ? total : null
  }, [showDeep, reloadKey])

  const [liveInfo, setLiveInfo] = useState(null)
  useEffect(() => {
    if (!showDeep || !code) return
    let alive = true
    fetchHoldingsLive([code], { force: false })
      .then((m) => { if (alive) setLiveInfo(m[code] || null) })
      .catch(() => {})
    return () => { alive = false }
  }, [showDeep, code, reloadKey])

  const liveNav = liveInfo?.nav ?? null
  const holdingLive = myHolding ? { ...myHolding, live: { nav: liveNav } } : null
  const holdingCalc = holdingLive ? calcHolding(holdingLive) : null

  const [deepNews, setDeepNews] = useState(null)
  useEffect(() => {
    if (!showDeep || !code) return
    let alive = true
    loadFundNews(code)
      .then((r) => { if (alive) setDeepNews(r.data) })
      .catch(() => {})
    return () => { alive = false }
  }, [showDeep, code, reloadKey])

  const deepReport = useMemo(() => {
    if (!showDeep || !d) return null
    const announcements = deepNews?.announcements || []
    const stockNews = deepNews?.stockNews || []
    const catalysts = [
      ...announcements.map((a) => ({ kind: 'announce', title: a.title, pub_time: a.date, source: '基金公告' })),
      ...stockNews.map((n) => ({ kind: 'stock_news', title: n.title, pub_time: n.date, source: n.source || '重仓股新闻' })),
    ]
    const dividendRecords = announcements
      .filter((a) => /分红|收益分配|派息/.test(a.title || ''))
      .map((a) => ({ title: a.title, pub_time: a.date }))
    return buildDeepAnalysis({
      series: fullSeries,
      stats: { ret_1m: r1m, ret_3m: r3m, ret_6m: r6m, ret_1y: r1y, annualVol: vol, samples: d.netWorth?.length ?? 0 },
      drawdown: dd,
      position: holdingCalc
        ? {
            total_shares: myHolding.shares ?? null,
            total_cost: holdingCalc.cost,
            market_value: holdingCalc.mv,
            profit: holdingCalc.pnl,
            profit_pct: holdingCalc.pnlPct,
          }
        : null,
      portfolioMv,
      purchaseStatus: null,
      purchaseFeeRate: d.rate != null ? Number(d.rate) / 100 : null,
      dividendMethod: null,
      dividendRecords,
      catalysts,
    })
  }, [showDeep, d, fullSeries, r1m, r3m, r6m, r1y, vol, dd, holdingCalc, myHolding, portfolioMv, deepNews])

  /* 决策纪律线（B 类独有）：规则引擎，不是大模型。
     数据全部复用上面已算好的分位/趋势/回撤/仓位，不额外发请求。 */
  const decision = useMemo(() => {
    if (!showDeep || !d) return null
    return buildDecision({
      name: d.name,
      percentile: deepReport?.percentile ?? null,
      ret1y: r1y,
      mdd: dd?.maxDrawdown ?? null,
      vol,
      weightPct:
        holdingCalc?.mv != null && portfolioMv
          ? (holdingCalc.mv / portfolioMv) * 100
          : null,
    })
  }, [showDeep, d, deepReport, r1y, dd, vol, holdingCalc, portfolioMv])

  /* ── early returns：必须在所有 hook 之后 ── */
  if (state.status === 'loading') {
    return (
      <>
        <div className="card">
          <div className="skeleton" style={{ height: 34, width: '55%', marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 13, width: '35%' }} />
          <div className="skeleton" style={{ height: 72, marginTop: 16 }} />
        </div>
        <div className="card">
          <div className="skeleton" style={{ height: 96 }} />
        </div>
      </>
    )
  }

  if (state.status === 'error' || !state.d) {
    return (
      <div className="card">
        <div className="callout danger">抓取失败：{state.error}</div>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <div className="hero-label">单位净值</div>
        <div className="hero-row">
          <div className="hero-num">{last ? last.y.toFixed(4) : '—'}</div>
          <div className={`pill ${cls}`} style={{ marginBottom: 6 }}>
            {chg == null ? '—' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`}
          </div>
        </div>
        <div className="card-note" style={{ marginTop: 6 }}>
          {d.name} · <span className="num">{d.code}</span>
          {last ? ` · ${fmtNavDate(last.x)}` : ''}
        </div>

        {showDeep && (liveInfo?.estNav != null || liveInfo?.pct != null) ? (
          <div className="card-note" style={{ marginTop: 2 }}>
            实时估算{' '}
            <span className="num">
              {liveInfo?.estNav != null ? liveInfo.estNav.toFixed(4) : '—'}
            </span>
            {' · '}
            <span className={pctCls(liveInfo?.pct)}>
              {liveInfo?.pct != null
                ? `${liveInfo.pct > 0 ? '+' : ''}${liveInfo.pct.toFixed(2)}%`
                : '—'}
            </span>
            {liveInfo?.pctFrom
              ? ` · ${liveInfo.pctFrom === 'index' ? '跟踪指数' : liveInfo.pctFrom === 'stocks' ? '重仓股加权' : '净值日涨跌'}`
              : ''}
          </div>
        ) : null}

        {series.length > 1 && <Sparkline data={series} up={(chg ?? 0) >= 0} />}
      </div>

      <div className="section-title">区间表现</div>
      <div className="card plain" style={{ padding: 0 }}>
        <div className="stat-grid" style={{ marginTop: 0 }}>
          <Stat k="近 1 年" v={fmtPct(r1y)} cls={pctCls(r1y)} />
          <Stat k="近 6 月" v={fmtPct(r6m)} cls={pctCls(r6m)} />
          <Stat k="近 3 月" v={fmtPct(r3m)} cls={pctCls(r3m)} />
          <Stat k="历史净值" v={`${d.netWorth.length} 条`} />
        </div>
        {jumps.length > 0 ? (
          <div className="callout warn" style={{ margin: '0 12px 12px' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>数据源异常，区间收益与回撤暂不计算</div>
            {jumps.slice(0, 3).map((j, i) => (
              <div key={i} style={{ fontSize: 'var(--fs-kicker)', lineHeight: 1.6 }}>
                {j.prevDate} → {j.date} 净值 {j.from} → {j.to}（{j.pct > 0 ? '+' : ''}
                {j.pct}%）
              </div>
            ))}
            <div style={{ fontSize: 'var(--fs-kicker)', marginTop: 4 }}>
              单日涨跌超出正常公募范围（涨跌停 ±10% 传导），疑为数据源口径变更或错误，
              已不据此计算，也不把跨口径差值当收益。
            </div>
          </div>
        ) : null}
      </div>

      <FundAnalysis
        series={fullSeries}
        accNav={accLast}
        latestDate={last ? fmtNavDate(last.x) : ''}
        dataDays={d.netWorth?.length ?? 0}
        m1={r1m}
        showBacktest={showTradeTools}
      />

      {/* 深度分析：非持仓基金可手动展开（不锁在持仓入口后面） */}
      {!showDeep ? (
        <div className="card">
          <button className="btn btn-block" onClick={() => setDeepOpen(true)}>
            查看深度分析（位置 / 趋势 / 硬指标 / 分红 / 信号 / 建议）
          </button>
        </div>
      ) : null}

      {/* 深度分析（真实持仓入口）：持仓条 + 六段式 */}
      {showDeep ? (
        <>
          <div className="section-title">持仓</div>
          <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {myHolding && holdingCalc ? (
              <>
                <div className="da-row">
                  <span className="da-row-k">份额</span>
                  <span className="da-row-v">
                    <b>{myHolding.shares != null ? `${myHolding.shares.toFixed(2)} 份` : '未提供（截图无份额）'}</b>
                    <small>成本 ¥{(holdingCalc.cost ?? 0).toFixed(2)} → 市值 ¥{(holdingCalc.mv ?? 0).toFixed(2)}</small>
                  </span>
                </div>
                <div className="da-row">
                  <span className="da-row-k">持仓涨跌</span>
                  <span className="da-row-v">
                    <b className={holdingCalc.pnlPct == null ? '' : holdingCalc.pnlPct > 0 ? 'up' : 'down'}>
                      {holdingCalc.pnlPct != null ? `${holdingCalc.pnlPct > 0 ? '+' : ''}${holdingCalc.pnlPct.toFixed(2)}%` : '—'}
                    </b>
                    <small>
                      盈亏 {holdingCalc.pnl != null ? `${holdingCalc.pnl > 0 ? '+' : ''}${holdingCalc.pnl.toFixed(2)}` : '—'} 元
                      {chg != null ? ` · 当日净值 ${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` : ''}
                    </small>
                  </span>
                </div>
              </>
            ) : (
              <div className="card-note" style={{ padding: '6px 2px', lineHeight: 1.7 }}>
                未查询到该基金的真实持仓记录（账本中没有这只基金）。
              </div>
            )}
          </div>
          <DeepAnalysisCard report={deepReport} />
          <DecisionCard decision={decision} />
        </>
      ) : null}

      {/* 穿透分析：行业配置 + 集中度 + 风格漂移 + 人读叙述 */}
      <FundInsight code={d.code} name={d.name || ''} />

      {/* AI 分析：密钥由用户自填；未配置时只显示设置引导 */}
      <AiChatPanel
        context={{
          name: d.name,
          code: d.code,
          percentile: deepReport?.percentile ?? null,
          ret1y: r1y,
          ret6m: r6m,
          maxDrawdown: dd?.maxDrawdown ?? null,
          annualVol: vol,
          weightPct:
            holdingCalc?.mv != null && portfolioMv
              ? +((holdingCalc.mv / portfolioMv) * 100).toFixed(1)
              : null,
          shares: myHolding?.shares ?? null,
          cost: holdingCalc?.cost ?? null,
          marketValue: holdingCalc?.mv ?? null,
          profitPct: holdingCalc?.pnlPct ?? null,
        }}
      />

      <div className="section-title">基金档案</div>
      <FundProfileCard code={d.code} />

      <div className="section-title">费率</div>
      <div className="card plain" style={{ padding: 0 }}>
        <div className="stat-grid" style={{ marginTop: 0 }}>
          <Stat k="原始费率" v={`${d.sourceRate ?? '—'}%`} />
          <Stat k="折后费率" v={`${d.rate ?? '—'}%`} cls="down" />
          <Stat k="持仓股票" v={`${d.stockCodes?.length ?? 0} 只`} />
          <Stat k="渠道折扣" v={impliedDiscount ? `${impliedDiscount.toFixed(2)} 折` : '—'} />
        </div>
      </div>

      {showTradeTools ? (
        <>
          <FeeBlock ratePct={d.rate ?? (d.sourceRate ?? 1.5) * PURCHASE_DISCOUNT * 100} nav={nav} />
          <RecordBuyBlock d={d} />
        </>
      ) : null}

      <FundNewsCard code={d.code} name={d.name} />
    </>
  )
}

/** 决策纪律线（规则引擎，不是大模型） */
function DecisionCard({ decision }) {
  if (!decision) return null
  return (
    <>
      <div className="section-title">决策纪律线</div>
      <div className="card">
        <div className="da-verdict">
          <strong>{decision.verdict}</strong>
          <span>{decision.modeLabel}</span>
        </div>
        {decision.lines.map((l, i) => (
          <div className={'dec-line dec-' + l.kind} key={i}>
            <b>{l.title}</b>
            <span>{l.text}</span>
          </div>
        ))}
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          {decision.disclaimer}
        </p>
      </div>
    </>
  )
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
}
function pctCls(v) {
  if (v == null || !Number.isFinite(v) || v === 0) return 'flat'
  return v > 0 ? 'up' : 'down'
}

/** 迷你走势图 —— 纯 SVG，不引图表库 */
function Sparkline({ data, up }) {
  const w = 300
  const h = 72
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w
      const y = h - 6 - ((v - min) / span) * (h - 12)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  const color = up ? 'var(--up)' : 'var(--down)'
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: h, marginTop: 'var(--space-3)', display: 'block' }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** 取相对今天偏移 n 天的本地日期（YYYY-MM-DD，n 为负表示过去） */
function dateOffset(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 费率试算（申购 + 赎回）
 *  ratePct：折后实收费率（%），直接参与计算、不再打渠道折扣
 *  nav：当前单位净值，用于把净申购金额折算成确认份额 */
function FeeBlock({ ratePct, nav }) {
  const [amount, setAmount] = useState(10000)
  /* 默认给「8 天前确认、今天赎回」—— 一打开就有个能看出结论的示例：
     持有 8 天刚好越过 7 天惩罚线，费率从 1.5% 掉到 0.75%。
     （原先写的是固定日期，日子久了会显得莫名其妙） */
  const [confirmDate, setConfirmDate] = useState(() => dateOffset(-8))
  const [redeemDate, setRedeemDate] = useState(() => dateOffset(0))

  const rateOk = Number.isFinite(ratePct) && ratePct >= 0
  const p = rateOk ? calcPurchase(amount, ratePct / 100, 1) : null
  const shares = p && nav > 0 ? p.netAmount / nav : null
  const days = Math.max(0, holdingDays(confirmDate, redeemDate))
  const { rate, isPenalty } = redeemFeeRate(days)
  const free = penaltyFreeDays()
  const toFree = Math.max(0, free - days)

  return (
    <>
      <div className="section-title">申购费试算（外扣法）</div>
      <div className="card">
        <label className="field">
          <span>申购金额（元）</span>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </label>
        <div className="stat-grid">
          <Stat k="实收费率" v={p ? `${(p.rate * 100).toFixed(4)}%` : '—'} />
          <Stat k="净申购金额" v={p ? `${p.netAmount.toFixed(2)} 元` : '—'} />
          <Stat k="申购费" v={p ? `${p.fee.toFixed(2)} 元` : '—'} cls="up" />
          <Stat k="确认份额" v={shares ? `${shares.toFixed(2)} 份` : '—'} />
        </div>
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          外扣法：申购费 = 金额 − 金额 ÷ (1 + 费率)。不是「金额 × 费率」，差的那部分是真金白银。
          {shares ? '' : ' 缺单位净值或费率时份额无法折算，显示为空。'}
        </p>
      </div>

      <div className="section-title">赎回费试算（自然日）</div>
      <div className="card">
        <label className="field">
          <span>份额确认日</span>
          <input
            type="date"
            value={confirmDate}
            onChange={(e) => setConfirmDate(e.target.value)}
          />
        </label>
        <label className="field">
          <span>赎回日</span>
          <input type="date" value={redeemDate} onChange={(e) => setRedeemDate(e.target.value)} />
        </label>
        <div className="stat-grid">
          <Stat k="持有天数" v={`${days} 天`} />
          <Stat
            k="适用费率"
            v={`${(rate * 100).toFixed(2)}%${isPenalty ? ' 惩罚' : ''}`}
            cls={isPenalty ? 'up' : undefined}
          />
          <Stat k="免罚门槛" v={`${free} 天`} />
          <Stat k="状态" v={toFree > 0 ? `还差 ${toFree} 天` : '已免罚'} cls={toFree > 0 ? 'up' : 'down'} />
        </div>
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          持有天数按自然日算，不是交易日。7 天内赎回收 1.5% 惩罚性费率。
        </p>
      </div>
    </>
  )
}

/** 记录模拟买入：按当前单位净值折算份额，写入本机「模拟持仓」 */
function RecordBuyBlock({ d }) {
  const [amount, setAmount] = useState(10000)
  const [msg, setMsg] = useState(null)
  const last = latestNetWorth(d.netWorth)
  const nav = last ? last.y : null
  const navDate = last ? fmtNavDate(last.x) : null
  /* 费率口径：接口的 fund_Rate 已是**折后实收**费率，直接用、不再打渠道折扣
     （二次打折会少算一大截）；拿不到折后费率才回退原始费率，那时走默认折扣 */
  const hasDiscounted = d.rate != null && Number.isFinite(Number(d.rate)) && Number(d.rate) >= 0
  const ratePct = hasDiscounted ? Number(d.rate) : (d.sourceRate != null ? Number(d.sourceRate) : null)
  const amt = Number(amount)
  const valid = Number.isFinite(amt) && amt > 0 && nav != null && nav > 0 && ratePct != null && Number.isFinite(ratePct) && ratePct >= 0
  const p = valid ? calcPurchase(amt, ratePct / 100, hasDiscounted ? 1 : PURCHASE_DISCOUNT) : null
  const done = countSimHolding(d.code)

  function save() {
    if (!valid || !p) return
    const ok = addSimHolding({
      id: `${d.code}-${Date.now()}`,
      code: d.code,
      name: d.name,
      nav_date: navDate,
      nav,
      rate: ratePct,
      amount: amt,
      fee: p.fee,
      shares: p.netAmount / nav,
      created_at: fmtNavDate(Date.now()),
    })
    setMsg(
      ok
        ? { ok: true, text: `已记录：¥${amt.toLocaleString('zh-CN')} → ${(p.netAmount / nav).toFixed(2)} 份（申购费 ${p.fee.toFixed(2)} 元）` }
        : { ok: false, text: '写入失败：本机存储不可用' },
    )
  }

  return (
    <>
      <div className="section-title">记录模拟买入</div>
      <div className="card">
        <p className="card-note" style={{ marginTop: 0 }}>
          按当前单位净值折算份额，写入本机「模拟持仓」。沙盒推演，不动真钱。
        </p>
        <label className="field">
          <span>申购金额（元）</span>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </label>
        <div className="stat-grid">
          <Stat k="净值日" v={navDate ?? '—'} />
          <Stat k="单位净值" v={nav != null ? nav.toFixed(4) : '—'} />
          <Stat k="适用费率" v={ratePct != null ? `${ratePct}%（折后实收）` : '—'} />
          <Stat k="申购费（外扣）" v={p ? `${p.fee.toFixed(2)} 元` : '—'} cls="up" />
          <Stat k="确认份额" v={p ? `${(p.netAmount / nav).toFixed(2)} 份` : '—'} />
        </div>
        <button className="btn btn-primary btn-block" style={{ marginTop: 'var(--space-3)' }} disabled={!valid} onClick={save}>
          记录到模拟持仓
        </button>
        {done > 0 && (
          <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>该基金已记录 {done} 笔</p>
        )}
        {msg && <div className={`callout ${msg.ok ? 'teal' : 'danger'}`} style={{ marginTop: 'var(--space-3)' }}>{msg.text}</div>}
      </div>
    </>
  )
}
