// Trade.jsx · 交易页
//
// 改进：
//   - 从 store.selectedFund 初始化选中基金，手动选中的基金同步回 store
//   - 买入/卖出/关注成功后调用 navigate('account') 自动跳回账户页
//   - 净值抓取失败时：保留⏳或改为明确失败提示，不再误导为"已好"
//   - 切 Tab 再回来：selectedFund 来自 store，自动恢复并继续抓取
//   - 操作反馈统一走全局 Toast（useStore.notify），撤销订单改用 ConfirmDialog
//     （不再用原生 window.confirm）；限大额按「单日上限内可买」处理

import { useEffect, useState, useCallback, useRef } from 'react'
import Skeleton from '../components/Skeleton'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import Modal from '../components/Modal'
import DingtouCard from '../components/DingtouCard'
import { money, pct } from '../lib/format'
import {
  fetchAllOrders, fetchBudget, fetchWatchlist,
  fetchFundMeta, jsCheckTradable,
  submitBuy, submitSell, cancelOrderOnDevice,
  confirmOrderOnDevice,
  searchFullMarket, toggleFavorite,
  fetchNavForFund, navCountForFund,
  fetchFundDetail, getDb,
  fetchFundEstimate,
  addCapital, ensureInitialCapital, resetBudgetLedger, fetchInFlightCapital,
  jsDingtouList, removeHolding,
} from '../lib/dataAdapter'
import { navStats } from '../../core/analysis.ts'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'
import { useData } from '../hooks/useData'
import { useStore } from '../store/useStore'
import { useNav } from '../lib/nav.jsx'
import { takePendingTrade } from '../lib/pendingAction'

// 模块级缓存——Trade 进二级页被卸载、返回重新挂载时，立即用上次数据渲染，
// 不再闪空态/骨架（orders/budget/watchlist 原是本地 state，卸载即丢）；
// selected/searchQ 也进缓存，返回瞬间恢复选中面板。
let _cache = { orders: [], budget: null, watchlist: [], selected: null, searchQ: '' }

export default function Trade() {
  const { initialized, selectedFund, refresh, navigate, setSelectedFund, positions } = useData()
  const notify = useStore((s) => s.notify)
  const nav = useNav()
  const [orders, setOrders] = useState(_cache.orders)
  const [budget, setBudget] = useState(_cache.budget)
  const [searchQ, setSearchQ] = useState(_cache.searchQ)
  const [searchResults, setSearchResults] = useState([])
  const [searchHint, setSearchHint] = useState(null)
  const [watchlist, setWatchlist] = useState(_cache.watchlist)
  // selected 与 store.selectedFund 双向同步
  const [selected, setSelected] = useState(_cache.selected)
  const [meta, setMeta] = useState(null)
  const [tradableErr, setTradableErr] = useState('')
  const [amount, setAmount] = useState('')
  const [shares, setShares] = useState('')
  const [err, setErr] = useState('')
  const [cancelConfirm, setCancelConfirm] = useState(null)   // 待撤销订单号
  const [busy, setBusy] = useState(false)
  const [navLoading, setNavLoading] = useState(false)
  const [navFetchErr, setNavFetchErr] = useState('')
  // 基金净值明细 + 收益统计（全部读本地 SQLite；navVer 变化时重载）
  const [fundData, setFundData] = useState(null)
  const [stats, setStats] = useState(null)
  const [navVer, setNavVer] = useState(0)
  const [estimate, setEstimate] = useState(null)   // 盘中实时估值
  // 本金追加（用户自设）；清零重设 + 在途资金显性化
  const [capitalOpen, setCapitalOpen] = useState(false)
  const [capitalInput, setCapitalInput] = useState('')
  const [capitalBusy, setCapitalBusy] = useState(false)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [removeTrade, setRemoveTrade] = useState(null)   // 虚拟持仓移除二次确认 { code, name }
  const [inFlight, setInFlight] = useState({ pending_buy: 0, pending_sell: 0 })
  const [dtPlans, setDtPlans] = useState([])   // N1：交易页一级定投区显示计划数
  const reload = async () => {
    try {
      const [o, b, wl, inf, dt] = await Promise.all([fetchAllOrders(), fetchBudget(), fetchWatchlist(), fetchInFlightCapital(), jsDingtouList()])
      if (o.ok) setOrders(o.data ?? [])
      if (b.ok) setBudget(b.data)
      if (wl.ok) setWatchlist(wl.data ?? [])
      if (inf.ok) setInFlight(inf.data ?? { pending_buy: 0, pending_sell: 0 })
      if (dt.ok) setDtPlans(dt.data ?? [])
      _cache = {
        orders: o.ok ? (o.data ?? []) : _cache.orders,
        budget: b.ok ? b.data : _cache.budget,
        watchlist: wl.ok ? (wl.data ?? []) : _cache.watchlist,
        selected: _cache.selected,
        searchQ: _cache.searchQ,
      }
    } catch (_) { /* 查询失败保留缓存数据 */ }
  }

  // 下拉刷新：重新拉订单 / 预算 / 关注 / 在途 / 定投计划
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => registerPullRefresh(() => reloadRef.current?.()), [])

  useEffect(() => {
    if (!initialized) return
    // 启动不注入默认本金（装新包可用现金=0），只做账本兜底清理 → 再读预算
    ensureInitialCapital()
      .then(() => reload())
      .catch(() => { reload() })
  }, [initialized])

  // 消费详情页「手动买入 / 手动赎回」带过来的指令。
  // 双通道：挂载时取一次 + 监听事件（Trade 已挂载、Tab 未变时不会重新 mount）。
  useEffect(() => {
    const consume = () => {
      const p = takePendingTrade()
      if (!p || !p.code) return
      setErr('')
      // 11 AI 开放：AI 建议可带建议金额 → 预填表单（最后一步永远是人改数量 + 按确认）
      setAmount(p.amount != null && Number(p.amount) > 0 ? String(p.amount) : '')
      setShares('')
      setSearchQ('')
      _cache.searchQ = ''
      if (p.reason) notify(`AI 建议已预填（金额可改，确认由你来按）：${p.reason}`, 'success')
      // 交给全局 selectedFund → 下面那个 effect 会把基金查出来并展开买卖区
      setSelectedFund(p.code)
    }
    consume()
    window.addEventListener('fundapp:fund-trade', consume)
    return () => window.removeEventListener('fundapp:fund-trade', consume)
  }, [setSelectedFund, notify])

  /** 追加本金（用户自设） */
  const doAddCapital = useCallback(async () => {
    const v = Number(capitalInput)
    if (!Number.isFinite(v) || v <= 0) { notify('请输入大于 0 的金额', 'error'); return }
    setCapitalBusy(true)
    try {
      const r = await addCapital(v, 'manual', '交易追加')
      if (!r.ok) { notify(`追加失败：${r.error}`, 'error'); return }
      await reload()
      setCapitalOpen(false)
      setCapitalInput('')
      notify(`已追加 ${money(v)} 到练手资金`, 'success')
    } finally {
      setCapitalBusy(false)
    }
  }, [capitalInput, notify])

  /** 一键清零重设（09 可逆性）：清余额/持仓/在途，保留流水历史 */
  const doResetCapital = useCallback(async () => {
    setResetConfirm(false)
    setCapitalBusy(true)
    try {
      const r = await resetBudgetLedger()
      if (!r.ok) { notify(`清零失败：${r.error}`, 'error'); return }
      await reload()
      notify('已清零重设：余额 / 持仓 / 待确认订单都归 0（流水历史保留）', 'success')
    } finally {
      setCapitalBusy(false)
    }
  }, [notify])

  // 外部带入：从 store.selectedFund 初始化选中基金（如账户页/分析页跳转过来）
  useEffect(() => {
    if (!selectedFund) return
    // 缓存已有同一只 → 直接恢复（返回二级页场景），不再重新查询
    if (_cache.selected?.fund_code === selectedFund) {
      setSelected(_cache.selected)
      return
    }
    let cancelled = false
    searchFullMarket(selectedFund).then(r => {
      if (!cancelled) {
        const found = (r.data ?? []).find(f => f.fund_code === selectedFund)
        if (found) {
          setSelected(found)
          setSearchQ(selectedFund)
          _cache.selected = found
        }
      }
    })
    return () => { cancelled = true }
  }, [selectedFund])

  // 实时全市场搜索（防抖 250ms）
  useEffect(() => {
    if (!initialized) return
    const q = searchQ.trim()
    if (!q) { setSearchResults([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const r = await searchFullMarket(q)
      if (!cancelled) {
        setSearchResults(r.data ?? [])
        if (r.hint && r.hint !== '没有找到匹配的基金') {
          setSearchHint(r.hint)
        } else {
          setSearchHint(null)
        }
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [searchQ, initialized])

  // 净值抓取：选中的基金本地无净值时触发
  useEffect(() => {
    if (!selected) { setNavLoading(false); setNavFetchErr(''); return }
    const code = selected.fund_code
    let cancelled = false
    ;(async () => {
      // 近 400 天内已有 ≥200 条才算"历史完整"（约 250 个交易日，留余量）。
      // 不能只数总数：000001 曾只有 2001-2006 的 1145 条（≥30 也 ≥1000），
      // 结果收益用"2006 年的点"当基准算出 +136% 的假数。近期条数不足 → 重抓补全。
      const cnt = await navCountForFund(code)
      if (cancelled || cnt >= 200) return
      setNavLoading(true)
      setNavFetchErr('')
      const r = await fetchNavForFund(code)
      if (!cancelled) {
        if (r.ok && r.data.inserted > 0) {
          console.log(`[Trade] ${code} 净值已优先更新，inserted=${r.data.inserted}`)
          setNavLoading(false)
          setNavVer(v => v + 1)   // 净值落库 → 让数据面板重载
        } else {
          // 失败：显示明确错误态，不误导
          setNavLoading(false)
          setNavFetchErr(`该基金净值暂未同步，稍后自动更新`)
          console.warn(`[Trade] ${code} 净值抓取失败:`, r.error)
        }
      }
    })()
    return () => { cancelled = true }
  }, [selected])

  // 选中基金 / 净值更新后：读净值明细 + 收益统计（**全部来自本地 SQLite**，不依赖后端）
  useEffect(() => {
    if (!selected) { setFundData(null); setStats(null); return }
    let alive = true
    const code = selected.fund_code
    ;(async () => {
      const r = await fetchFundDetail(code)
      if (alive && r.ok) setFundData(r.data)
      const db = getDb()
      if (db) {
        const s = await navStats(db, code)
        if (alive) setStats(s)
      }
    })()
    return () => { alive = false }
  }, [selected, navVer])

  // 盘中实时估值：选中基金时拉一次（交易时段有实时值，非交易时段为上一交易日快照）
  useEffect(() => {
    if (!selected) { setEstimate(null); return }
    let alive = true
    fetchFundEstimate(selected.fund_code).then(r => { if (alive && r.ok) setEstimate(r.data ?? null) })
    return () => { alive = false }
  }, [selected])

  // 选中基金时拉 meta + 校验是否可投
  useEffect(() => {
    if (!selected) { setMeta(null); setTradableErr(''); return }
    let cancelled = false
    ;(async () => {
      const [mR, tR] = await Promise.all([
        fetchFundMeta(selected.fund_code),
        jsCheckTradable(selected.category || '', selected.fund_name || ''),
      ])
      if (!cancelled) {
        if (mR.ok) setMeta(mR.data)
        if (tR.ok && !tR.data?.tradable) setTradableErr(tR.data.reason || '不可投')
        else setTradableErr('')
      }
    })()
    return () => { cancelled = true }
  }, [selected])

  // 手动选基金时同步到 store（双向同步）
  const handleSelectFund = useCallback((fund) => {
    setSelected(fund)
    setSelectedFund(fund.fund_code)  // 同步回 store，切 Tab 回来自动恢复
    _cache.selected = fund            // 缓存选中对象：进二级页返回后瞬间恢复
    _cache.searchQ = ''               // 选中后搜索框清空（与点击行内的 setSearchQ('') 一致）
  }, [setSelectedFund])

  const validateBuy = () => {
    if (!selected) return '请先选择基金'
    if (tradableErr) return `不可投：${tradableErr}`
    if (!meta) return '基金数据加载中'
    const min = meta.min_purchase            // null = 源里未知（06 规范：不兜 1，不做下限校验）
    const lim = meta.purchase_limit
    const status = meta.purchase_status || ''
    // 暂停申购 / 封闭期：整只不可买；**限大额只是单日有上限，仍可在限额内买**
    if (status.includes('暂停') || status.includes('封闭')) {
      return `${status}，无法买入`
    }
    const a = parseFloat(amount)
    if (!a || a <= 0) return '金额必须为正数'
    if (min != null && a < min) return `低于起购金额 ${min} 元，无法提交`
    if (lim && a > lim) return `超过单日上限 ${lim} 元，无法提交`
    const avail = budget?.available ?? 0
    if (a > avail) return `超过可用预算 ${money(avail)}，无法提交`
    return ''
  }

  const validateSell = () => {
    if (!selected) return '请先选择基金'
    const held = selected.total_shares ?? 0
    const s = parseFloat(shares)
    if (!s || s <= 0) return '份额必须为正数'
    if (s > held + 0.0001) return `份额不足，最多可赎 ${held.toFixed(2)}`
    return ''
  }

  const onBuy = async () => {
    const msg = validateBuy()
    setErr(msg)
    if (msg) return
    setBusy(true)
    try {
      const r = await submitBuy({ fundCode: selected.fund_code, amount: parseFloat(amount), reason: '手动下单' })
      if (!r.ok) { notify(r.error || '下单失败', 'error'); return }
      notify(`订单已提交：${r.data.orderId}`, 'success')
      setAmount('')
      // 新持仓 → 后台补一次穿透（行业配置 + 前十重仓），不阻塞跳转
      import('../lib/scheduler')
        .then(m => m.refreshPenetrationFor([selected.fund_code]))
        .catch(() => { /* 失败不影响下单 */ })
      await refresh()
      await navigate('account')  // 修复 4：操作后自动跳回账户页
    } finally {
      setBusy(false)
    }
  }

  const onSell = async () => {
    const msg = validateSell()
    setErr(msg)
    if (msg) return
    setBusy(true)
    try {
      const r = await submitSell({ fundCode: selected.fund_code, shares: parseFloat(shares), reason: '手动赎回' })
      if (!r.ok) { notify(r.error || '赎回失败', 'error'); return }
      notify(`赎回订单已提交：${r.data.orderId}`, 'success')
      setShares('')
      await refresh()
      await navigate('account')  // 修复 4：操作后自动跳回账户页
    } finally {
      setBusy(false)
    }
  }

  const onConfirm = async (orderId) => {
    setBusy(true)
    try {
      const r = await confirmOrderOnDevice(orderId, '手动确认')
      if (!r.ok) { notify(`确认失败：${r.error}`, 'error'); return }
      notify(`已确认 ${r.data.orderId}`, 'success')
      await refresh()
      await navigate('account')
    } finally {
      setBusy(false)
    }
  }

  // 撤销订单：走统一确认弹窗（替代原生 window.confirm）
  const onCancel = (orderId) => setCancelConfirm(orderId)

  const confirmCancel = async () => {
    const orderId = cancelConfirm
    setBusy(true)
    try {
      const r = await cancelOrderOnDevice(orderId)
      if (!r.ok) { notify(`撤销失败：${r.error}`, 'error'); return }
      notify('订单已撤销', 'success')
      await refresh()
      await navigate('account')
    } finally {
      setBusy(false)
    }
  }

  const onToggleFavorite = async (fund) => {
    const isFav = watchlist.some(f => f.fund_code === fund.fund_code)
    const r = await toggleFavorite(fund.fund_code)
    if (!r.ok) { notify(r.error || '操作失败', 'error'); return }
    if (isFav) {
      setWatchlist(prev => prev.filter(f => f.fund_code !== fund.fund_code))
      notify('已取消关注', 'info')
    } else {
      setWatchlist(prev => [...prev, fund])
      notify('已加入关注', 'success')
      // 新关注 → 后台补一次穿透（行业配置 + 前十重仓），不阻塞 UI
      import('../lib/scheduler')
        .then(m => m.refreshPenetrationFor([fund.fund_code]))
        .catch(() => { /* 失败不影响关注 */ })
    }
    await refresh()
  }

  const isInWatchlist = (code) => watchlist.some(f => f.fund_code === code)

  // 输入时实时校验
  useEffect(() => {
    if (!selected || !amount) { setErr(''); return }
    setErr(validateBuy())
  }, [amount, selected, meta, budget])

  // 只在「未初始化」时整页占位；loading 期间照常渲染结构、数据到了自动填充
  // （二级页返回重新挂载时 loading=true，若后台正在批量落库，查询可能被拖慢数秒，
  //   此时显示骨架而非白板；资金卡显示 ¥0 属真实值，非造假）。
  if (!initialized) {
    return (
      <div className="trade-root">
        <Skeleton variant="line" count={4} />
      </div>
    )
  }

  const pendingOrders = orders.filter(o => o.status === 'pending')
  const min = meta?.min_purchase            // null = 源里未知（06 规范：不兜 1）
  const lim = meta?.purchase_limit
  const status = meta?.purchase_status || ''

  // 净值面板数据（本地 nav_daily 最新一条 + 前一条算日涨跌）
  const navList = fundData?.navs ?? []
  const lastNav = navList.length ? navList[navList.length - 1] : null
  const prevNav = navList.length > 1 ? navList[navList.length - 2] : null
  const dayGrowth = lastNav && prevNav && prevNav.nav ? ((lastNav.nav / prevNav.nav) - 1) * 100 : null

  // 完全隔离：本页只列**交易买入的虚拟持仓**（截图导入的真实持仓不在交易页出现）
  const tradePositions = (positions || []).filter(p => p.source === 'trade')

  return (
    <div className="trade-root">
      {/* 资金卡（09：四块人话——本金/可用现金/持仓市值/在途；追加自填无上限，清零有二次确认） */}
      <div className="hold-hero">
        <div className="hold-hero-label">
          可用现金 (元)
          <span
            className="link-btn"
            style={{ marginLeft: 'auto' }}
            role="button"
            tabIndex={0}
            onClick={() => { setCapitalInput(''); setCapitalOpen(true) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCapitalInput(''); setCapitalOpen(true) } }}
          >＋ 追加</span>
          <span
            className="link-btn"
            style={{ marginLeft: 12 }}
            role="button"
            tabIndex={0}
            onClick={() => setResetConfirm(true)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setResetConfirm(true) } }}
          >清零重设</span>
        </div>
        <div className="hold-hero-value">{money(budget?.available ?? 0)}</div>
        <div className="hold-hero-sub">
          本金（你投入的） {money(budget?.cumulative_added ?? 0)}
        </div>
        <div className="hold-hero-sub">
          持仓市值 {money(budget?.used_in_positions ?? 0)}
          <span style={{ marginLeft: 12 }}>在途资金 {money((inFlight.pending_buy ?? 0) + (inFlight.pending_sell ?? 0))}</span>
        </div>
        <div className="muted cell-note" style={{ marginTop: 6, lineHeight: 1.7 }}>
          待确认买入（冻结）{money(inFlight.pending_buy ?? 0)} · 赎回在途 {money(inFlight.pending_sell ?? 0)}（卖出的钱过几天才到账，暂不可用）。
          本金自己定，点「＋ 追加」输入。
        </div>
      </div>

      {/* 虚拟持仓（交易买入）—— 完全隔离：本页只出现交易盘自己的持仓，
          截图导入的**真实持仓不在本页出现**（在「持仓」页看）。 */}
      <div className="trade-block sim-block" style={{ padding: 0 }}>
        <div className="hold-block-title" style={{ padding: '12px 16px 4px' }}>
          <span className="src-tag src-tag-sim">模拟</span>
          虚拟盘（练手账本）· 共 {tradePositions.length} 只
        </div>
        {!tradePositions.length ? (
          <div className="hold-empty" style={{ padding: '6px 16px 14px' }}>
            还没有虚拟持仓<br />
            <span className="hold-empty-hint">在下方搜索基金下单买入，这里就会出现</span>
          </div>
        ) : tradePositions.map(p => (
          <div
            key={p.fund_code}
            className="hold-row"
            role="button"
            tabIndex={0}
            onClick={() => setSelectedFund?.(p.fund_code)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedFund?.(p.fund_code) } }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="hold-row-name">{p.fund_name || p.fund_code}</div>
              <div className="hold-row-sub">
                {p.fund_code} · 份额 {p.total_shares != null ? p.total_shares.toFixed(2) : '—'} · 市值 {money(p.market_value ?? 0)}
              </div>
            </div>
            <div className={`hold-row-pct ${(p.profit_pct ?? 0) >= 0 ? 'pos' : 'neg'}`}>
              {p.profit_pct != null ? pct(p.profit_pct) : '—'}
            </div>
            {/* 移除虚拟持仓（练手账本），二次确认。stopPropagation 避免触发整行选中 */}
            <button
              className="hold-row-remove"
              style={{ marginLeft: 10, fontSize: 12, color: 'var(--danger)', background: 'transparent', border: 'none', flex: '0 0 auto' }}
              onClick={(e) => { e.stopPropagation(); setRemoveTrade({ code: p.fund_code, name: p.fund_name || p.fund_code }) }}
            >移除</button>
          </div>
        ))}
      </div>

      {/* N1 定投上提：高频且独立决策的功能不该埋在「我的」设置列表里。
          交易 = 执行资金，定投 = 周期性执行交易 → 语义归组在此。
          与「我的 → 定投计划」指向同一 DingtouCard，不重复实现。 */}
      <div className="trade-block" style={{ padding: 0 }}>
        <div
          className="hold-row"
          role="button"
          tabIndex={0}
          onClick={() => nav.push('page', { title: '定投计划', body: () => <DingtouCard /> })}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav.push('page', { title: '定投计划', body: () => <DingtouCard /> }) } }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hold-row-name">定投</div>
            <div className="hold-row-sub">
              {dtPlans.length
                ? `已签 ${dtPlans.length} 份（启用 ${dtPlans.filter(p => p.enabled).length} 份）· 固定金额、固定节奏买入`
                : '固定金额、固定节奏自动买入，签一份试试'}
            </div>
          </div>
          <span style={{ color: 'var(--text-mute)', fontSize: 18 }}>›</span>
        </div>
      </div>

      {/* 快捷入口：候选标的（与分析页同一功能，命名统一） */}
      <div className="trade-block" style={{ padding: 0 }}>
        <div
          className="hold-row"
          role="button"
          tabIndex={0}
          onClick={() => navigate('analysis')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('analysis') } }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hold-row-name">候选标的</div>
            <div className="hold-row-sub">筛出该关注的基金（分析页里做）</div>
          </div>
          <span style={{ color: 'var(--text-mute)', fontSize: 18 }}>›</span>
        </div>
      </div>

      {/* ── 搜索框 ── */}
      <div className="trade-block">
        <div className="trade-label">搜索基金</div>
        <input
          type="text"
          className="trade-input"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          placeholder="输入基金代码或名称关键字…"
        />
        {searchQ.trim() && searchResults.length === 0 && (
          <div className="trade-error">{searchHint || '未找到相关基金'}</div>
        )}
        {searchResults.length > 0 && searchResults.map(f => (
          <div
            key={f.fund_code}
            className={`trade-pool-row ${selected?.fund_code === f.fund_code ? 'selected' : ''}`}
            onClick={() => {
              handleSelectFund(f)
              setAmount('')
              setShares('')
              setErr('')
              setSearchQ('')
              _cache.searchQ = ''
            }}
          >
            <span className="trade-pool-name">{f.fund_name || f.fund_code}</span>
            <span className="trade-pool-code">{f.fund_code}</span>
            <button
              className="fav-btn"
              style={{ marginLeft: 8, flexShrink: 0 }}
              onClick={e => { e.stopPropagation(); onToggleFavorite(f) }}
              title={isInWatchlist(f.fund_code) ? '取消关注' : '加入关注'}
            >
              {isInWatchlist(f.fund_code) ? '★' : '☆'}
            </button>
          </div>
        ))}
      </div>

      {/* ── 空态引导：既没在搜索、也没有自选 ── */}
      {!searchQ.trim() && searchResults.length === 0 && watchlist.length === 0 && (
        <div className="trade-block">
          <EmptyState
            title="还没有关注的基金"
            hint="在上面搜索基金代码或名称，点 ☆ 加入关注；之后就能在这里一键买入 / 卖出。"
          />
        </div>
      )}

      {/* ── 已关注列表 ── */}
      {watchlist.length > 0 && (
        <div className="trade-block">
          <div className="trade-label">
            已关注（{watchlist.length}）
            <span className="trade-meta" style={{ marginLeft: 'auto' }}>点击直接交易</span>
          </div>
          {watchlist.map(f => (
            <div
              key={f.fund_code}
              className={`trade-pool-row ${selected?.fund_code === f.fund_code ? 'selected' : ''}`}
              onClick={() => {
                handleSelectFund(f)
                setAmount('')
                setShares('')
                setErr('')
                setSearchQ('')
                _cache.searchQ = ''
              }}
            >
              <span className="trade-pool-name">{f.fund_name || f.fund_code}</span>
              <span className="trade-pool-code">{f.fund_code}</span>
              <button
                className="fav-btn"
                style={{ marginLeft: 8, flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); onToggleFavorite(f) }}
                title="取消关注"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── 基金 meta + 买入/卖出 ── */}
      {selected && (
        <>
          <div className="trade-block">
            <div className="trade-label">
              {selected.fund_name || selected.fund_code}
              <button
                className="trade-link"
                onClick={() => onToggleFavorite(selected)}
                style={{ fontSize: 16, padding: 0 }}
              >
                {isInWatchlist(selected.fund_code) ? '★ 已关注' : '☆ 加入关注'}
              </button>
              <button
                type="button"
                className="trade-link"
                style={{ fontSize: 12, padding: 0, marginLeft: 'auto' }}
                onClick={() => nav.push('fundDetail', { code: selected.fund_code, name: selected.fund_name, title: selected.fund_name })}
              >
                查看详情 ›
              </button>
            </div>
            {navLoading ? (
              <div className="trade-meta" style={{ color: 'var(--warn)', fontWeight: 500 }}>
                ⏳ 净值获取中…
              </div>
            ) : navFetchErr ? (
              <div className="trade-error" style={{ marginTop: 4, fontSize: 11 }}>
                ⚠ {navFetchErr}
              </div>
            ) : null}
            {meta && (
              <div className="trade-meta">
                类型：{meta.category || '—'}
                &nbsp;·&nbsp;起购 {min != null ? `${min} 元` : '未知'}
                {lim ? `，单日上限 ${lim.toLocaleString('zh-CN')} 元` : ''}
                &nbsp;·&nbsp;{status || '开放申购'}
              </div>
            )}
            {tradableErr && (
              <div className="trade-error" style={{ marginTop: 4 }}>⛔ {tradableErr}</div>
            )}

            {/* ── 盘中实时估值（仅交易时段有真实估算值时显示，避免造假）── */}
            {estimate?.live && (
              <div className="fund-est">
                <span className="fund-est-label">盘中估值</span>
                <span className="fund-est-value">{Number(estimate.estimate).toFixed(4)}</span>
                <span className={`fund-est-pct ${estimate.estimate_pct >= 0 ? 'pos' : 'neg'}`}>
                  {estimate.estimate_pct >= 0 ? '+' : ''}{estimate.estimate_pct.toFixed(2)}%
                </span>
                <span className="fund-est-time">估值 {String(estimate.estimate_time || '').slice(5, 16)}</span>
              </div>
            )}

            {/* ── 净值 / 收益数据（全部读本地 SQLite）── */}
            <div className="fund-data">
              {!lastNav ? (
                <div className="trade-meta">暂无净值数据（本地库尚无该基金净值）</div>
              ) : (
                <>
                  <div className="fund-nav-row">
                    <span className="fund-nav-value">{Number(lastNav.nav).toFixed(4)}</span>
                    {dayGrowth != null && (
                      <span className={`fund-nav-chg ${dayGrowth >= 0 ? 'pos' : 'neg'}`}>
                        {dayGrowth >= 0 ? '+' : ''}{dayGrowth.toFixed(2)}%
                      </span>
                    )}
                    <span className="fund-nav-date">截至 {lastNav.nav_date}</span>
                  </div>
                  <div className="fund-stat-grid">
                    {_statCell('近1月', stats?.ret_1m)}
                    {_statCell('近3月', stats?.ret_3m)}
                    {_statCell('近6月', stats?.ret_6m)}
                    {_statCell('近1年', stats?.ret_1y)}
                    {_statCell('跌得最多', stats?.max_drawdown_pct, true)}
                    {_statCell('波动大小', stats?.annual_volatility_pct, false, true)}
                  </div>
                  {stats?.note && (
                    <div className="trade-meta" style={{ marginTop: 6 }}>
                      {stats.note}{stats.samples != null ? `（本地 ${stats.samples} 条）` : ''}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="trade-block">
            <div className="trade-label">金额</div>
            <input
              type="number"
              className={`trade-input ${err && amount ? 'error' : ''}`}
              value={amount}
              onChange={e => setAmount(e.target.value)}
              onBlur={e => setAmount(e.target.value)}
              placeholder={min != null ? `最低 ${min} 元` : '输入买入金额'}
            />
            {err && amount && (
              <div className="trade-error">{err}</div>
            )}
            <div className="trade-actions">
              <button className="trade-btn primary" disabled={busy || !!err || !amount} onClick={onBuy}>
                买入
              </button>
              <button
                className="trade-btn ghost"
                disabled={busy}
                onClick={() => { setSelected(null); setAmount(''); setErr(''); setShares('') }}
              >
                卖出
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── 待确认订单 ── */}
      {pendingOrders.length > 0 && (
        <div className="trade-block">
          <div className="trade-label">待确认订单</div>
          <div className="trade-orders">
            {pendingOrders.map(o => (
              <div key={o.order_id} className="trade-order-row">
                <div className="trade-order-info">
                  <span className="trade-order-name">{o.fund_name || o.fund_code}</span>
                  <span className="trade-order-amount">
                    {o.type === 'buy' ? `¥${o.amount}` : `${o.amount} 份`}
                  </span>
                </div>
                <div className="trade-order-actions">
                  <button className="trade-btn-mini primary" disabled={busy} onClick={() => onConfirm(o.order_id)}>确认</button>
                  <button className="trade-btn-mini ghost" disabled={busy} onClick={() => onCancel(o.order_id)}>撤销</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 撤销订单二次确认（统一弹窗，替代原生 window.confirm） */}
      <ConfirmDialog
        open={!!cancelConfirm}
        danger
        title="撤销订单"
        message={cancelConfirm ? `确定撤销订单 ${cancelConfirm}？撤销后该订单不可恢复。` : ''}
        confirmText="撤销"
        onConfirm={confirmCancel}
        onClose={() => setCancelConfirm(null)}
      />

      {/* 清零重设二次确认（09 可逆性：有入必有出） */}
      <ConfirmDialog
        open={resetConfirm}
        danger
        title="清零重设"
        message={`当前本金 ${money(budget?.cumulative_added ?? 0)}（含持仓 ${money(budget?.used_in_positions ?? 0)} · 可用 ${money(budget?.available ?? 0)}），清零后无法恢复（流水历史保留），确认？`}
        confirmText="确认清零"
        onConfirm={doResetCapital}
        onClose={() => setResetConfirm(false)}
      />

      {/* 移除虚拟持仓二次确认（练手账本，与真实持仓同款能力） */}
      <ConfirmDialog
        open={!!removeTrade}
        danger
        title="移除虚拟持仓"
        message={`确定移除「${removeTrade?.name || ''}」的虚拟持仓吗？\n仅删除练手账本里的该基金持仓，不可撤销（不影响真实持仓）。`}
        confirmText="移除"
        onConfirm={async () => {
          if (removeTrade) {
            await removeHolding(removeTrade.code, 'trade')
            await refresh?.()
          }
        }}
        onClose={() => setRemoveTrade(null)}
      />

      {/* 追加本金（用户自设，无上限）：没有本金，可用预算恒为 0，买入会被拦 */}
      <Modal open={capitalOpen} title="追加本金" onClose={() => setCapitalOpen(false)} width={420}>
        <div className="muted cell-note" style={{ marginBottom: 10, lineHeight: 1.7 }}>
          当前可用 {money(budget?.available ?? 0)}。
        </div>
        <input
          className="trade-input"
          type="number"
          inputMode="decimal"
          placeholder="追加金额（元）"
          value={capitalInput}
          onChange={(e) => setCapitalInput(e.target.value)}
          onBlur={(e) => setCapitalInput(e.target.value)}
        />
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => setCapitalOpen(false)} disabled={capitalBusy}>取消</button>
          <button className="btn btn-primary" onClick={doAddCapital} disabled={capitalBusy || !capitalInput.trim()}>
            {capitalBusy ? '处理中…' : '追加'}
          </button>
        </div>
      </Modal>
    </div>
  )
}

// ─── 净值统计单元格（涨红跌绿，符合 A 股习惯）──────────────────
function _statCell(label, v, invert = false, plain = false) {
  if (v == null) {
    return (
      <div className="fund-stat" key={label}>
        <span className="fs-l">{label}</span>
        <span className="fs-v muted">—</span>
      </div>
    )
  }
  if (invert) {
    // 最大回撤：恒为负向，显示 -x.xx%
    return (
      <div className="fund-stat" key={label}>
        <span className="fs-l">{label}</span>
        <span className="fs-v neg">-{Math.abs(v).toFixed(2)}%</span>
      </div>
    )
  }
  const cls = plain ? '' : (v >= 0 ? 'pos' : 'neg')
  const sign = plain ? '' : (v >= 0 ? '+' : '')
  return (
    <div className="fund-stat" key={label}>
      <span className="fs-l">{label}</span>
      <span className={`fs-v ${cls}`}>{sign}{v.toFixed(2)}%</span>
    </div>
  )
}
