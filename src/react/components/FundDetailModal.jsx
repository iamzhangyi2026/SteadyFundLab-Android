import { useCallback, useEffect, useMemo, useState } from 'react'
import NetValueChart from './NetValueChart'
import FundProfileCard from './FundProfileCard'
import DeepAnalysisCard from './DeepAnalysisCard'
import EmptyState from './EmptyState'
import { money, pct, cls, date } from '../lib/format'
import { psClass } from '../lib/purchaseStatus'
import { drawdownRecovery, dingtouBacktest, FREQ_LABEL, WINDOW_LABEL } from '../lib/navlab'
import { fetchFundNavBundle, fetchFundTopHoldingsList, fetchFundAnnouncements, jsEvaluateFund, fetchFundEstimate, fetchFundManager, jsFundIndustryAllocation, fetchPositions, buildDeepAnalysisReport } from '../lib/dataAdapter'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'

// 基金详情弹窗：持仓条（真实持仓入口）+ 净值曲线 + 核心指标 + 六段式深度分析
// + 回撤修复 + 前十大重仓 + 行业配置 + 公告。
// 对标支付宝基金详情页里评分最高的能力——回撤修复（★★★★），
// 但补上它的黑榜短板：支付宝把「夏普比率」这类术语直接摆在标签上、
// 解释藏进抽屉弹窗，小白看不懂就划走了。这里每个指标都能就地看懂。
// 「前十大重仓」卡：最新季报，打开即拉、可手动强制刷新。
// 「深度分析」卡：core/deep_analysis.ts 代码规则生成六段式结论，只挂真实持仓入口。

// 指标词典：术语必须能就地看懂
const METRIC_HELP = {
  accNav: '累计净值＝把历史上的分红重新投进去之后的净值，比「单位净值」（当天每份的价格）更能反映你真实拿到手的收益。看长期收益请认准它。',
  ret: '到今天为止，往前推对应时间段的涨幅。比如「近1年 +12.30%」＝一年前买入并持有到今天赚 12.30%。',
  mdd: '跌得最多（最大回撤）＝历史上从最高点跌到最低点，最深跌了多少。比如 -35.00% 表示最惨的时候比最高点亏了 35%。这是衡量「你扛不扛得住」的核心指标。',
  vol: '波动大小（年化波动率）＝净值上下蹦跶的剧烈程度，按一年折算出来的数字。数字越大越刺激、也越容易拿不住。',
  hist: '这只基金在我们库里有多少个交易日的净值数据。数据越长，上面这些统计越可信。',
}

// 回撤和波动是风险指标，不是当期涨跌——
// 沿用既有约定：不用红绿，否则「跌」的绿色会被读成「安全」。
function StatMini({ label, v, t, helpKey, help, onHelp }) {
  return (
    <div className="tile" style={{ padding: '11px 13px' }}>
      <div className="tile-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span>{label}</span>
        {helpKey && (
          <button
            type="button"
            onClick={() => onHelp(helpKey)}
            title="这个指标是什么意思？"
            aria-label={`${label} 指标说明`}
            style={{
              width: 15,
              height: 15,
              padding: 0,
              borderRadius: '50%',
              border: '1px solid var(--border, #d7dbe3)',
              background: help === helpKey ? 'var(--accent, #3b6ef6)' : 'transparent',
              color: help === helpKey ? '#fff' : 'var(--text-mute, #5b6675)',
              fontSize: 10,
              lineHeight: 1,
              cursor: 'pointer',
              flex: '0 0 auto',
            }}
          >
            ?
          </button>
        )}
      </div>
      <div
        className={`tile-value status-num ${t === 'up' ? 'tone-up' : t === 'down' ? 'tone-down' : ''}`}
        style={{ fontSize: 'var(--fs-tile, 23px)' }}
      >
        {v}
      </div>
    </div>
  )
}

// 回撤修复：直面负面数据，回答「最深跌多少 / 跌了多久 / 多久才回本」
function DrawdownCard({ dd }) {
  if (!dd) return null
  const title = (
    <div className="subhead">
      回撤修复
      <span className="muted cell-note">历史上最深的那次下跌</span>
    </div>
  )

  if (dd.flat) {
    return (
      <div className="sub-card" style={{ marginTop: 12 }}>
        {title}
        <div className="muted cell-note" style={{ lineHeight: 1.7 }}>
          这段历史里净值一路上行，没有出现明显下跌。
        </div>
      </div>
    )
  }

  return (
    <div className="sub-card" style={{ marginTop: 12 }}>
      {title}
      <div className="tile-grid">
        <StatMini label="跌得最多" v={pct(dd.maxDrawdown)} helpKey="mdd" help={null} onHelp={() => {}} />
        <StatMini label="连跌天数" v={dd.declineDays != null ? `${dd.declineDays} 天` : '—'} />
        <StatMini
          label={dd.recovered ? '涨回用时' : '还没涨回'}
          v={dd.recovered ? `${dd.recoveryDays} 天` : dd.pendingDays != null ? `${dd.pendingDays} 天` : '—'}
        />
      </div>
      <div className="muted cell-note" style={{ marginTop: 9, lineHeight: 1.75 }}>
        {date(dd.peakDate)} 高点 <b>{dd.peakValue}</b> → {date(dd.troughDate)} 低点 <b>{dd.troughValue}</b>；
        {dd.recovered ? (
          <>
            之后用了 <b>{dd.recoveryDays} 天</b>，在 {date(dd.recoveryDate)} 涨回原位；整轮从峰顶到收复共{' '}
            <b>{dd.roundTripDays} 天</b>。
          </>
        ) : (
          <>
            截至 {date(dd.lastDate)}（最新 {dd.lastValue}）仍未收复，从谷底算起已经熬了{' '}
            <b>{dd.pendingDays} 天</b>。
          </>
        )}
      </div>
    </div>
  )
}

// 定投回测：用真实净值模拟定期定额买入，并与同期一把梭对比
function BacktestCard({ series }) {
  const [amount, setAmount] = useState(500)
  const [freq, setFreq] = useState('monthly')
  const [win, setWin] = useState(730)
  const r = useMemo(
    () => dingtouBacktest(series, { amount: Number(amount) || 0, frequency: freq, windowDays: Number(win) }),
    [series, amount, freq, win],
  )
  return (
    <div className="sub-card" style={{ marginTop: 12 }}>
      <div className="subhead">
        定投模拟
        <span className="muted cell-note">用真实净值模拟，和一次性买入对比</span>
      </div>
      <div className="dt-form">
        <div className="field">
          <label>每期金额（元）</label>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)} onBlur={e => setAmount(e.target.value)} placeholder="500" />
        </div>
        <div className="field">
          <label>频率</label>
          <select value={freq} onChange={e => setFreq(e.target.value)}>
            {Object.keys(FREQ_LABEL).map(k => <option key={k} value={k}>{FREQ_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="field">
          <label>模拟多长时间</label>
          <select value={String(win)} onChange={e => setWin(e.target.value)}>
            {Object.keys(WINDOW_LABEL).map(k => <option key={k} value={k}>{WINDOW_LABEL[k]}</option>)}
          </select>
        </div>
      </div>
      {!r ? (
        <div className="muted cell-note" style={{ marginTop: 8 }}>这段区间的净值数据不够，换个更长的区间试试。</div>
      ) : (
        <>
          <div className="tile-grid" style={{ marginTop: 8 }}>
            <StatMini label="投了多少期" v={`${r.periods} 期`} />
            <StatMini label="一共投了" v={money(r.invest, 0)} />
            <StatMini label="期末值多少钱" v={money(r.marketValue, 0)} />
            <StatMini label="定投收益率" v={pct(r.roi)} t={cls(r.roi)} />
            <StatMini label="一次性买入收益率" v={pct(r.lumpRoi)} t={cls(r.lumpRoi)} />
            <StatMini label="比一次性买入" v={pct(r.edge)} t={cls(r.edge)} />
          </div>
          <div className="muted cell-note" style={{ marginTop: 9, lineHeight: 1.75 }}>
            {date(r.startDate)} 至 {date(r.endDate)}（{r.days} 天，净值 {r.startValue} → {r.endValue}）：
            按 <b>{FREQ_LABEL[freq]}</b> 投 <b>{money(Number(amount) || 0, 0)}</b>，共 {r.periods} 期、
            投入 {money(r.invest, 0)}，期末 {money(r.marketValue, 0)}；
            同样多的钱在期初一把梭，期末是 {money(r.lumpValue, 0)}。
          </div>
        </>
      )}
    </div>
  )
}

// 基金公告：只看这只基金自己的公告（人事变更 / 分红等，东财源）。
// 数据由本地抓取调度入库（启动即抓 + 定期续抓），这里只读不联网。
// 持仓基金公告并入各自基金的详情弹窗，放在弹窗最后。
function AnnouncementsCard({ code, open }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!code) return
    setLoading(true)
    try {
      const r = await fetchFundAnnouncements(code)
      setData(r.ok ? { items: r.data } : null)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => {
    if (!open || !code) return
    setData(null)
    load()
  }, [open, code, load])
  // 下拉刷新
  useEffect(() => registerPullRefresh(load), [load])

  const items = data?.items || []

  return (
    <div className="sub-card" style={{ marginTop: 12 }}>
      <div className="subhead">
        基金公告
        <span className="muted cell-note">人事变更 / 分红等官方公告</span>
        <button
          type="button"
          className="link-btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => load()}
          disabled={loading}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="muted cell-note" style={{ lineHeight: 1.7 }}>
          {loading ? '公告加载中…' : '暂无公告：这只基金近期没有抓取到的人事变更 / 分红公告。'}
        </div>
      ) : (
        <>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {items.map((it, i) => (
              <li
                key={`${it.pub_time}-${i}`}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 10,
                  padding: '7px 0', borderBottom: '1px solid rgba(0,0,0,0.05)',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.55, flex: 1 }}>{it.title}</span>
                <span className="muted cell-note" style={{ flex: '0 0 auto', textAlign: 'right' }}>
                  {it.pub_time || ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="muted cell-note" style={{ marginTop: 8, lineHeight: 1.7 }}>
            公告来自东方财富基金频道，自动抓取（启动即抓、每 3 小时续抓），只展示这只基金自己的公告。
          </div>
        </>
      )}
    </div>
  )
}

// 前十大重仓：读本地 fund_holdings（最新季报），本地为空时按需抓取一次；数据走纯本地 SQLite。
function TopHoldingsCard({ code, open }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [reportDate, setReportDate] = useState(null)

  const load = useCallback(async (fetchIfEmpty) => {
    if (!code) return
    setLoading(true)
    try {
      const r = await fetchFundTopHoldingsList(code, { fetchIfEmpty })
      const list = r.ok ? r.data : []
      setItems(list)
      setReportDate(list.length ? list[0].report_date : null)
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => {
    if (!open || !code) return
    setItems([])
    setReportDate(null)
    // 打开即尝试：本地为空时自动抓一次
    load(true)
  }, [open, code, load])
  // 下拉刷新（强制抓最新）
  useEffect(() => registerPullRefresh(() => load(true)), [load])

  const maxW = items.reduce((m, it) => Math.max(m, it.weight || 0), 0)

  return (
    <div className="sub-card" style={{ marginTop: 12 }}>
      <div className="subhead">
        前十大重仓
        <span className="muted cell-note">最新季报{reportDate ? ` · ${date(reportDate)}` : ''}</span>
        <button
          type="button"
          className="link-btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => load(true)}
          disabled={loading}
        >
          {loading ? '抓取中…' : '刷新'}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="muted cell-note" style={{ lineHeight: 1.7 }}>
          {loading ? '正在抓取重仓股…' : '暂无重仓数据：点「刷新」抓取一次（数据来自基金季报）。'}
        </div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {items.map((it, i) => (
            <li
              key={`${it.stock_code}-${i}`}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}
            >
              <span className="muted cell-note" style={{ flex: '0 0 20px' }}>{i + 1}</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
                {it.stock_name || it.stock_code}
                <span className="muted cell-note" style={{ marginLeft: 6 }}>{it.stock_code}</span>
              </span>
              <span style={{ flex: '0 0 70px', height: 6, borderRadius: 3, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                <span
                  style={{
                    display: 'block', height: '100%',
                    width: `${maxW > 0 ? Math.max(4, (it.weight / maxW) * 100) : 0}%`,
                    background: 'var(--accent, #3b6ef6)',
                  }}
                />
              </span>
              <span style={{ flex: '0 0 54px', textAlign: 'right', fontSize: 13, fontWeight: 600, fontFeatureSettings: '"tnum"' }}>
                {(it.weight ?? 0).toFixed(2)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// 行业配置（穿透）：这只基金的钱到底押在哪些行业 —— 最新季报。
// 抓不到就照实说「暂无」，不编造（东财 F10 行业配置接口，必须带 fundf10 Referer）。
function IndustryCard({ code, open }) {
  const [items, setItems] = useState([])
  const [reportDate, setReportDate] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (force) => {
    if (!code) return
    setLoading(true)
    try {
      const r = await jsFundIndustryAllocation(code, { force: !!force })
      setItems(r.ok ? (r.data || []) : [])
      setReportDate(r.report_date || null)
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => {
    if (!open || !code) return
    setItems([])
    setReportDate(null)
    load()
  }, [open, code, load])
  // 下拉刷新（强制抓最新）
  useEffect(() => registerPullRefresh(() => load(true)), [load])

  const maxW = items.reduce((m, it) => Math.max(m, it.weight || 0), 0)

  return (
    <div className="sub-card" style={{ marginTop: 12 }}>
      <div className="subhead">
        行业配置
        <span className="muted cell-note">最新季报{reportDate ? ` · ${date(reportDate)}` : ''}</span>
        <button
          type="button"
          className="link-btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => load(true)}
          disabled={loading}
        >
          {loading ? '抓取中…' : '刷新'}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="muted cell-note" style={{ lineHeight: 1.7 }}>
          {loading ? '正在抓取行业配置…' : '暂无行业配置数据：点「刷新」抓取一次（数据来自基金季报）。'}
        </div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {items.slice(0, 12).map((it, i) => (
            <li
              key={`${it.industry}-${i}`}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}
            >
              <span className="muted cell-note" style={{ flex: '0 0 20px' }}>{i + 1}</span>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.5 }}>{it.industry}</span>
              <span style={{ flex: '0 0 70px', height: 6, borderRadius: 3, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                <span
                  style={{
                    display: 'block', height: '100%',
                    width: `${maxW > 0 ? Math.max(4, (it.weight / maxW) * 100) : 0}%`,
                    background: 'var(--accent, #3b6ef6)',
                  }}
                />
              </span>
              <span style={{ flex: '0 0 54px', textAlign: 'right', fontSize: 13, fontWeight: 600, fontFeatureSettings: '"tnum"' }}>
                {(it.weight ?? 0).toFixed(2)}%
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="muted cell-note" style={{ marginTop: 6, lineHeight: 1.6 }}>
        各行业占基金净值的比例（最新报告期，只列占比大于 0 的）。
      </div>
    </div>
  )
}

// 基金详情（安卓二级页正文）：净值曲线 + 核心指标 + 回撤修复 + 前十大重仓 + 公告。
// 作为导航栈里的全屏二级页渲染（非居中弹窗），
// 由 MobileLayout 的 NavBar 提供顶栏与返回，安卓物理返回键也能正确关掉它。
// realEntry=true 表示从真实持仓入口进来：顶部展示持仓条，并挂载六段式深度分析。
export default function FundDetailBody({ code, name, onBuy, onSell, realEntry = false }) {
  const [nav, setNav] = useState(null)
  const [loading, setLoading] = useState(false)
  const [help, setHelp] = useState(null)
  const [screen, setScreen] = useState(null)   // 项目筛选结论
  const [estimate, setEstimate] = useState(null) // 盘中实时估值
  const [manager, setManager] = useState(null) // 基金经理（现任）
  const [position, setPosition] = useState(null) // 真实持仓行（仅 realEntry）
  const [portfolioMv, setPortfolioMv] = useState(null) // 真实持仓组合总市值
  const [deep, setDeep] = useState(null) // 六段式深度分析结果

  // 下拉刷新：tick 变化 → 重新拉净值 / 筛选结论 / 估值 / 基金经理
  const [tick, setTick] = useState(0)
  useEffect(() => registerPullRefresh(() => setTick((t) => t + 1)), [])

  useEffect(() => {
    if (!code) return
    let alive = true
    setLoading(true)
    setNav(null)
    setHelp(null)
    setScreen(null)
    setEstimate(null)
    setManager(null)
    setDeep(null)
    fetchFundNavBundle(code)
      .then((r) => { if (alive) setNav(r.ok ? r.data : null) })
      .catch(() => { if (alive) setNav(null) })
      .finally(() => { if (alive) setLoading(false) })
    jsEvaluateFund(code).then((r) => { if (alive && r.ok) setScreen(r.data) }).catch(() => {})
    fetchFundEstimate(code)
      .then((r) => { if (alive && r.ok && r.data) setEstimate(r.data) })
      .catch(() => {})
    fetchFundManager(code)
      .then((r) => { if (alive && r.ok && r.data) setManager(r.data) })
      .catch(() => {})
    if (realEntry) {
      setPosition(null)
      setPortfolioMv(null)
      fetchPositions()
        .then((r) => {
          if (!alive) return
          const reals = (r.ok ? r.data : []).filter((p) => p.source === 'real' && p.fund_code === code)
          const mine = reals[0] ?? null
          setPosition(mine)
          const total = (r.ok ? r.data : []).filter((p) => p.source === 'real')
            .reduce((s, p) => s + (p.market_value ?? 0), 0)
          setPortfolioMv(total > 0 ? total : null)
        })
        .catch(() => {})
    }
    return () => { alive = false }
  }, [code, tick, realEntry])

  // 深度分析：净值包 + 持仓到位后组装（真实持仓入口才有）
  useEffect(() => {
    if (!realEntry || !code || !nav) return
    let alive = true
    setDeep(null)
    const dd = drawdownRecovery(nav.series || [])
    buildDeepAnalysisReport(code, {
      navBundle: nav,
      drawdown: dd,
      position: position
        ? {
            total_shares: position.total_shares,
            total_cost: position.total_cost,
            market_value: position.market_value,
            profit: position.profit,
            profit_pct: position.profit_pct,
          }
        : null,
      portfolioMv,
    })
      .then((r) => { if (alive) setDeep(r.ok ? r.data : null) })
      .catch(() => { if (alive) setDeep(null) })
    return () => { alive = false }
  }, [realEntry, code, nav, position, portfolioMv])

  const series = nav?.series || []
  const stats = nav?.stats || {}
  const dd = useMemo(() => drawdownRecovery(series), [series])

  // 当日净值涨跌幅（最新单位净值相对前一交易日；不把累计收益率误标为当日）
  const dayChange = useMemo(() => {
    const pts = series.filter((d) => d.nav > 0)
    if (pts.length < 2) return null
    return ((pts[pts.length - 1].nav / pts[pts.length - 2].nav) - 1) * 100
  }, [series])

  // 申购状态：详情页必须标（暂停/限大额随时变），直接读净值记录挂的申购状态字段
  const ps = nav?.purchase_status
  const paused = ps === '暂停申购'
  const limited = ps === '限大额'

  const toggleHelp = (k) => setHelp((h) => (h === k ? null : k))

  return (
    <div className="modal-body-wide">
              {loading && <div className="loading">加载净值数据…</div>}
              {!loading && !nav && (
                <EmptyState title="暂无净值数据" hint="这只基金还没有入库的历史净值，先在「交易」页添加并抓取" />
              )}
              {!loading && nav && (
                <div>
                  {/* 持仓条（仅真实持仓入口）：份额 / 成本 / 市值 / 涨跌幅 / 盈亏 */}
                  {realEntry && position && (
                    <div className="sub-card" style={{ marginTop: 12 }}>
                      <div className="subhead">
                        我的持仓
                        <span className="muted cell-note">截图导入 · 以修改后的份额成本为准</span>
                      </div>
                      <div className="tile-grid">
                        <div className="tile" style={{ padding: '11px 13px' }}>
                          <div className="tile-label">份额</div>
                          <div className="tile-value" style={{ fontSize: 'var(--fs-tile, 23px)' }}>{position.total_shares.toFixed(2)}</div>
                        </div>
                        <div className="tile" style={{ padding: '11px 13px' }}>
                          <div className="tile-label">成本</div>
                          <div className="tile-value" style={{ fontSize: 'var(--fs-tile, 23px)' }}>{money(position.total_cost, 0)}</div>
                        </div>
                        <div className="tile" style={{ padding: '11px 13px' }}>
                          <div className="tile-label">市值</div>
                          <div className="tile-value" style={{ fontSize: 'var(--fs-tile, 23px)' }}>{money(position.market_value, 0)}</div>
                        </div>
                        <div className="tile" style={{ padding: '11px 13px' }}>
                          <div className="tile-label">持仓涨跌幅</div>
                          <div
                            className={`tile-value status-num ${position.profit_pct > 0 ? 'tone-up' : position.profit_pct < 0 ? 'tone-down' : ''}`}
                            style={{ fontSize: 'var(--fs-tile, 23px)' }}
                          >
                            {pct(position.profit_pct)}
                          </div>
                        </div>
                        <div className="tile" style={{ padding: '11px 13px' }}>
                          <div className="tile-label">盈亏</div>
                          <div
                            className={`tile-value status-num ${position.profit > 0 ? 'tone-up' : position.profit < 0 ? 'tone-down' : ''}`}
                            style={{ fontSize: 'var(--fs-tile, 23px)' }}
                          >
                            {position.profit != null ? `${position.profit >= 0 ? '+' : ''}${money(position.profit, 0)}` : '—'}
                          </div>
                        </div>
                      </div>
                      {dayChange != null && (
                        <div className="muted cell-note" style={{ marginTop: 6, lineHeight: 1.6 }}>
                          当日净值 <span className={cls(dayChange)}>{pct(dayChange)}</span>（{date(stats.latest_date)}，相对前一交易日）
                        </div>
                      )}
                    </div>
                  )}

                  <NetValueChart
                    categories={series.map((d) => d.date)}
                    values={series.map((d) => d.acc_nav)}
                    height={160}
                    label={`${name || code} 累计净值曲线`}
                  />

                  {/* 盘中实时估值（仅交易时段有真实估算值时显示，避免造假） */}
                  {estimate?.live && (
                    <div className="fund-est" style={{ marginTop: 8 }}>
                      <span className="fund-est-label">盘中估值</span>
                      <span className="fund-est-value">{Number(estimate.estimate).toFixed(4)}</span>
                      <span className={`fund-est-pct ${estimate.estimate_pct >= 0 ? 'pos' : 'neg'}`}>
                        {estimate.estimate_pct >= 0 ? '+' : ''}{estimate.estimate_pct.toFixed(2)}%
                      </span>
                      <span className="fund-est-time">估值 {String(estimate.estimate_time || '').slice(5, 16)}</span>
                    </div>
                  )}

                  {ps && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <span className={`tag ${psClass(ps)}`}>
                        {ps}
                      </span>
                      {limited && nav?.purchase_limit != null && (
                        <span className="text-warn" style={{ fontWeight: 600, fontSize: 12 }}>单日上限 ¥{nav.purchase_limit}</span>
                      )}
                      {paused && <span className="text-danger" style={{ fontWeight: 600, fontSize: 12 }}>暂不可买入</span>}
                      {nav?.redeem_status && nav.redeem_status !== '开放赎回' && (
                        <span className="muted cell-note">赎回：{nav.redeem_status}</span>
                      )}
                    </div>
                  )}

                  <div className="tile-grid" style={{ marginTop: 10 }}>
                    <StatMini label="最新累计净值" v={stats.latest_acc_nav ?? '—'} helpKey="accNav" help={help} onHelp={toggleHelp} />
                    <StatMini label="近1月" v={pct(stats.ret_1m)} t={cls(stats.ret_1m)} helpKey="ret" help={help} onHelp={toggleHelp} />
                    <StatMini label="近3月" v={pct(stats.ret_3m)} t={cls(stats.ret_3m)} />
                    <StatMini label="近6月" v={pct(stats.ret_6m)} t={cls(stats.ret_6m)} />
                    <StatMini label="近1年" v={pct(stats.ret_1y)} t={cls(stats.ret_1y)} />
                    <StatMini label="跌得最多" v={pct(stats.max_drawdown)} helpKey="mdd" help={help} onHelp={toggleHelp} />
                    <StatMini label="波动大小" v={pct(stats.annual_vol)} helpKey="vol" help={help} onHelp={toggleHelp} />
                    <StatMini label="有多少天净值数据" v={stats.history_days != null ? `${stats.history_days} 天` : '—'} helpKey="hist" help={help} onHelp={toggleHelp} />
                    <StatMini label="数据截至" v={date(stats.latest_date)} />
                  </div>
                  {help && (
                    <div
                      className="sub-card"
                      style={{ marginTop: 6, background: 'var(--accent-soft, #eef3fe)', lineHeight: 1.7, fontSize: 12 }}
                    >
                      <b style={{ marginRight: 6 }}>指标说明</b>
                      {METRIC_HELP[help]}
                    </div>
                  )}

                  {/* 六段式深度分析（仅真实持仓入口；交易盘入口不挂载） */}
                  {realEntry && <DeepAnalysisCard report={deep} />}

                  <DrawdownCard dd={dd} />

                  {/* 项目筛选结论（估值洼地 + 趋势向上；只给事实，不推荐买哪只） */}
                  {screen && (
                    <div className="sub-card" style={{ marginTop: 12 }}>
                      <div className="subhead">
                        筛选达标
                        <span className="muted cell-note">历史低位 / 近1年 / 跌得最多</span>
                        {screen.data_ok && (
                          <span className={`tag ${screen.pass_buy ? 'ok' : screen.pass_screen ? 'warn' : 'neutral'}`} style={{ marginLeft: 'auto' }}>
                            {screen.pass_buy ? '达标·可买' : screen.pass_screen ? '达标·买入前需最大跌幅<30%' : '未达标'}
                          </span>
                        )}
                      </div>
                      <div className="muted cell-note" style={{ lineHeight: 1.8 }}>
                        {(screen.reasons || []).map((r, i) => <div key={i}>· {r}</div>)}
                      </div>
                    </div>
                  )}

                  {/* 基金经理（现任；拉不到就不显示，不造假） */}
                  {manager && (
                    <div className="sub-card" style={{ marginTop: 12 }}>
                      <div className="subhead">基金经理 <span className="muted cell-note">现任</span></div>
                      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 10 }}>
                        <span style={{ fontSize: 16, fontWeight: 700 }}>{manager.name}</span>
                        {manager.workTime && <span className="muted cell-note">任职起始 {manager.workTime}</span>}
                      </div>
                      {(manager.fundSize || manager.fundCount != null) && (
                        <div className="muted cell-note" style={{ marginTop: 4 }}>
                          {manager.fundSize && <>管理规模 {manager.fundSize}</>}
                          {manager.fundSize && manager.fundCount != null && ' · '}
                          {manager.fundCount != null && <>在管 {manager.fundCount} 只</>}
                        </div>
                      )}
                    </div>
                  )}

                  <BacktestCard series={series} />
                  <FundProfileCard code={code} />
                  <TopHoldingsCard code={code} open={true} />
                  <IndustryCard code={code} open={true} />

                  {/* 手动买入 / 赎回：仅「交易页」入口显示。
                      真实持仓（持仓页 / 导入面板）是「只看不买」的账本，不该引导去虚拟盘交易
                      （两套系统隔离：真实持仓不接交易盘）。由调用方是否传 onBuy/onSell 决定。 */}
                  {(onBuy || onSell) && (
                    <>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="btn btn-primary" onClick={() => onBuy && onBuy()} disabled={paused}>
                          {paused ? '暂停申购·不可买入' : '手动买入'}
                        </button>
                        <button className="btn btn-danger" onClick={() => onSell && onSell()}>
                          手动赎回
                        </button>
                      </div>
                      {!paused && limited && nav?.purchase_limit != null && (
                        <div className="muted cell-note text-warn" style={{ marginTop: 4 }}>
                          限大额：单日最多买入 {money(nav.purchase_limit)}。
                        </div>
                      )}
                      {paused && (
                        <div className="muted cell-note text-danger" style={{ marginTop: 4 }}>
                          ⚠ 该基金当前「暂停申购」，暂不可买入（赎回不受影响）。
                        </div>
                      )}
                    </>
                  )}

                  {/* 基金公告：只看这只基金自己的，放详情最后 */}
                  <AnnouncementsCard code={code} open={true} />
                </div>
              )}
              </div>
    )
}
