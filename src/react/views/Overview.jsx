// Overview.jsx · 持仓页（真实持仓系统首页 · 全新结构）
//
// 结构（全宽紧凑、无圆角卡片堆叠——手机屏小，圆弧板块浪费空间、信息展示不全）：
//   - 风控提醒横幅
//   - 总资产区（平铺无卡：总资产 + 持仓 + 总收益）
//   - 持仓列表（全宽整块白底 + 行分割线，点击 → 基金详情二级页）
//   - OCR 导入真实持仓截图
//
// 说明：决策速览 / 预算 / 批次罚期 等「交易页」内容已移出本页（见整体规划）。

import { useEffect, useState, useRef } from 'react'
import { useData } from '../hooks/useData'
import { money, pct, cls } from '../lib/format'
import { jsCheckAccountStop, fetchYesterdayPct, fetchMarketIndex, fetchLatestNavPct, fetchFundLiveSnapshot, removeHolding } from '../lib/dataAdapter'
import { useNav } from '../lib/nav.jsx'
import ImportHoldingsPanel from '../components/ImportHoldingsPanel'
import IndexValuationPanel from '../components/IndexValuationPanel'
import ConfirmDialog from '../components/ConfirmDialog'
import EditHoldingDialog from '../components/EditHoldingDialog'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'

export default function Overview() {
  const { positions, fetchingNav, navCount, navigate, refresh } = useData()
  const [confirmRemove, setConfirmRemove] = useState(null) // 移除真实持仓二次确认 { code, name }
  const [editTarget, setEditTarget] = useState(null)      // 修改真实持仓（OCR 纠错）{ fund_code, ... }
  const nav = useNav()
  const [riskAlert, setRiskAlert] = useState(null)
  const [riskTipVisible, setRiskTipVisible] = useState(false) // 风控提醒：仅真实持仓加入、且用户回到持仓页时短暂显示 3 秒（不常驻）
  const pendingRiskTip = useRef(false) // 真实持仓加入后置位；回到持仓页（nav.page 为空）才弹出
  const riskTipTimer = useRef(null)
  const [yPct, setYPct] = useState({})           // 昨日涨幅（按 fund_code）
  const [navPct, setNavPct] = useState({})        // 最新净值日涨跌幅 { code: { pct, nav_date } }
  const [snapshots, setSnapshots] = useState({})  // 基金实时快照 { code: { nav_date, nav_pct, index_pct, ... } }
  const [indexes, setIndexes] = useState([])     // N2 今日大盘（四大指数，抓不到留空不显示）

  // N2：进页面拉一次四大指数当日行情（腾讯主源）。抓不到静默留空，不显示假数据。
  useEffect(() => {
    let alive = true
    fetchMarketIndex().then(r => { if (alive && r.ok) setIndexes(r.data ?? []) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // 盘中实时估值：批量拉腾讯估算（仅交易时段有真实值；非交易时段 live=false 不展示，避免造假）
  const posCodesKey = (positions || []).map((p) => p.fund_code).join(',')
  useEffect(() => {
    if (!posCodesKey) { setYPct({}); setNavPct({}); setSnapshots({}); return }
    let alive = true
    const codes = posCodesKey.split(',')
    fetchYesterdayPct(codes)
      .then((r) => { if (alive && r.ok) setYPct(r.data || {}) })
      .catch(() => {})
    // 最新净值日涨跌幅（修正「当日」口径）+ 跟踪指数实时行情（估算当日涨跌）
    fetchLatestNavPct(codes)
      .then((r) => { if (alive && r.ok) setNavPct(r.data || {}) })
      .catch(() => {})
    fetchFundLiveSnapshot(codes)
      .then((r) => { if (alive && r.ok) setSnapshots(r.data || {}) })
      .catch(() => {})
    return () => { alive = false }
  }, [posCodesKey])

  // 下拉刷新：重新拉账户数据 + 今日大盘 + 盘中估值 / 昨日涨幅
  const posRef = useRef([])
  posRef.current = positions || []
  useEffect(() => {
    return registerPullRefresh(async () => {
      await refresh?.()
      fetchMarketIndex().then(r => { if (r.ok) setIndexes(r.data ?? []) }).catch(() => {})
      const codes = posRef.current.map(p => p.fund_code).filter(Boolean)
      if (codes.length) {
        fetchYesterdayPct(codes).then(r => { if (r.ok) setYPct(r.data || {}) }).catch(() => {})
        fetchLatestNavPct(codes).then(r => { if (r.ok) setNavPct(r.data || {}) }).catch(() => {})
        fetchFundLiveSnapshot(codes).then(r => { if (r.ok) setSnapshots(r.data || {}) }).catch(() => {})
      }
    })
  }, [refresh])

  // 风控提醒：来自兜底调度器那一轮 / 本地库。
  useEffect(() => {
    let alive = true
    const load = async () => {
      const r = await jsCheckAccountStop()
      if (alive && r.ok) setRiskAlert(r.data ?? null)
    }
    const t1 = setTimeout(load, 12000)
    const t2 = setTimeout(load, 30000)
    const hasWin = typeof window !== 'undefined'
    if (hasWin) window.addEventListener('fundapp:cycle-done', load)
    return () => {
      alive = false
      clearTimeout(t1); clearTimeout(t2)
      if (hasWin) window.removeEventListener('fundapp:cycle-done', load)
    }
  }, [])

  // 风控提醒：不常驻、仅真实持仓加入才提醒、3 秒隐去。
  // 页面栈里导入面板是覆盖层，导入成功时弹在持仓页之下看不到 → 用"待提醒"标记，等回到持仓页（nav.page 为空）再弹。
  useEffect(() => {
    const onAdded = () => { pendingRiskTip.current = true }
    const hasWin = typeof window !== 'undefined'
    if (hasWin) window.addEventListener('fundapp:real-holding-added', onAdded)
    return () => { if (hasWin) window.removeEventListener('fundapp:real-holding-added', onAdded) }
  }, [])

  // 回到持仓页（栈空）且有待提醒 → 重新评估风控，命中才显示 3 秒后自动隐去。
  useEffect(() => {
    if (nav.page || !pendingRiskTip.current) return
    pendingRiskTip.current = false
    let alive = true
    ;(async () => {
      try {
        const r = await jsCheckAccountStop()
        if (!alive || !r.ok) return
        const data = r.data ?? null
        setRiskAlert(data)
        if (data?.triggered) {
          setRiskTipVisible(true)
          if (riskTipTimer.current) clearTimeout(riskTipTimer.current)
          riskTipTimer.current = setTimeout(() => setRiskTipVisible(false), 3000)
        }
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [nav.page])

  // 完全隔离：本页 = **真实持仓系统**首页。
  //   只统计截图导入的真实持仓（source='real'）；交易页用自设本金买入的「虚拟持仓」不在本页出现。
  const realPositions = (positions || []).filter(p => p.source === 'real')

  const totalMv = realPositions.reduce((s, p) => s + (p.market_value ?? 0), 0)
  // 真实持仓没有现金账本（不接交易盘）→ 总资产 = 真实持仓市值
  const totalAsset = totalMv

  // 累计收益 = 真实持仓浮动盈亏（真实持仓无卖出记录，不掺交易盘的已实现盈亏）
  const totalCost = realPositions.reduce((s, p) => s + (p.total_cost ?? 0), 0)
  const unrealized = totalMv - totalCost
  const cumulativePnl = unrealized

  // 「当日涨跌幅」口径：① 有跟踪指数实时行情 → 用指数实时涨跌幅近似当日；
  //   ② 否则 → 最新净值日涨跌幅。不把持仓累计收益率误标为当日。
  const todayPctOf = (p) => {
    const s = snapshots[p.fund_code]
    if (s && s.index_pct != null) return Number(s.index_pct)   // 盘中：跟踪指数实时
    if (s && s.nav_pct != null) return Number(s.nav_pct)        // 接口最新净值日涨跌
    const np = navPct[p.fund_code]
    if (np && np.pct != null) return Number(np.pct)             // 本地库兜底（离线）
    return null
  }
  // 今日预估收益：当日涨跌幅 × 当前市值
  const todayPnl = realPositions.reduce((s, p) => {
    const t = todayPctOf(p)
    if (t == null) return s
    return s + (p.market_value ?? 0) * t / 100
  }, 0)
  // 昨日收益：昨日涨幅 × 昨日市值（昨日市值 = 最新市值 ÷ (1+当日涨跌幅)）—— 当日涨跌幅用上面正确口径
  const yesterdayPnl = realPositions.reduce((s, p) => {
    const yp = yPct[p.fund_code]
    if (yp == null) return s
    const mv = p.market_value ?? 0
    const t = todayPctOf(p)
    const mvYesterday = (t != null && t > -100) ? mv / (1 + t / 100) : mv
    return s + mvYesterday * yp / 100
  }, 0)
  // 今日口径来源标注：有指数实时行情 → 按指数估算；否则按最新净值（带日期）
  const hasLiveQuote = realPositions.some((p) => { const s = snapshots[p.fund_code]; return s && s.index_pct != null })
  const latestNavDate = realPositions
    .map((p) => snapshots[p.fund_code]?.nav_date || navPct[p.fund_code]?.nav_date)
    .filter(Boolean).sort().pop()
  const todaySourceLabel = hasLiveQuote
    ? '按跟踪指数估算'
    : (latestNavDate ? `按净值 ${String(latestNavDate).slice(5)}` : '')

  const fetchBanner = fetchingNav ? (
    <div className="fetch-banner">
      <span className="fetch-spinner" />
      <span>正在更新基金数据… 已更新净值 {navCount} 只</span>
    </div>
  ) : null

  // 真实持仓入口 → 详情页隐藏「手动买入 / 手动赎回」（hideTrade；真实持仓不接交易盘）
  const gotoDetail = (fundCode, fundName) => nav.push('fundDetail', { code: fundCode, name: fundName, hideTrade: true })

  // 单行持仓渲染（两块共用）
  const renderPosRow = (p) => (
    <div
      key={p.fund_code}
      className="hold-row"
      role="button"
      tabIndex={0}
      onClick={() => gotoDetail(p.fund_code, p.fund_name || p.fund_code)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gotoDetail(p.fund_code, p.fund_name || p.fund_code) } }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="hold-row-name">{p.fund_name || p.fund_code}</div>
        <div className="hold-row-sub">
          {p.fund_code} · 份额 {p.total_shares > 0 ? p.total_shares.toFixed(2) : '—'}
          {/* 显示「最新净值日涨跌幅」（带净值日期）；不把累计收益率误标为"当日" */}
          {(() => {
            const s = snapshots[p.fund_code]
            const nd = s?.nav_date || navPct[p.fund_code]?.nav_date
            const npv = s?.nav_pct != null ? s.nav_pct : navPct[p.fund_code]?.pct
            if (!nd || npv == null) return null
            return <> · 净值 {String(nd).slice(5)} <span className={cls(npv)}>{pct(npv)}</span></>
          })()}
          {p.source === 'real' && !(p.total_shares > 0) && (
            <span style={{ marginLeft: 6, color: 'var(--warn)', fontSize: 11 }}>· 份额待补，点「修改」</span>
          )}
        </div>
      </div>
      {(() => {
        // 优先「跟踪指数实时涨跌幅 + 预估收益金额」；无实时行情 → 回落持仓累计收益率
        const s = snapshots[p.fund_code]
        if (s && s.index_pct != null) {
          const pnl = (p.market_value ?? 0) * Number(s.index_pct) / 100
          return (
            <div className="hold-row-right">
              <div className={`hold-row-pct ${cls(s.index_pct)}`}>
                <span className="hold-live-tag">实时</span>{pct(s.index_pct)}
              </div>
              <div className="hold-row-est-sub">
                预估 {pnl >= 0 ? '+' : '-'}{money(Math.abs(pnl))}
              </div>
            </div>
          )
        }
        return (
          <div className={`hold-row-pct ${cls(p.profit_pct)}`}>
            {p.profit_pct != null ? pct(p.profit_pct) : '—'}
          </div>
        )
      })()}
      {/* 真实持仓行操作——修改（OCR 纠错）/ 移除（删除 OCR 批次）。
          stopPropagation 避免触发整行跳转详情。两按钮竖排，手机小屏不挤。 */}
      {p.source === 'real' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 10, flex: '0 0 auto', alignItems: 'stretch' }}>
          <button
            className="hold-row-remove"
            style={{ fontSize: 12, color: 'var(--accent)', background: 'transparent', border: 'none' }}
            onClick={(e) => { e.stopPropagation(); setEditTarget(p) }}
          >修改</button>
          <button
            className="hold-row-remove"
            style={{ fontSize: 12, color: 'var(--danger)', background: 'transparent', border: 'none' }}
            onClick={(e) => { e.stopPropagation(); setConfirmRemove({ code: p.fund_code, name: p.fund_name || p.fund_code }) }}
          >移除</button>
        </div>
      )}
    </div>
  )

  return (
    <div className="hold-root">
      {fetchBanner}

      {/* N2 今日大盘：放在资产区上方，回答「外面今天怎么样」。
          数据复用 fetchMarketIndex（四大指数，腾讯主源）；抓不到整条不显示，不造假。
          右侧「估值 ›」跳指数估值页（G3：PE/PB 历史分位）。 */}
      {indexes.length > 0 && (
        <div className="hold-block market-bar" style={{ marginTop: 8 }}>
          <div className="market-bar-head">
            <span className="market-bar-title">今日大盘</span>
            <span
              className="link-btn"
              role="button"
              tabIndex={0}
              onClick={() => nav.push('page', { title: '指数估值', body: () => <IndexValuationPanel /> })}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav.push('page', { title: '指数估值', body: () => <IndexValuationPanel /> }) } }}
            >估值 ›</span>
          </div>
          <div className="market-bar-row">
            {indexes.map(ix => (
              <div className="market-bar-item" key={ix.code}>
                <div className="mb-name">{ix.name}</div>
                <div className="mb-val">{ix.value.toFixed(2)}</div>
                <div className="mb-pct" style={{ color: ix.change_pct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                  {ix.change_pct >= 0 ? '+' : ''}{ix.change_pct.toFixed(2)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 总资产（平铺无卡） */}
      <div className="hold-hero">
        <div className="hold-hero-label">总资产 (元)</div>
        <div className="hold-hero-value">¥{totalAsset.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</div>
        <div className="hold-hero-sub">
          持仓 {money(totalMv)}
          <span className={cls(cumulativePnl)} style={{ marginLeft: 12 }}>
            总收益 {cumulativePnl > 0 ? '+' : ''}{money(cumulativePnl)}
          </span>
        </div>
        {positions.length > 0 && (
          <div className="hold-hero-sub">
            今日预估 <span className={cls(todayPnl)}>{todayPnl >= 0 ? '+' : '-'}{money(Math.abs(todayPnl))}</span>
            {todaySourceLabel && (
              <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--text-mute)' }}>（{todaySourceLabel}）</span>
            )}
            {yesterdayPnl !== 0 && (
              <span style={{ marginLeft: 12 }}>
                昨日收益 <span className={cls(yesterdayPnl)}>{yesterdayPnl >= 0 ? '+' : '-'}{money(Math.abs(yesterdayPnl))}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* 风控提醒（仅提醒，不拦截交易）—— 仅真实持仓加入、回到本页时短暂弹出 3 秒（不常驻） */}
      {riskTipVisible && riskAlert?.triggered && (
        <div className="risk-banner" role="alert">
          <span className="risk-banner-dot">⚠</span>
          <div className="risk-banner-body">
            <strong>风控提醒（仅提醒，不拦截交易）</strong>
            <div className="risk-banner-msg">{riskAlert.note}</div>
            <div className="risk-banner-time">
              账户回撤 {Number(riskAlert.drawdown_pct).toFixed(2)}% / 阈值 {riskAlert.limit_pct}%
            </div>
            <button
              className="btn btn-sm"
              style={{ marginTop: 6 }}
              onClick={() => navigate('settings')}
            >生成减仓建议（去「我的 → 智能助手」）</button>
          </div>
        </div>
      )}

      {/* 真实持仓列表（全宽整块）—— 本页只出现真实持仓；交易买入的「虚拟持仓」在交易页看 */}
      <div className="hold-block">
        <div className="hold-block-title">
          <span className="src-tag src-tag-real">真实</span>
          真实持仓（截图识别导入）· 共 {realPositions.length} 只
        </div>
        {!realPositions.length ? (
          <div className="hold-empty">
            还没有导入真实持仓<br />
            <span className="hold-empty-hint">点下方「导入真实持仓截图」，把真实持仓导入进来</span>
          </div>
        ) : realPositions.map(renderPosRow)}
      </div>

      {/* OCR 导入真实持仓 */}
      <div className="hold-block" style={{ padding: '14px 16px' }}>
        <button
          className="hold-import-btn"
          onClick={() => nav.push('page', { title: '导入持仓截图', body: () => <ImportHoldingsPanel /> })}
        >
          ＋ 导入真实持仓截图（OCR）
        </button>
        <div className="hold-empty-hint" style={{ textAlign: 'center', marginTop: 8 }}>
          上传支付宝 / 天天基金的持仓截图，本机离线识别，不联网、不上传
        </div>
      </div>

      {/* 移除真实持仓二次确认 */}
      <ConfirmDialog
        open={!!confirmRemove}
        danger
        title="移除真实持仓"
        message={`确定移除「${confirmRemove?.name || ''}」的真实持仓吗？\n仅删除本机 OCR 导入的记录，不可撤销。`}
        confirmText="移除"
        onConfirm={async () => {
          if (confirmRemove) {
            await removeHolding(confirmRemove.code, 'real')
            await refresh?.()
          }
        }}
        onClose={() => setConfirmRemove(null)}
      />

      {/* 修改真实持仓（OCR 纠错） */}
      <EditHoldingDialog
        open={!!editTarget}
        position={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={async () => { await refresh?.() }}
      />
    </div>
  )
}
