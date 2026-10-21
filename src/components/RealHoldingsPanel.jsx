// src/components/RealHoldingsPanel.jsx · 真实持仓面板（持仓页 / 自选页共用）
// ------------------------------------------------------------
// 两个页面展示同一份真实持仓，收成一个组件，口径只写一遍。
//
// 每只基金显示的字段（对齐主流基金 App 的持仓列表）：
//   估算净值 / 持有额 / 持有收益 / 持有收益率 / 涨跌幅 / 估算收益 / 更新时间
//
// 口径：
//   - 截图「持有金额」是市值，不是成本；成本 = 市值 ÷ (1 + 收益率%)
//   - 持有额 = 份额 × 最新净值；无份额时用截图市值兜底
//   - 持有收益 = 持有额 − 成本；持有收益率 = 持有收益 ÷ 成本
//   - 涨跌幅 / 估算净值 / 估算收益 来自 lib/live.js：指数基金用跟踪指数实时行情近似，
//     主动型基金没有可跟踪的指数 → 显示「—」，不编数
//   - 今日估算收益：任一只算不出就整体显示「—」，不拿部分基金冒充全部

import { useEffect, useMemo, useState } from 'react'
import { loadRealHoldings, backfillNavBase, calcHolding, updateRealHolding, removeRealHolding, appendRealHolding } from '../lib/realLedger.js'
import { QuickDingtouForm } from './QuickActions.jsx'
import { fetchHoldingsLive } from '../lib/live.js'
import { fromRealRow, decorate } from '../lib/holdingsModel.js'
import { checkAllAlerts } from '../lib/alerts.js'
import { notifyDueDingtou, autoApplyDuePlans } from '../lib/dingtou_plan.js'
import PortfolioToolbelt from './PortfolioToolbelt.jsx'

/* 非有限值一律显示「—」：null / NaN / Infinity 都不该渲染成
   「NaN」「∞」这种吓人的东西 */
const fmt2 = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const pnlCls = (n) => (n == null || n === 0 ? 'flat' : n > 0 ? 'up' : 'down')
const signed = (n, d = 2) => `${n > 0 ? '+' : ''}${n.toFixed(d)}`

/* 刷新节奏：交易时段 3 分钟，其余 5 分钟（非交易时段净值不动，少发加密请求）。
   节假日没有日历数据，按工作日近似（假日多刷几次，无害）。 */
/* ：持仓每 3-5 分钟抓一次、实时更新与实时估算。
   交易/非交易统一取 3 分钟（区间内更实时的一端）；
   每次刷新发 2 个请求（批量净值 + 指数行情），回前台再强制补刷一次。 */
const TRADING_REFRESH_MS = 3 * 60 * 1000
const IDLE_REFRESH_MS = 3 * 60 * 1000

function isTradingTime(d = new Date()) {
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  const m = d.getHours() * 60 + d.getMinutes()
  return m >= 9 * 60 + 15 && m <= 15 * 60 + 10
}

/**
 * @param {function} [onOpenFund] 点持仓行下钻详情（传基金代码）
 * @param {function} [onImport]   空态「去导入」；不传则不显示该按钮
 * @param {number}   [refreshKey] 变化即重新读取账本并抓行情
 * @param {boolean}  [showImportCta] 标题右侧「导入」文字按钮（持仓页自带大按钮，不需要）
 * @param {boolean}  [showTools] 是否在下方展开基准对比 / 组合风险（仅持仓页传 true）
 */
export default function RealHoldingsPanel({
  onOpenFund,
  onImport,
  refreshKey = 0,
  showImportCta = true,
  showTools = false,
}) {
  const [rows, setRows] = useState(null)
  /* 编辑 / 删除本机持仓：editingKey 记正在编辑的行 */
  const [editingKey, setEditingKey] = useState(null)
  const [editForm, setEditForm] = useState({ shares: '', amount: '', pct: '' })
  /* 加仓（手动买入）：buyingKey 记正在加仓的行 */
  const [buyingKey, setBuyingKey] = useState(null)
  const [buyForm, setBuyForm] = useState({ shares: '', amount: '' })
  /* 定投（快速建计划）：dingtouKey 记正在建定投的行 */
  const [dingtouKey, setDingtouKey] = useState(null)
  const [internalKey, setInternalKey] = useState(0)

  /* 打开就刷一次，之后自动刷：
       - 每 3 分钟一次（ 3-5 分钟实时刷新，交易与非交易统一 3 分钟）
       - 回到前台立刻补一次（后台时 WebView 的定时器会被系统挂起，回来必须重拉）
     一次刷新只发 2 个请求：批量净值 1 个 + 指数行情 1 个（基金→指数的映射有内存缓存）。 */
  useEffect(() => {
    let alive = true
    let disposed = false
    let timer = null
    let removeApp = () => {}

    async function load(first, force) {
      // 首次加载先把到期的定投追加进账本（只改本机记录；失败不阻塞展示）
      if (first) {
        try {
          await autoApplyDuePlans()
        } catch {
          // 忽略：补投失败不影响持仓展示
        }
      }
      const base = loadRealHoldings()
      if (base.length === 0) {
        if (alive) setRows([])
        return
      }
      // 首次加载才给骨架；后续刷新静默替换，避免每 3 分钟闪一次
      if (first) setRows(null)
      try {
        const liveMap = await fetchHoldingsLive(base.map((r) => r.code), { force })
        if (!alive) return
        // 老数据没有「导入时净值」：用当前净值补一个基准（只写一次），
        // 补完市值才会随净值变化，否则永远停在导入那天的金额
        const navByCode = {}
        for (const [c, v] of Object.entries(liveMap)) {
          if (v?.nav != null) navByCode[c] = { nav: v.nav, date: v.navDate }
        }
        const list = backfillNavBase(navByCode) ? loadRealHoldings() : base
        setRows(list.map((r) => ({ ...r, live: r.code ? liveMap[r.code] || null : null })))
        // 首次加载时顺带检查涨跌预警（有缓存，不额外增加请求；没通知权限只静默返回）
        if (first) {
          checkAllAlerts({
            codes: list.map((r) => r.code).filter(Boolean),
            holdings: list,
          }).catch(() => {})
          notifyDueDingtou().catch(() => {})
        }
      } catch {
        // 刷新失败保留上一次的数值，不把界面清空
        if (alive && first) setRows(base.map((r) => ({ ...r, live: null })))
      }
    }

    function schedule() {
      clearInterval(timer)
      const ms = isTradingTime() ? TRADING_REFRESH_MS : IDLE_REFRESH_MS
      timer = setInterval(() => {
        /* 定时刷新必须 force=true 绕过缓存：
           净值缓存 TTL 是 5 分钟，而定时器 3 分钟 —— 不绕过的话每轮都命中缓存，
           实际变成 5 分钟才真抓一次，界面看着「不刷新」（ 抓到）。 */
        load(false, true)
        // 跨进/跨出交易时段时换节奏
        if ((isTradingTime() ? TRADING_REFRESH_MS : IDLE_REFRESH_MS) !== ms) schedule()
      }, ms)
    }

    // 打开页面 / 切回前台都强制绕过缓存，保证看到的是最新数
    load(true, true)
    schedule()

    // 从后台切回前台：立刻刷一次
    ;(async () => {
      try {
        const { App } = await import('@capacitor/app')
        const h = await App.addListener('appStateChange', (s) => {
          if (disposed || !alive || !s?.isActive) return
          load(false, true)
          schedule()
        })
        if (disposed) {
          // 卸载发生在 import resolve 之后：立刻摘掉，否则监听永久残留
          // （每次回前台都会多打一次网络请求）
          try {
            h.remove()
          } catch {
            // 忽略
          }
        } else {
          removeApp = () => {
            try {
              h.remove()
            } catch {
              // 忽略
            }
          }
        }
      } catch {
        // 浏览器环境没有前后台事件
      }
    })()

    return () => {
      disposed = true
      alive = false
      clearInterval(timer)
      removeApp()
    }
  }, [refreshKey, internalKey])

  const loaded = rows || []
  /* 统一持仓模型：组合分析全部走这一套字段（口径只写一遍）。 */
  const model = useMemo(
    () => (showTools && rows ? decorate(rows.map(fromRealRow)) : []),
    [showTools, rows],
  )
  const sums = loaded.map(calcHolding)
  const mv = sums.reduce((s, c) => s + (c.mv ?? 0), 0)
  const cost = sums.reduce((s, c) => s + (c.cost ?? 0), 0)
  const pnl = mv - cost
  const pnlPct = cost ? (pnl / cost) * 100 : null
  // 今日估算收益：只要有一只算不出，就不给总数
  const estAll = loaded.length > 0 && sums.every((c) => c.estPnl != null)
  const estPnl = estAll ? sums.reduce((s, c) => s + c.estPnl, 0) : null

  const loading = rows == null
  const empty = rows != null && loaded.length === 0

  /* 编辑 / 删除本机持仓记录：只动 App 里的账本，不影响真实资产 */
  function startEdit(r) {
    setEditForm({
      shares: r.shares != null ? String(r.shares) : '',
      amount: r.amount != null ? String(r.amount) : '',
      pct: r.pct != null ? String(r.pct) : '',
    })
    setEditingKey(r.code || r.name)
  }

  function saveEdit(r) {
    updateRealHolding(r.code, r.name, editForm)
    setEditingKey(null)
    setInternalKey((k) => k + 1)
  }

  /* 手动加仓：份额与成本累加到账本（与定投自动追加同一个落地函数） */
  function startBuy(r) {
    setBuyForm({ shares: '', amount: '' })
    setBuyingKey(r.code || r.name)
    setEditingKey(null)
  }

  function saveBuy(r) {
    const deltaShares = Number(buyForm.shares)
    const amountCost = Number(buyForm.amount)
    /* 必须同时挡住非有限值：输入框填 1e999 会变成 Infinity，
       而 Infinity > 0 为真 —— 只判 >0 会放行，把「∞ 份 / ∞ 元」写进账本。 */
    if (!Number.isFinite(deltaShares) || !(deltaShares > 0)) return
    if (!Number.isFinite(amountCost) || !(amountCost > 0)) return
    // 净值基准：优先实时估算净值，退回导入时净值；都没有就不让加（避免按 0 折算市值）
    const nav = Number(r.live?.estNav ?? r.live?.nav ?? r.nav_at_import)
    if (!(nav > 0)) {
      window.alert('拿不到该基金的净值基准，暂不能加仓。请稍候重试或先下拉刷新。')
      return
    }
    const ok = appendRealHolding({
      code: r.code,
      name: r.name,
      deltaShares,
      amountCost,
      nav,
      navDate: r.nav_date_at_import || '',
    })
    if (ok) {
      setBuyingKey(null)
      setInternalKey((k) => k + 1)
    } else {
      window.alert('加仓失败：该基金不在本机持仓里。')
    }
  }

  function removeRow(r) {
    if (
      !window.confirm(
        `删除「${r.name || r.code}」的本机持仓记录？\n只删 App 里的记录，不影响你的真实资产。`,
      )
    )
      return
    removeRealHolding(r.code, r.name)
    setEditingKey(null)
    setInternalKey((k) => k + 1)
  }

  return (
    <div className="rh-panel">
      <div className="watch-section-head">
        <div>
          <span className="section-overline">REAL PORTFOLIO</span>
          <h2>真实持仓</h2>
        </div>
        {showImportCta && !empty ? (
          <button className="text-action" onClick={onImport} disabled={!onImport}>
            导入
          </button>
        ) : null}
      </div>

      {empty ? (
        <section className="rh-card rh-empty">
          <div className="rh-empty-title">还没有真实持仓</div>
          <div className="rh-empty-note">导入支付宝 / 天天基金的持仓截图，这里显示市值与收益</div>
          {onImport ? (
            <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={onImport}>
              去导入截图
            </button>
          ) : null}
        </section>
      ) : (
        <>
          <section className="rh-card" aria-label="真实持仓摘要">
            <div className="rh-top">
              <div>
                <div className="rh-label">总市值（元）</div>
                <div className="rh-num">{loading ? '—' : fmt2(mv)}</div>
              </div>
              <div className="rh-pnl">
                <span>持仓收益</span>
                <strong className={pnlCls(pnl)}>{loading ? '—' : signed(pnl)}</strong>
                <em className={pnlCls(pnlPct)}>
                  {loading || pnlPct == null ? '' : `${signed(pnlPct)}%`}
                </em>
              </div>
            </div>
            <div className="rh-stats">
              <div>
                <span>投入</span>
                <strong>{loading ? '—' : fmt2(cost)}</strong>
              </div>
              <div>
                <span>估算收益</span>
                <strong className={pnlCls(estPnl)}>
                  {loading || estPnl == null ? '—' : signed(estPnl)}
                </strong>
              </div>
              <div>
                <span>持仓基金</span>
                <strong>{loading ? '—' : `${loaded.length} 只`}</strong>
              </div>
            </div>
          </section>

          {loading ? (
            <div className="rh-list">
              <div className="skeleton" style={{ height: 56 }} />
            </div>
          ) : (
            <div className="rh-list">
              {loaded.map((r) => {
                const c = calcHolding(r)
                const live = r.live
                const key = r.code || r.name
                return (
                  <div className="rh-row" key={key}>
                    <button
                      className="rh-row-btn"
                      onClick={r.code && onOpenFund ? () => onOpenFund(r.code) : undefined}
                      disabled={!r.code || !onOpenFund}
                    >
                    <span className="rh-row-top">
                      <span className="rh-row-main">
                        <strong>{r.name || r.code}</strong>
                        <small>
                          {r.code ? <span className="fund-code">{r.code}</span> : '无代码'}
                        </small>
                      </span>
                      <span className="rh-row-num">
                        <strong>{c.mv != null ? fmt2(c.mv) : '—'}</strong>
                        <small className={pnlCls(c.pnl)}>
                          {c.pnl == null ? '—' : signed(c.pnl)}
                          {c.pnlPct != null ? <em>（{signed(c.pnlPct)}%）</em> : null}
                        </small>
                      </span>
                    </span>

                    <span className="rh-row-meta">
                      <span>
                        <i>估算净值</i>
                        <b>{live?.estNav != null ? live.estNav.toFixed(4) : '—'}</b>
                      </span>
                      <span>
                        <i>持有份额</i>
                        <b>{r.shares != null ? r.shares.toFixed(2) : '—'}</b>
                      </span>
                      <span>
                        <i>持有收益</i>
                        <b className={pnlCls(c.pnl)}>
                          {c.pnl == null ? '—' : signed(c.pnl)}
                        </b>
                      </span>
                      <span>
                        <i>持有收益率</i>
                        <b className={pnlCls(c.pnlPct)}>
                          {c.pnlPct == null ? '—' : `${signed(c.pnlPct)}%`}
                        </b>
                      </span>
                      <span>
                        <i>涨跌幅</i>
                        <b className={pnlCls(live?.pct)}>
                          {live?.pct != null ? `${signed(live.pct)}%` : '—'}
                        </b>
                      </span>
                      <span>
                        <i>估算收益</i>
                        <b className={pnlCls(c.estPnl)}>
                          {c.estPnl == null ? '—' : signed(c.estPnl)}
                        </b>
                      </span>
                      <span>
                        <i>更新时间</i>
                        <b>{live?.time || '—'}</b>
                      </span>
                    </span>
                    </button>

                    <div className="rh-ops">
                      <button className="btn btn-sm" onClick={() => startEdit(r)}>
                        编辑
                      </button>
                      <button className="btn btn-sm" onClick={() => startBuy(r)}>
                        加仓
                      </button>
                      <button className="btn btn-sm" onClick={() => { setBuyingKey(null); setEditingKey(null); setDingtouKey(r.code || r.name) }}>
                        定投
                      </button>
                      <button className="btn btn-sm" onClick={() => removeRow(r)}>
                        删除
                      </button>
                    </div>

                    {dingtouKey === (r.code || r.name) ? (
                      <QuickDingtouForm
                        code={r.code}
                        name={r.name}
                        onSaved={() => setDingtouKey(null)}
                      />
                    ) : null}

                    {buyingKey === (r.code || r.name) ? (
                      <div className="rh-edit">
                        <label className="field">
                          <span>新增份额</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={buyForm.shares}
                            onChange={(e) => setBuyForm((f) => ({ ...f, shares: e.target.value }))}
                            placeholder="如 500"
                          />
                        </label>
                        <label className="field">
                          <span>本次投入（元）</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={buyForm.amount}
                            onChange={(e) => setBuyForm((f) => ({ ...f, amount: e.target.value }))}
                            placeholder="如 8000"
                          />
                        </label>
                        <div className="goal-form-actions">
                          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => saveBuy(r)}>
                            确认加仓
                          </button>
                          <button className="btn" onClick={() => setBuyingKey(null)}>
                            取消
                          </button>
                        </div>
                        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
                          按当前净值基准折算市值：份额 += 新增份额，成本 += 本次投入。只改本机账本。
                        </p>
                      </div>
                    ) : null}

                    {editingKey === key ? (
                      <div className="rh-edit">
                        <label className="field">
                          <span>份额</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={editForm.shares}
                            onChange={(e) => setEditForm((f) => ({ ...f, shares: e.target.value }))}
                          />
                        </label>
                        <label className="field">
                          <span>持有金额（元）</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={editForm.amount}
                            onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
                          />
                        </label>
                        <label className="field">
                          <span>收益率（%）</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={editForm.pct}
                            onChange={(e) => setEditForm((f) => ({ ...f, pct: e.target.value }))}
                          />
                        </label>
                        <div className="goal-form-actions">
                          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => saveEdit(r)}>
                            保存
                          </button>
                          <button className="btn" onClick={() => setEditingKey(null)}>
                            取消
                          </button>
                        </div>
                        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
                          金额是持仓市值，不是成本；成本按「金额 ÷ (1 + 收益率)」反推。保存后立即刷新汇总与组合分析。
                        </p>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}

          {showTools ? <PortfolioToolbelt model={model} /> : null}
        </>
      )}
    </div>
  )
}
