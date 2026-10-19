// src/components/PortfolioToolbelt.jsx · 组合分析共享组件
// ------------------------------------------------------------
// 输入「统一持仓行」（holdingsModel 输出），自动抓历史净值 / 指数 /
// 行业配置 / 重仓股 / 分红公告，算出并渲染：
//   每日收益 / 组合 vs 基准 / 组合风险（集中度·行业·重叠·TWR）/ 分红跟踪
//
// 真实持仓页与模拟持仓页共用同一组件，口径只写一遍。

import { useEffect, useMemo, useState } from 'react'
import { fetchIndexKline } from '../lib/market.js'
import { fetchFundCached } from '../lib/navCache.js'
import { analyzeExposure } from '../lib/exposure.js'
import { fetchFundStocks } from '../lib/live.js'
import { collectDividends } from '../lib/dividends.js'
import {
  dailyPnlSeries,
  benchmarkCompare,
  portfolioRisk,
  stockOverlap,
  portfolioTwr,
} from '../lib/portfolio_tools.js'
import { DailyPnlCard, BenchmarkCard, RiskCard, DividendsCard } from './PortfolioPanels.jsx'

export default function PortfolioToolbelt({ model = [] }) {
  const [tools, setTools] = useState({
    hist: {},
    index: [],
    exposure: {},
    stocks: {},
    dividends: null,
  })

  /* 依赖 codesKey：live 数值每 3 分钟变一次，但历史数据不会变，不该跟着重抓 */
  const codesKey = model.map((r) => r.code).filter(Boolean).join(',')

  useEffect(() => {
    if (!codesKey) return
    let alive = true
    const codes = codesKey.split(',')
    ;(async () => {
      const [histPairs, index, expPairs, stockPairs, divRes] = await Promise.all([
        Promise.all(
          codes.map(async (c) => [c, await fetchFundCached(c)]),
        ),
        fetchIndexKline('1.000300', 250),
        Promise.all(
          codes.map(async (c) => {
            try {
              return [c, await analyzeExposure(c)]
            } catch {
              return [c, null]
            }
          }),
        ),
        Promise.all(
          codes.map(async (c) => {
            try {
              return [c, await fetchFundStocks(c)]
            } catch {
              return [c, []]
            }
          }),
        ),
        collectDividends(codes.map((c) => ({ code: c, name: model.find((r) => r.code === c)?.name || c }))).catch(
          () => ({ rows: [], failed: 0 }),
        ),
      ])
      if (!alive) return
      setTools({
        hist: Object.fromEntries(histPairs),
        index,
        exposure: Object.fromEntries(expPairs),
        stocks: Object.fromEntries(stockPairs),
        dividends: divRes,
      })
    })()
    return () => {
      alive = false
    }
    // model 只取 code/name 参与抓取，live 变化不影响
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codesKey])

  const daily = useMemo(
    () => (model.length ? dailyPnlSeries(model, tools.hist, 10) : null),
    [model, tools.hist],
  )
  const bench = useMemo(
    () => (model.length ? benchmarkCompare(model, tools.hist, tools.index) : null),
    [model, tools.hist, tools.index],
  )
  const risk = useMemo(
    () => (model.length ? portfolioRisk(model, tools.exposure) : null),
    [model, tools.exposure],
  )
  const overlap = useMemo(
    () => (model.length ? stockOverlap(model, tools.stocks || {}) : []),
    [model, tools.stocks],
  )
  const twr = useMemo(
    () => (model.length ? portfolioTwr(model, tools.hist) : null),
    [model, tools.hist],
  )

  return (
    <>
      <DailyPnlCard data={daily} />
      <BenchmarkCard data={bench} />
      <RiskCard risk={risk} overlap={overlap} twr={twr} />
      <DividendsCard data={tools.dividends} />
    </>
  )
}
