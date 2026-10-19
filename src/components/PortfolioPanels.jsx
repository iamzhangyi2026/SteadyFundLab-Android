// src/components/PortfolioPanels.jsx · 组合工具面板
// ------------------------------------------------------------
// 全部挂在现有页面里，不新增 Tab：
//   DailyPnlCard   每日收益明细（C2）→ 持仓页
//   BenchmarkCard  组合 vs 沪深300（C5）→ 持仓页
//   RiskCard       组合风险 / 行业暴露（C12）→ 持仓页
//   RebalancePanel 再平衡（C16）→ 我的页
//   GoalPanel      目标规划（C17）→ 我的页
//
// 口径：所有金额/比例都来自真实账本与真实净值，算不出显示「—」。

import { useEffect, useState } from 'react'
import { rebalancePlan } from '../lib/portfolio_tools.js'
import { loadRealHoldings } from '../lib/realLedger.js'

const fmt2 = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(2))
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}`)
const cls = (n) => (n == null || n === 0 ? 'flat' : n > 0 ? 'up' : 'down')

/* 数据源异常跳变警示条：不藏问题，把跳变日期与前后净值摊开给用户看 */
function JumpNotice({ jumps = [] }) {
  if (!jumps.length) return null
  return (
    <div className="callout warn" style={{ marginTop: 'var(--space-3)' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>数据源异常，相关指标已降级</div>
      {jumps.slice(0, 3).map((j, i) => (
        <div key={i} style={{ fontSize: 'var(--fs-kicker)', lineHeight: 1.6 }}>
          {j.code ? `${j.code} ` : ''}
          {j.prevDate} → {j.date} 净值 {j.from} → {j.to}（{j.pct > 0 ? '+' : ''}
          {j.pct}%）
        </div>
      ))}
      {jumps.length > 3 ? <div style={{ fontSize: 'var(--fs-kicker)' }}>等 {jumps.length} 处</div> : null}
      <div style={{ fontSize: 'var(--fs-kicker)', marginTop: 4 }}>
        单日涨跌超出正常公募范围（涨跌停 ±10% 传导），已不据此计算区间收益。
      </div>
    </div>
  )
}

/* ---------------- 每日收益 ---------------- */
export function DailyPnlCard({ data }) {
  if (!data || !data.rows || data.rows.length === 0) return null
  const rows = [...data.rows].reverse()
  return (
    <>
      <div className="section-title">每日收益</div>
      <div className="card">
        <div className="pp-head">
          <span>近 {data.rows.length} 个交易日</span>
          <b className={cls(data.total)}>{data.total == null ? '—' : `${signed(data.total)} 元`}</b>
        </div>
        <div className="pp-list">
          {rows.map((r) => (
            <div className="pp-row" key={r.date}>
              <span>{r.date}</span>
              <b className={cls(r.pnl)}>
                {r.pnl == null ? '—' : `${signed(r.pnl)}`}
                {r.pnlPct != null ? <em>{`（${signed(r.pnlPct)}%）`}</em> : null}
              </b>
            </div>
          ))}
        </div>
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          按「份额 × 当日单位净值变化」计算，只统计有完整净值历史的基金；缺净值的基金不参与，也不补 0。
        </p>
        <JumpNotice jumps={data.untrusted} />
      </div>
    </>
  )
}

/* ---------------- 基准对比 ---------------- */
export function BenchmarkCard({ data }) {
  if (!data) return null
  return (
    <>
      <div className="section-title">组合 vs {data.benchmarkName}</div>
      <div className="card">
        {data.untrusted?.length ? (
          <div className="callout warn" style={{ marginTop: 0, marginBottom: 'var(--space-3)' }}>
            区间内有基金出现数据源异常跳变（见下），区间收益不可信，暂不显示。
          </div>
        ) : null}
        <div className="stat-grid" style={{ marginTop: 0 }}>
          <div className="stat">
            <div className="stat-k">组合收益</div>
            <div className={'stat-v ' + cls(data.portfolioPct)}>{signed(data.portfolioPct)}%</div>
          </div>
          <div className="stat">
            <div className="stat-k">{data.benchmarkName}</div>
            <div className={'stat-v ' + cls(data.benchmarkPct)}>{signed(data.benchmarkPct)}%</div>
          </div>
          <div className="stat">
            <div className="stat-k">超额收益</div>
            <div className={'stat-v ' + cls(data.excess)}>{signed(data.excess)}%</div>
          </div>
        </div>
        <CompareChart series={data.series} />
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          两条线都按区间起点归一化为 0%；组合线按当前份额回溯计算，基准为{data.benchmarkName}收盘点位。
        </p>
        <JumpNotice jumps={data.untrusted} />
      </div>
    </>
  )
}

function CompareChart({ series }) {
  if (!series || series.length < 2) return null
  const w = 300
  const h = 96
  const all = series.flatMap((p) => [p.portfolio, p.benchmark])
  const min = Math.min(...all, 0)
  const max = Math.max(...all, 0)
  const span = max - min || 1
  const path = (key) =>
    series
      .map((p, i) => {
        const x = (i / (series.length - 1)) * w
        const y = h - 6 - ((p[key] - min) / span) * (h - 12)
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="cmp-chart">
      <path d={path('portfolio')} fill="none" stroke="var(--accent)" strokeWidth="1.8" />
      <path d={path('benchmark')} fill="none" stroke="var(--text-mute)" strokeWidth="1.4" strokeDasharray="4 3" />
    </svg>
  )
}

/* ---------------- 组合风险 ---------------- */
export function RiskCard({ risk, overlap = [], twr = null }) {
  if (!risk || risk.total == null) return null
  const top = risk.positions[0]
  return (
    <>
      <div className="section-title">组合风险</div>
      <div className="card">
        <div className="stat-grid" style={{ marginTop: 0 }}>
          <div className="stat">
            <div className="stat-k">总市值</div>
            <div className="stat-v">{fmt2(risk.total)}</div>
          </div>
          <div className="stat">
            <div className="stat-k">最大单一持仓</div>
            <div className="stat-v">{top ? `${top.pct?.toFixed(1)}%` : '—'}</div>
          </div>
          <div className="stat">
            <div className="stat-k">集中度 HHI</div>
            <div className="stat-v">{risk.hhi == null ? '—' : risk.hhi.toFixed(3)}</div>
          </div>
        </div>

        <div className="pp-sub">单基金占比</div>
        <div className="pp-bars">
          {risk.positions.map((p) => (
            <div className="pp-bar-row" key={p.code || p.name}>
              <span className="pp-bar-name">{p.name || p.code}</span>
              <span className="pp-bar-track">
                <i style={{ width: `${Math.min(100, p.pct ?? 0)}%` }} />
              </span>
              <b>{p.pct == null ? '—' : `${p.pct.toFixed(1)}%`}</b>
            </div>
          ))}
        </div>

        {risk.industries.length > 0 ? (
          <>
            <div className="pp-sub">行业暴露（按持仓市值加权，前 6）</div>
            <div className="pp-bars">
              {risk.industries.slice(0, 6).map((a) => (
                <div className="pp-bar-row" key={a.industry}>
                  <span className="pp-bar-name">{a.industry}</span>
                  <span className="pp-bar-track">
                    <i style={{ width: `${Math.min(100, a.weight)}%` }} />
                  </span>
                  <b>{a.weight.toFixed(1)}%</b>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="card-note">行业配置暂未取到（季报未更新或接口不可达），不推断。</p>
        )}
        {twr ? (
          twr.twr != null ? (
            <div className="pp-twr">
              时间加权收益率（{twr.since || '导入'} 起，近似）
              <b className={cls(twr.twr)}>{signed(twr.twr)}%</b>
            </div>
          ) : (
            <div className="pp-twr">
              时间加权收益率
              <b className="flat">暂不可算</b>
            </div>
          )
        ) : null}
        {twr && twr.twr == null ? (
          <p className="card-note" style={{ marginTop: 4 }}>
            {twr.skippedJump > 0
              ? `有 ${twr.skippedJump} 只基金的净值序列存在数据源异常跳变（详见每日收益卡警示），持有区间收益不可信，不纳入计算。`
              : `账本缺少导入日期/导入时净值日期（${twr.missing || 0} 只），无法确定持有起点；重新导入一次持仓截图即可写入导入日期，之后可计算。不拿「成立以来涨幅」冒充持有收益。`}
            {twr.missing > 0 && twr.skippedJump > 0
              ? `另有 ${twr.missing} 只缺少导入日期。`
              : ''}
          </p>
        ) : null}

        {overlap.length > 0 ? (
          <>
            <div className="pp-sub">重仓股重叠（前十大）</div>
            {overlap.slice(0, 4).map((p, i) => (
              <div className="pp-overlap" key={i}>
                <div className="pp-overlap-head">
                  <span>
                    {p.a} × {p.b}
                  </span>
                  <b>
                    {p.count} 只 · 重叠 {p.weight.toFixed(1)}%
                  </b>
                </div>
                <small>
                  {p.common
                    .slice(0, 4)
                    .map((c) => `${c.name} ${c.ratioA}/${c.ratioB}%`)
                    .join('、')}
                </small>
              </div>
            ))}
          </>
        ) : null}

        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          HHI = 各基金占比平方和，越接近 1 越集中（等权 4 只为 0.25）。
          重叠按前十大重仓股的共同股票统计，重叠度 = Σ min(两只基金各自权重)。
        </p>
      </div>
    </>
  )
}

/* ---------------- 分红跟踪 ---------------- */
export function DividendsCard({ data }) {
  if (!data) return null
  const rows = data.rows || []
  const failed = data.failed || 0
  return (
    <>
      <div className="section-title">分红跟踪</div>
      <div className="card">
        {rows.length === 0 ? (
          <p className="card-note" style={{ marginTop: 0 }}>
            持仓基金近期没有抓取到分红公告
            {failed ? `（${failed} 只基金公告暂未取到）` : ''}。
          </p>
        ) : (
          <div className="pp-list">
            {rows.slice(0, 12).map((r, i) => (
              <div className="pp-row" key={i}>
                <span>
                  {r.date || '日期未知'} · {r.name}
                </span>
                <b className="pp-div-title">{r.title}</b>
              </div>
            ))}
          </div>
        )}
        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          只报公告标题与日期；每份分红金额公开接口不保证有，取不到就不显示。
          {failed ? ` 本次有 ${failed} 只基金公告抓取失败。` : ''}
        </p>
      </div>
    </>
  )
}

/* ---------------- 再平衡 ---------------- */
const TARGET_KEY = 'rebalance_targets'

function loadTargets() {
  try {
    const raw = localStorage.getItem(TARGET_KEY)
    const obj = raw ? JSON.parse(raw) : {}
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

/**
 * 再平衡面板
 * @param {{holdings?: Array|null}} props holdings 由调用方传入统一持仓行（模拟盘用）；
 *   不传则自己读真实持仓账本（我的页用）
 */
export function RebalancePanel({ holdings: holdingsProp = null }) {
  const [localHoldings, setLocalHoldings] = useState(() => loadRealHoldings())
  const holdings = holdingsProp != null ? holdingsProp : localHoldings
  const [targets, setTargets] = useState(loadTargets)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (holdingsProp == null) setLocalHoldings(loadRealHoldings())
  }, [holdingsProp])

  const plan = rebalancePlan(holdings, targets)

  function setTarget(code, v) {
    const next = { ...targets, [code]: Number(v) }
    setTargets(next)
    try {
      localStorage.setItem(TARGET_KEY, JSON.stringify(next))
    } catch {
      // 忽略
    }
  }

  function resetEqual() {
    setTargets({})
    try {
      localStorage.removeItem(TARGET_KEY)
    } catch {
      // 忽略
    }
    setMsg('已恢复等权目标')
  }

  return (
    <>
      <div className="section-title">再平衡</div>
      <div className="card">
        {!plan ? (
          <p className="card-note" style={{ marginTop: 0 }}>
            还没有可计算的持仓市值（需要份额或导入时净值），补全后再看再平衡建议。
          </p>
        ) : (
          <>
            <div className="pp-head">
              <span>总市值 ¥{fmt2(plan.total)}</span>
              <button className="btn btn-sm" onClick={resetEqual}>恢复等权</button>
            </div>
            <div className="rb-list">
              {plan.rows.map((r) => (
                <div className="rb-row" key={r.code || r.name}>
                  <div className="rb-main">
                    <strong>{r.name || r.code}</strong>
                    <small>
                      实际 {r.pct == null ? '—' : `${r.pct.toFixed(1)}%`} · 目标{' '}
                      <input
                        className="rb-input"
                        type="number"
                        inputMode="decimal"
                        value={r.target}
                        onChange={(e) => setTarget(r.code, e.target.value)}
                      />
                      %
                    </small>
                  </div>
                  <div className="rb-action">
                    <b className={r.action === '加仓' ? 'up' : r.action === '减仓' ? 'down' : 'flat'}>
                      {r.action}
                    </b>
                    <small>{r.action === '保持' ? '—' : `¥${Math.abs(r.amount).toFixed(2)}`}</small>
                  </div>
                </div>
              ))}
            </div>
            <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
              建议金额 =（目标比例 − 实际比例）× 总市值；偏离小于 1 个百分点标「保持」。
              目标比例可逐只改，自动存本机。
            </p>
          </>
        )}
        {msg ? <div className="callout teal" style={{ marginTop: 'var(--space-3)' }}>{msg}</div> : null}
      </div>
    </>
  )
}

/* 目标规划已拆到 components/GoalPanel.jsx（C17 完整版：多目标 + 增删改）。 */
