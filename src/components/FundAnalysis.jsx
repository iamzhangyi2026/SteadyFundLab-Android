// src/components/FundAnalysis.jsx · 单只基金分析卡
// ------------------------------------------------------------
// 内容：
//   ① 核心指标：近 1 月/3 月/半年/1 年、最大回撤、年化波动、历史长度、数据截至
//      （口径：区间涨幅用**累计净值**，历史表现口径；回撤/波动用累计净值日收益算）
//   ② 回撤修复：定位史上最深那次下跌，回答「最深跌多少、跌了多久、多久才涨回来」
//   ③ 定投回测：用真实净值模拟定期定额，与同期「一把梭」对比
//
// 纯前端计算（lib/navlab.js），不额外发请求 —— 净值序列由详情页已经抓好的数据提供。
// 术语都带一句就地说明，不把「年化波动」这类词直接甩给用户。

import { useMemo, useState } from 'react'
import Stat from './Stat.jsx'
import { drawdownRecovery, annualVol, dingtouBacktest, FREQ_LABEL, WINDOW_LABEL } from '../lib/navlab.js'
import { detectJumps } from '../lib/navSanitize.js'

// 指标词典：术语必须能就地看懂（一句话，不说设计原理）
const METRIC_HELP = {
  accNav: '累计净值：把历史上的分红重新投进去之后的净值，看真实收益认准它。',
  ret: '往前推对应时间段的总涨幅。比如「近 1 年 +12%」＝一年前买入并持有到今天赚 12%。',
  mdd: '最大回撤：历史上从最高点跌到最低点，最深跌了多少。-35% 表示最惨的时候比高点亏 35%。',
  vol: '年化波动：净值上下蹦跶的剧烈程度。数字越大越刺激、也越容易拿不住。',
  hist: '这只基金有多少个交易日的历史净值。数据越长，上面的统计越可信。',
}

function Metric({ label, v, cls, helpKey, help, onHelp }) {
  return (
    <div className="stat">
      <div className="stat-k" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{label}</span>
        {helpKey ? (
          <button
            type="button"
            className="metric-help-btn"
            onClick={() => onHelp(helpKey)}
            aria-label={`${label} 指标说明`}
          >
            ?
          </button>
        ) : null}
      </div>
      <div className={`stat-v ${cls || ''}`}>{v}</div>
    </div>
  )
}

export default function FundAnalysis({ series, accNav, latestDate, dataDays, m1, showBacktest = true }) {
  const [help, setHelp] = useState(null)
  const [amount, setAmount] = useState('500')
  const [freq, setFreq] = useState('monthly')
  const [win, setWin] = useState('730')

  /* 数据源异常跳变防护：含单日 ≥50% 跳变时，回撤/波动/定投回测全部失真
     （001594 ），一律留空并提示，不显示跨口径结果。 */
  const jumps = useMemo(() => detectJumps(series), [series])
  const suspect = jumps.length > 0

  const dd = useMemo(() => (suspect ? null : drawdownRecovery(series)), [series, suspect])
  const vol = useMemo(() => (suspect ? null : annualVol(series)), [series, suspect])
  const backtest = useMemo(
    () =>
      suspect
        ? null
        : dingtouBacktest(series, { amount: Number(amount) || 0, frequency: freq, windowDays: Number(win) || 0 }),
    [series, amount, freq, win, suspect],
  )

  const toggleHelp = (k) => setHelp((h) => (h === k ? null : k))

  return (
    <div className="analysis-card">
      <div className="watch-section-head">
        <div>
          <span className="section-overline">ANALYSIS</span>
          <h2>分析</h2>
        </div>
      </div>

      {suspect ? (
        <div className="callout warn" style={{ marginBottom: 'var(--space-3)' }}>
          净值序列存在数据源异常跳变（{jumps[0].prevDate} → {jumps[0].date} 净值 {jumps[0].from} →{' '}
          {jumps[0].to}），最大回撤、年化波动、定投回测已停算，不显示跨口径结果。
        </div>
      ) : null}

      <div className="card plain" style={{ padding: 0, marginBottom: 'var(--space-3)' }}>
        <div className="stat-grid" style={{ marginTop: 0 }}>
          <Metric
            label="累计净值"
            v={accNav != null ? accNav.toFixed(4) : '—'}
            helpKey="accNav"
            help={help}
            onHelp={toggleHelp}
          />
          <Metric
            label="近 1 月"
            v={m1 == null || !Number.isFinite(m1) ? '—' : `${m1 > 0 ? '+' : ''}${m1.toFixed(2)}%`}
            cls={m1 == null || !Number.isFinite(m1) || m1 === 0 ? '' : m1 > 0 ? 'up' : 'down'}
            helpKey="ret"
            help={help}
            onHelp={toggleHelp}
          />
          <Metric
            label="最大回撤"
            v={dd && !dd.flat ? `${dd.maxDrawdown.toFixed(2)}%` : '—'}
            cls={dd && !dd.flat ? 'down' : ''}
            helpKey="mdd"
            help={help}
            onHelp={toggleHelp}
          />
          <Metric label="年化波动" v={vol != null ? `${vol.toFixed(2)}%` : '—'} helpKey="vol" help={help} onHelp={toggleHelp} />
          <Metric label="历史长度" v={dataDays != null ? `${dataDays} 天` : '—'} helpKey="hist" help={help} onHelp={toggleHelp} />
          <Metric label="数据截至" v={latestDate || '—'} />
        </div>
        {help ? (
          <div className="metric-help-box">
            <b>指标说明</b>
            {METRIC_HELP[help]}
          </div>
        ) : null}
      </div>

      {/* 回撤修复 */}
      <div className="section-title">回撤修复</div>
      <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
        {!dd ? (
          <div className="card-note">净值数据不足，无法计算回撤。</div>
        ) : dd.flat ? (
          <div className="card-note">这段历史里净值一路上行，没有出现明显回撤。</div>
        ) : (
          <>
            <div className="stat-grid" style={{ marginTop: 0 }}>
              <Stat k="最深跌幅" v={`${dd.maxDrawdown.toFixed(2)}%`} cls="down" />
              <Stat k="下跌耗时" v={dd.declineDays != null ? `${dd.declineDays} 天` : '—'} />
              <Stat
                k={dd.recovered ? '修复耗时' : '未修复时长'}
                v={
                  dd.recovered
                    ? `${dd.recoveryDays} 天`
                    : dd.pendingDays != null
                      ? `${dd.pendingDays} 天`
                      : '—'
                }
              />
              <Stat k="整轮耗时" v={dd.roundTripDays != null ? `${dd.roundTripDays} 天` : '—'} />
            </div>
            <p className="analysis-note">
              {dd.peakDate} 高点 <b>{dd.peakValue}</b> → {dd.troughDate} 低点 <b>{dd.troughValue}</b>；
              {dd.recovered
                ? `之后用了 ${dd.recoveryDays} 天，在 ${dd.recoveryDate} 涨回原位。`
                : `截至 ${dd.lastDate}（最新 ${dd.lastValue}）仍未收复，从谷底算起已经熬了 ${dd.pendingDays} 天。`}
            </p>
          </>
        )}
      </div>

      {/* 定投回测 —— 从真实持仓点开时不显示（已经买了，不需要再回测买不买） */}
      {showBacktest ? (
        <>
          {/* 定投回测 */}
          <div className="section-title">定投回测</div>
          <div className="card">
            <div className="analysis-fields">
              <label className="field">
                <span>每期金额（元）</span>
                <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              </label>
              <label className="field">
                <span>频率</span>
                <select value={freq} onChange={(e) => setFreq(e.target.value)}>
                  {Object.keys(FREQ_LABEL).map((k) => (
                    <option key={k} value={k}>
                      {FREQ_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>回看区间</span>
                <select value={win} onChange={(e) => setWin(e.target.value)}>
                  {Object.keys(WINDOW_LABEL).map((k) => (
                    <option key={k} value={k}>
                      {WINDOW_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {!backtest ? (
              <div className="card-note">
                {suspect
                  ? '该基金净值序列存在数据源异常跳变，定投回测会被跨口径差值污染，暂不计算。'
                  : '这段区间的净值数据不够，换个更长的区间试试。'}
              </div>
            ) : (
              <>
                <div className="stat-grid" style={{ marginTop: 'var(--space-3)' }}>
                  <Stat k="定投期数" v={`${backtest.periods} 期`} />
                  <Stat k="累计投入" v={backtest.invest.toFixed(2)} />
                  <Stat k="期末市值" v={backtest.marketValue.toFixed(2)} />
                  <Stat k="定投收益率" v={`${fmtSigned(backtest.roi)}%`} cls={pctCls(backtest.roi)} />
                  <Stat k="一把梭收益率" v={`${fmtSigned(backtest.lumpRoi)}%`} cls={pctCls(backtest.lumpRoi)} />
                  <Stat k="对比一把梭" v={`${fmtSigned(backtest.edge)}%`} cls={pctCls(backtest.edge)} />
                </div>
                <p className="analysis-note">
                  {backtest.startDate} 至 {backtest.endDate}（{backtest.days} 天，净值 {backtest.startValue} →{' '}
                  {backtest.endValue}）：按{FREQ_LABEL[freq]}投 {Number(amount) || 0} 元，共 {backtest.periods}{' '}
                  期、投入 {backtest.invest.toFixed(2)}，期末 {backtest.marketValue.toFixed(2)}；
                  同样多的钱在期初一把梭，期末是 {backtest.lumpValue.toFixed(2)}。
                </p>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

function fmtSigned(v) {
  return v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`
}

function pctCls(v) {
  if (v == null || !Number.isFinite(v) || v === 0) return ''
  return v > 0 ? 'up' : 'down'
}
