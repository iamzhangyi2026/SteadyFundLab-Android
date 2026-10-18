// More.jsx · 设置页
//
// 功能：
//   - 原样保留工具 / 诊断 / 全量抓取开关
//   - 标题改为"设置"
//   - 新增账户设置 / 关于占位区块

import { useState, useEffect, useRef, useCallback } from 'react'
import Card from '../components/Card'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import { ListGroup, ListItem } from '../components/ui.jsx'
import { registerPullRefresh } from '../lib/pullRefreshRegistry'
import BackupPanel from '../components/BackupPanel'
import DividendTrack from '../components/DividendTrack'
import AlertsPanel from '../components/AlertsPanel'
import RiskPanel from '../components/RiskPanel'
import RebalancePanel from '../components/RebalancePanel'
import GoalPanel from '../components/GoalPanel'
import DingtouCard from '../components/DingtouCard'
import { useNav } from '../lib/nav.jsx'
import { applyTheme, getStoredTheme, storeTheme } from '../lib/theme'
import { useStore } from '../store/useStore'
import {
  exportDiagnostics,
  refreshFundPool,
  getFundsCount,
  getNavFundsCount,
  refreshNavPool,
  stopNavPool,
  getNavPoolProgress,
  _loadCfg,
  fetchDataHealth,
  fetchPositions,
  jsSettingsGet,
  jsSettingsSet,
  SETTINGS_DEFAULTS,
  jsEmergencyStopGet,
  jsEmergencyStopSet,
  fetchPortfolioCurve,
  recordPortfolioSnapshot,
  jsLlmGetConfig,
  jsLlmStatus,
  jsGenerateBriefing,
  jsBriefingMarkdown,
  jsRunInspection,
  jsGetInspection,
} from '../lib/dataAdapter'
import {
  getNetworkAndBatteryStatus,
  subscribeNetworkAndBattery,
} from '../lib/networkStatus'

/**
 * 数据维护卡片
 */
async function _loadCfgSync() {
  try { return await _loadCfg() } catch { return null }
}

function MarketRefreshCard() {
  const [status, setStatus] = useState(null)
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const unsubRef = useRef(null)

  useEffect(() => {
    let mounted = true
    getNetworkAndBatteryStatus().then((s) => { if (mounted) setStatus(s) })
    subscribeNetworkAndBattery((s) => { if (mounted) setStatus(s) }).then((fn) => {
      unsubRef.current = fn
    })
    _loadCfgSync().then((c) => { if (mounted) setCfg(c) })
    return () => {
      mounted = false
      if (unsubRef.current) {
        try { unsubRef.current() } catch (_) { /* ignore */ }
      }
    }
  }, [])

  const handleRefresh = async () => {
    setBusy(true)
    setResult(null)
    const before = await getFundsCount()
    const fromN = before.ok ? before.data : null
    try {
      const r = await refreshFundPool()
      const after = await getFundsCount()
      const toN = after.ok ? after.data : null
      if (!r.ok) {
        setResult({ ok: false, error: r.error, from: fromN, to: toN })
      } else {
        setResult({ ok: true, from: fromN, to: toN, note: r.data?.note })
      }
    } catch (e) {
      setResult({ ok: false, error: e.message, from: fromN, to: null })
    } finally {
      setBusy(false)
    }
  }

  const met = !!(status?.onWifi && status?.charging)
  const switchOn = cfg?.ENABLE_FULL_MARKET_REFRESH !== false
  return (
    <Card className="wide" title="数据维护">
      <p style={{ color: 'var(--text-soft)', fontSize: 13, margin: '4px 0 10px' }}>
        全市场约 2.4 万只，抓取慢（约 30 秒）、吃流量、耗电。建议在
        <strong> 无线网络 + 充电</strong> 且 <strong>夜间时段</strong> 由系统自动跑。
      </p>

      {!switchOn && (
        <div
          className="status-capsule status-updating"
          style={{ marginBottom: 10, fontSize: 12 }}
        >
          ⚙ 后台自动补全已暂停（当前版本默认关闭，不影响使用）
        </div>
      )}

      {status?.reason && (
        <div
          className={`status-capsule ${met ? 'status-connected' : 'status-updating'}`}
          style={{ marginBottom: 10 }}
        >
          {status.reason}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, fontSize: 13, color: 'var(--text-soft)' }}>
        <span>
          当前基金数：
          {result && result.from != null && (
            <strong style={{ color: 'var(--text)' }}>{result.from} 只</strong>
          )}
          {result && result.from != null && result.to != null && result.from !== result.to && (
            <> → <strong style={{ color: 'var(--down)' }}>{result.to} 只</strong>
              <span style={{ marginLeft: 6, color: 'var(--down)' }}>
                (+{result.to - result.from})
              </span>
            </>
          )}
        </span>
        {busy && <span style={{ color: 'var(--warn)' }}>正在更新全市场基金…</span>}
      </div>

      <button
        onClick={handleRefresh}
        disabled={busy || !switchOn}
        className="btn-primary btn-block"
        style={{ width: '100%', opacity: (busy || !switchOn) ? 0.5 : 1 }}
      >
        {busy
          ? '正在更新全市场基金…'
          : !switchOn
            ? '全量抓取已关闭（请打开开关）'
            : met
              ? '立即更新全市场基金'
              : '手动更新（不走无线网络+充电）'}
      </button>
      {!met && status?.reason && (
        <p style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4, textAlign: 'center' }}>
          {status.reason}
        </p>
      )}

      {result && !busy && (
        <div
          className={`trade-flash ${result.ok ? 'ok' : 'err'}`}
          style={{ marginTop: 12 }}
        >
          {result.ok
            ? result.note
              ? result.note
              : `已更新 ${result.from} → ${result.to} 只`
            : `更新失败：${result.error || '未知错误'}`}
        </div>
      )}
    </Card>
  )
}

/**
 * 数据健康度：各表行数 + 抓取门槛时间 + 最近的抓取错误。
 * 目的：一眼看出「哪条数据有、哪条没有、哪条抓失败了」——
 *       否则界面空白时，用户根本不知道是没数据还是坏了。
 */
const HEALTH_LABEL = {
  funds: '基金池',
  nav_daily: '净值',
  fund_status: '申购状态',
  news_feed: '基金公告',
  market_news: '市场资讯',
  intel_events: '情报事件',
  fund_holdings: '持仓明细',
  decision_log: '决策日志',
}

/**
 * 把抓取错误翻译成人话。
 * ⚠️ 绝不把原生技术细节（okhttp 地址、堆栈、SQL、源码路径）甩给用户看。
 */
function humanizeFetchError(msg) {
  const s = String(msg ?? '')
  if (!s) return '抓取异常'
  if (/unexpected end of stream|EOF|Connection reset|SocketException|broken pipe/i.test(s)) return '网络中途断开，数据源没传完（会自动重试）'
  if (/timeout|timed out|Read timed out/i.test(s)) return '数据源响应超时（会自动重试）'
  if (/61136|限流|rate limit|too many/i.test(s)) return '数据源限流，稍后会自动重试'
  if (/HTTP\s*4\d\d|403|401|404/.test(s)) return '数据源拒绝了本次请求（会自动重试）'
  if (/HTTP\s*5\d\d/.test(s)) return '数据源暂时故障（会自动重试）'
  if (/UnknownHost|DNS|resolve|Unable to resolve host/i.test(s)) return '域名解析失败，网络不稳定（会自动重试）'
  if (/duplicate column/i.test(s)) return '本机数据结构已是最新'
  if (/no such table|SQLITE|sqlite/i.test(s)) return '本机数据读写异常（已存数据不受影响）'
  // 兜底：去掉 [模块] 前缀与地址/端口等技术尾巴
  const cleaned = s.replace(/^\[[^\]]*\]\s*/, '').replace(/@[0-9a-f]{6,}/gi, '').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 60) || '抓取异常'
}

function NavPoolCard() {
  const notify = useStore((s) => s.notify)
  const [prog, setProg] = useState(getNavPoolProgress())
  const [navCount, setNavCount] = useState(null)
  const [fundCount, setFundCount] = useState(null)

  const loadCounts = useCallback(async () => {
    const [n, f] = await Promise.all([getNavFundsCount(), getFundsCount()])
    if (n.ok) setNavCount(n.data)
    if (f.ok) setFundCount(f.data)
  }, [])

  useEffect(() => {
    loadCounts()
    const h = (e) => setProg(e?.detail || getNavPoolProgress())
    window.addEventListener('fundapp:nav-pool', h)
    // 进入页面时若已在跑（二级页切走又回来），同步一次当前进度
    setProg(getNavPoolProgress())
    return () => window.removeEventListener('fundapp:nav-pool', h)
  }, [loadCounts])

  // 抓取结束 → 刷新计数
  useEffect(() => { if (!prog.running) loadCounts() }, [prog.running, loadCounts])

  const start = async (limit, background = false) => {
    if (prog.running) return
    const r = await refreshNavPool(limit, { background })
    if (!r.ok) {
      notify(r.error === 'already_running' ? '正在抓取中，请稍候' : `抓取失败：${r.error}`, 'error')
      return
    }
    const d = r.data
    notify(
      `本轮抓取完成：成功 ${d.ok} 只${d.fail ? `，失败 ${d.fail} 只` : ''}${d.stopped ? '（已停止）' : ''}`,
      d.fail ? 'warning' : 'success',
    )
    loadCounts()
  }

  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0
  const remain = fundCount != null && navCount != null ? Math.max(0, fundCount - navCount) : null

  return (
    <Card className="wide" title="补全基金净值">
      <div className="muted cell-note" style={{ lineHeight: 1.7, marginBottom: 10 }}>
        「低估+上涨」筛选要算 <b>历史位置、最大跌幅、波动大小</b>，依赖每只基金的<b>净值历史</b>。
        本机现有净值：<b>{navCount == null ? '—' : `${navCount} 只`}</b>
        {remain != null ? `（待补 ${remain} 只）` : ''}。
        已抓过的自动跳过，建议在无线网络下进行。
      </div>

      {prog.running ? (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
            <span>正在抓取 {prog.current || '…'}</span>
            <span>{prog.done} / {prog.total}（{pct}%）</span>
          </div>
          <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', marginBottom: 10 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .3s' }} />
          </div>
          <button className="btn-secondary btn-block" style={{ width: '100%' }} onClick={stopNavPool}>停止</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => start(300)}>快速补 300 只</button>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => start(1000)}>补 1000 只</button>
          </div>
          <button className="btn-primary btn-block" style={{ width: '100%', marginTop: 8 }} onClick={() => start(3000, true)}>
            后台补 3000 只（可切后台 / 锁屏继续）
          </button>
          <div className="muted cell-note" style={{ marginTop: 8, lineHeight: 1.7 }}>
            前两个按钮请让 App 停留前台；<b>后台模式</b>会在通知栏显示一条常驻通知（保活），
            期间可切到别的 App 甚至锁屏，抓完通知自动消失。停止后下次从断点继续，不会重复抓。
          </div>
        </>
      )}
    </Card>
  )
}

function DataHealthCard() {
  const [h, setH] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetchDataHealth()
      if (!r.ok) console.warn('[health] 数据健康读取失败:', r.error)
      setH(r.ok ? r.data : null)
    } catch (e) {
      console.warn('[health] 异常:', (e && e.message) || e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // initDataLayer 约 28s 才把真库打开，固定 5s 必然拿到 null →
    // ① **挂载立刻加载一次**（页面晚打开时也能拿到）② 多档重试 ③ 监听调度器广播。
    // 只靠定时器会漏：若页面在事件之后才挂载，就永远收不到通知了。
    load()
    const timers = [3000, 10000, 25000].map(ms => setTimeout(load, ms))
    const hasWin = typeof window !== 'undefined'
    if (hasWin) window.addEventListener('fundapp:cycle-done', load)
    return () => {
      timers.forEach(clearTimeout)
      if (hasWin) window.removeEventListener('fundapp:cycle-done', load)
    }
  }, [load])

  const tables = (h && h.tables) || []
  const errors = (h && h.errors) || []

  return (
    <Card className="wide" title="数据健康">
      <div className="muted cell-note" style={{ marginBottom: 8 }}>
        本机已存的数据量（净值、资讯、情报等），以及最近的抓取情况。
      </div>
      <div className="health-grid">
        {!tables.length ? (
          <div className="muted cell-note">{loading ? '读取中…' : '暂无'}</div>
        ) : (
          tables.map(t => (
            <div key={t.table} className="health-cell">
              <span className="health-name">{HEALTH_LABEL[t.table] || t.table}</span>
              <span className={`health-val ${t.rows < 0 ? 'bad' : t.rows > 0 ? 'ok' : 'zero'}`}>
                {t.rows < 0 ? '—' : Number(t.rows).toLocaleString('zh-CN')}
              </span>
            </div>
          ))
        )}
      </div>

      {errors.length > 0 && (
        <div className="sub-card" style={{ marginTop: 10 }}>
          <div className="subhead">
            最近抓取问题
            <span className="muted cell-note">（内部诊断，不影响使用）</span>
            <button
              type="button"
              className="link-btn"
              style={{ marginLeft: 'auto' }}
              onClick={load}
              disabled={loading}
            >
              {loading ? '刷新中…' : '刷新'}
            </button>
          </div>
          <ul className="intel-list">
            {errors.slice(-6).reverse().map((e, i) => (
              <li key={i} className="intel-item">
                <div className="intel-body">
                  <div className="intel-title" style={{ fontSize: 12 }}>
                    {humanizeFetchError(e && e.message ? e.message : e)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

// ─── 参数设置（纪律线人话参数，只提醒不拦截）──────────────
const SET_GROUPS = [
  {
    title: '纪律提醒（只是提醒，不会替你操作）',
    items: [
      { key: 'discipline_profit_take', label: '浮盈到 X% 提醒我兑现', hint: '默认 20。只提醒，减不减你定' },
      { key: 'discipline_drawdown_cut', label: '从高点回落 X% 提醒我减仓', hint: '默认 15。只提醒，减不减你定' },
      { key: 'discipline_stop_loss', label: '亏损 X% 提醒我认错离场', hint: '默认 -5（负数）。只提醒，走不走你定' },
      { key: 'discipline_lookback', label: '「近期高点」回看多少天', hint: '默认 60 天' },
    ],
  },
  {
    title: '集中与账户提醒（只是提醒，不会替你操作）',
    items: [
      { key: 'pos_max_single_pct', label: '单只超过总资产 X% 时提醒集中', hint: '默认 25。想全押一只也可以，应用不拦' },
      { key: 'risk_account_stop_pct', label: '账户整体从高点跌 X% 弹提醒', hint: '默认 20。只提醒，要不要减仓你自己定' },
    ],
  },
  {
    title: '运行方式',
    items: [
      {
        key: 'mode', label: '决策模式', type: 'select',
        options: [['auto', '自动（推荐）'], ['rule', '只用本机规则'], ['external', '只听外部智能助手']],
        hint: '「自动」= 智能助手在线就听它、不在线就本机规则兜底；「只听外部智能助手」在它掉线时会漏掉该扣的款',
      },
      { key: 'heartbeat_timeout_hours', label: '多久没回应算智能助手离线（小时）', hint: '超过这个时长没收到智能助手消息，就自动交给本机规则，避免漏掉该扣的款' },
    ],
  },
  {
    title: '自动交易限额',
    items: [
      { key: 'max_amount_per_order', label: '单笔金额上限（元）', hint: '只约束自动下单；你手动下单不受此限' },
      { key: 'max_orders_per_day', label: '单日下单次数上限', hint: '防止失控连环下单' },
    ],
  },
  {
    title: '费率',
    items: [
      { key: 'purchase_discount', label: '申购费折扣', hint: '0.125 表示 1.25 折；基金公司给的费率已含折扣，这里只是记录' },
    ],
  },
]

function SettingsCard() {
  const notify = useStore((s) => s.notify)
  const [items, setItems] = useState(null)
  const [form, setForm] = useState({})
  const [busy, setBusy] = useState(false)
  const [savedCount, setSavedCount] = useState(null)
  const [resetConfirm, setResetConfirm] = useState(false)

  const load = useCallback(async () => {
    const r = await jsSettingsGet()
    if (r.ok) { setItems(r.data); setForm(f => (Object.keys(f).length ? f : r.data)) }
  }, [])
  useEffect(() => {
    load()
    const timers = [4000, 15000, 30000].map(ms => setTimeout(load, ms))
    const hasWin = typeof window !== 'undefined'
    if (hasWin) window.addEventListener('fundapp:cycle-done', load)
    return () => { timers.forEach(clearTimeout); if (hasWin) window.removeEventListener('fundapp:cycle-done', load) }
  }, [load])

  const setField = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const save = async () => {
    setBusy(true)
    try {
      const payload = {}
      for (const g of SET_GROUPS) for (const f of g.items) {
        const raw = form[f.key]
        if (raw === undefined || raw === '') continue
        payload[f.key] = f.type === 'select' ? String(raw) : Number(raw)
      }
      const r = await jsSettingsSet(payload)
      if (!r.ok) { notify(`保存失败：${r.error}`, 'error'); return }
      setItems({ ...(items || {}), ...payload })
      setSavedCount(Object.keys(payload).length)
      notify('设置已保存，立即生效', 'success')
    } finally { setBusy(false) }
  }

  // 12 可逆性：一键恢复默认值（改坏了能一键复原，不只有「改」没有「退」）
  const doResetParams = async () => {
    setResetConfirm(false)
    setBusy(true)
    try {
      const payload = {}
      for (const g of SET_GROUPS) for (const f of g.items) {
        if (f.type === 'select') continue
        if (SETTINGS_DEFAULTS[f.key] !== undefined) payload[f.key] = SETTINGS_DEFAULTS[f.key]
      }
      const r = await jsSettingsSet(payload)
      if (!r.ok) { notify(`恢复默认失败：${r.error}`, 'error'); return }
      setItems({ ...(items || {}), ...payload })
      setForm(f => ({ ...f, ...payload }))
      setSavedCount(null)
      notify('已恢复默认参数，立即生效', 'success')
    } finally { setBusy(false) }
  }

  return (
    <Card className="wide" title="参数设置">
      <div className="muted cell-note" style={{ marginBottom: 12, lineHeight: 1.7 }}>
        改动保存后<b>立即生效</b>，不需要重启。
      </div>
      {!items ? (
        <div className="muted cell-note">读取中…</div>
      ) : (
        <>
          {SET_GROUPS.map(g => (
            <div className="set-group" key={g.title}>
              <div className="set-group-title">{g.title}</div>
              <div className="set-grid">
                {g.items.map(f => (
                  <div className="field" key={f.key}>
                    <label>{f.label}</label>
                    {f.type === 'select' ? (
                      <select value={form[f.key] ?? ''} onChange={setField(f.key)}>
                        {f.options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                      </select>
                    ) : (
                      <input type="number" step="any" value={form[f.key] ?? ''} onChange={setField(f.key)} onBlur={setField(f.key)} />
                    )}
                    {f.hint && <div className="set-hint">{f.hint}</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="set-actions">
            <button className="btn-primary" style={{ flex: 1 }} disabled={busy} onClick={save}>
              {busy ? '保存中…' : '保存设置'}
            </button>
            <button className="btn" disabled={busy} onClick={() => setResetConfirm(true)}>恢复默认</button>
          </div>
          {savedCount != null && (
            <div className="muted cell-note" style={{ marginTop: 6 }}>已保存 {savedCount} 项设置</div>
          )}
          <ConfirmDialog
            open={resetConfirm}
            danger
            title="恢复默认"
            message="所有纪律参数将恢复为默认值，确认？"
            confirmText="恢复默认"
            onConfirm={doResetParams}
            onClose={() => setResetConfirm(false)}
          />
        </>
      )}
    </Card>
  )
}

// ─── 运行模式 / 紧急暂停 ─────────────────────────────────────────
function EmergencyStopCard() {
  const notify = useStore((s) => s.notify)
  const [on, setOn] = useState(null)
  const [mode, setMode] = useState('auto')
  const [snapDate, setSnapDate] = useState(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [e, s, c] = await Promise.all([jsEmergencyStopGet(), jsSettingsGet(), fetchPortfolioCurve(9999)])
    if (e.ok) setOn(!!e.data)
    if (s.ok) setMode(s.data.mode || 'auto')
    if (c.ok && c.data?.length) setSnapDate(c.data[c.data.length - 1].snap_date)
  }, [])
  useEffect(() => {
    load()
    const timers = [4000, 15000, 30000].map(ms => setTimeout(load, ms))
    const hasWin = typeof window !== 'undefined'
    if (hasWin) window.addEventListener('fundapp:cycle-done', load)
    return () => { timers.forEach(clearTimeout); if (hasWin) window.removeEventListener('fundapp:cycle-done', load) }
  }, [load])

  const toggle = async () => {
    setBusy(true)
    try {
      const r = await jsEmergencyStopSet(!on)
      if (!r.ok) { notify(`操作失败：${r.error}`, 'error'); return }
      setOn(!on)
      notify(!on ? '已紧急暂停所有自动交易' : '已恢复自动交易', !on ? 'error' : 'success')
    } finally { setBusy(false) }
  }

  const snapshot = async () => {
    setBusy(true)
    try {
      const r = await recordPortfolioSnapshot()
      if (!r.ok) { notify(`记录失败：${r.error}`, 'error'); return }
      setSnapDate(r.data.date)
      notify('已记录组合快照', 'success')
    } finally { setBusy(false) }
  }

  const modeLabel = mode === 'auto' ? '自动（本机规则兜底）'
    : mode === 'rule' ? '只用本机规则' : '只听外部智能助手'

  return (
    <Card className="wide estop-card" title="运行模式">
      <div className="overview-grid" style={{ marginBottom: 12 }}>
        <div className="overview-tile">
          <div className="overview-tile-label">实际生效</div>
          <div className="overview-tile-value" style={{ fontSize: 13 }}>{modeLabel}</div>
        </div>
        <div className="overview-tile">
          <div className="overview-tile-label">智能助手在线</div>
          <div className="overview-tile-value" style={{ fontSize: 13 }}>否（未接入）</div>
        </div>
        <div className="overview-tile">
          <div className="overview-tile-label">上次活跃</div>
          <div className="overview-tile-value" style={{ fontSize: 13 }}>—</div>
        </div>
        <div className="overview-tile">
          <div className="overview-tile-label">数据日期</div>
          <div className="overview-tile-value" style={{ fontSize: 13 }}>{snapDate || '—'}</div>
        </div>
      </div>
      <div className="estop-row">
        <div>
          <div className={`estop-state ${on ? 'on' : 'off'}`}>
            {on === null ? '读取中…' : on ? '已紧急停止' : '运行中'}
          </div>
          <div className="muted cell-note" style={{ marginTop: 4 }}>
            {on ? '定投与自动交易已全部暂停；已持仓不受影响。' : '定投与本机规则的自动交易正常运行。'}
          </div>
        </div>
        <button
          className={`btn ${on ? 'btn-primary' : 'btn-danger'}`}
          disabled={busy || on === null}
          onClick={() => setConfirm(true)}
        >
          {on ? '恢复自动交易' : '紧急暂停'}
        </button>
      </div>
      <div className="set-actions">
        <button className="btn" disabled={busy} onClick={snapshot}>记录组合快照</button>
      </div>
      <ConfirmDialog
        open={confirm}
        danger={!on}
        title={on ? '恢复自动交易' : '紧急暂停所有自动交易'}
        message={on
          ? '将恢复定投与本机规则的自动交易。'
          : '将立即暂停全部自动交易（定投 / 本机规则自动减仓）。已持仓不受影响，但不再自动操作。'}
        confirmText={on ? '恢复' : '确认暂停'}
        onConfirm={toggle}
        onClose={() => setConfirm(false)}
      />
    </Card>
  )
}

// ─── AI 配置（密钥不硬编码，只存本地配置）────────────────────────
function AiConfigCard() {
  const notify = useStore((s) => s.notify)
  const [cfg, setCfg] = useState(null)
  const [form, setForm] = useState({})
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([jsLlmGetConfig(), jsLlmStatus()])
    if (c.ok) {
      setCfg(c.data)
      setForm(f => Object.keys(f).length ? f : {
        base_url: c.data.base_url, model: c.data.model,
        api_key: c.data.api_key, system_prompt: c.data.system_prompt,
      })
    }
    if (s.ok) setStatus(s.data)
  }, [])
  useEffect(() => {
    load()
    const timers = [4000, 15000, 30000].map(ms => setTimeout(load, ms))
    return () => timers.forEach(clearTimeout)
  }, [load])

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const save = async () => {
    setBusy(true)
    try {
      const r = await jsSettingsSet({
        llm_base_url: form.base_url || '',
        llm_model: form.model || '',
        llm_api_key: form.api_key || '',
        llm_system_prompt: form.system_prompt || '',
      })
      if (!r.ok) { notify(`保存失败：${r.error}`, 'error'); return }
      notify('智能助手配置已保存', 'success')
      await load()
    } finally { setBusy(false) }
  }

  return (
    <Card className="wide" title="智能助手配置">
      <div className="muted cell-note" style={{ marginBottom: 10, lineHeight: 1.7 }}>
        密钥只存在本机，<b>不硬编码、不上传</b>；对话内容<b>只发到你填的这家模型服务，开发者不收集</b>。
        没填密钥：智能助手只出本地纪律提醒与兜底分析，建议按钮不出。
        你填什么策略，智能助手就按什么检查；不填 = 通用检查。
        {status ? `　当前：${status.configured ? '已配置' : '未配置'}｜模型 ${status.model || '—'}` : ''}
      </div>
      {!cfg ? (
        <div className="muted cell-note">读取中…</div>
      ) : (
        <>
          <div className="set-grid">
            <div className="field">
              <label>接口地址</label>
              <input value={form.base_url ?? ''} onChange={set('base_url')} placeholder="https://…/v4" />
            </div>
            <div className="field">
              <label>模型</label>
              <input value={form.model ?? ''} onChange={set('model')} placeholder="glm-4-flash" />
            </div>
            <div className="field">
              <label>接口密钥</label>
              <input type="password" value={form.api_key ?? ''} onChange={set('api_key')} placeholder="仅存本机" />
            </div>
            <div className="field">
              <label>系统提示词（可选）</label>
              <input value={form.system_prompt ?? ''} onChange={set('system_prompt')} placeholder="可留空" />
            </div>
          </div>
          <div className="set-actions">
            <button className="btn-primary" style={{ flex: 1 }} disabled={busy} onClick={save}>
              {busy ? '保存中…' : '保存智能助手配置'}
            </button>
          </div>
        </>
      )}
    </Card>
  )
}

// ─── 决策简报 ────────────────────────────────────────────────────
function BriefingCard() {
  const notify = useStore((s) => s.notify)
  const [md, setMd] = useState('')
  const [busy, setBusy] = useState(false)
  const gen = async () => {
    setBusy(true)
    try {
      const r = await jsGenerateBriefing()
      if (!r.ok) { notify(`生成失败：${r.error}`, 'error'); return }
      const m = jsBriefingMarkdown(r.data)
      setMd(m.ok ? m.data : '(渲染失败)')
    } finally { setBusy(false) }
  }
  return (
    <Card
      className="wide"
      title="决策简报"
      action={<button className="btn-tiny" disabled={busy} onClick={gen}>{busy ? '生成中…' : '生成简报'}</button>}
    >
      <div className="muted cell-note" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        把持仓 / 纪律线 / 资金 / 风控边界整理成一份材料（14:30 钩子），人一开对话即可让 AI 作答。不含模拟数据。
      </div>
      {md ? <pre className="briefing-md">{md}</pre> : <div className="muted cell-note">点右上角「生成简报」。</div>}
    </Card>
  )
}

// 导出诊断（07-①：从主界面收进「数据」合并卡下方，开发者模式下才显示）
function DiagCard() {
  const [diag, setDiag] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function runDiag() {
    setBusy(true)
    setErr(null)
    const r = await exportDiagnostics(5)
    setBusy(false)
    if (!r.ok) {
      setErr(r.error)
      return
    }
    setDiag(r?.data ?? null)
  }

  return (
    <Card className="wide" title="导出诊断">
      <p style={{ color: 'var(--text-soft)', fontSize: 13, margin: '4px 0 12px' }}>
        导出本机运行诊断（遇到问题时提供给开发者排查）
      </p>
      <button
        onClick={runDiag}
        disabled={busy}
        style={{
          padding: '8px 14px', borderRadius: 6, border: '1px solid var(--accent)',
          background: busy ? 'var(--border-strong)' : 'var(--accent)', color: 'var(--on-accent)', cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? '查询中...' : '导出诊断'}
      </button>
      {err && <div style={{ color: 'var(--danger)', marginTop: 8 }}>错误：{err}</div>}
      {diag && (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <div style={{ fontWeight: 'bold', marginBottom: 6 }}>
            时间：{diag.timestamp}
          </div>
          <div style={{ marginBottom: 10 }}>
            数据：{Object.entries(diag.stats).map(([t, n]) => `${t}=${n}`).join(' · ')}
          </div>

          {diag.lastInit && (
            <details style={{ marginBottom: 8 }} open>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--accent)' }}>
                最近 init 结果（name={diag.lastInit.nameCount}, purchase={diag.lastInit.purchaseCount}, nav={diag.lastInit.navCount}, 用时={diag.lastInit.durationMs}ms）
              </summary>
              <div style={{ background: 'var(--accent-soft)', padding: 8, borderRadius: 4, fontSize: 11, marginTop: 4, lineHeight: 1.6 }}>
                {diag.lastInit.errors?.length > 0 ? (
                  diag.lastInit.errors.map((e, i) => (
                    <div key={i} style={{ color: 'var(--danger)' }}>· {humanizeFetchError(e)}</div>
                  ))
                ) : (
                  <div style={{ color: 'var(--down)' }}>✓ 无错误</div>
                )}
              </div>
            </details>
          )}

          {diag.poolProgress?.length > 0 && (
            <details style={{ marginBottom: 8 }} open>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--accent)' }}>
                候选池进度日志（{diag.poolProgress.length} 条）
              </summary>
              <pre style={{
                background: 'var(--accent-soft)', padding: 8, borderRadius: 4, fontSize: 11,
                overflow: 'auto', maxHeight: 200, marginTop: 4, lineHeight: 1.6,
              }}>
                {diag.poolProgress.map((e, i) => (
                  <div key={i}>
                    <span style={{ color: 'var(--text-mute)' }}>[{e.ts.slice(11, 19)}]</span>{' '}
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{e.phase}</span>{' '}
                    {e.msg}
                  </div>
                ))}
              </pre>
            </details>
          )}

          {diag.navProgress?.length > 0 && (
            <details style={{ marginBottom: 8 }} open>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--accent)' }}>
                净值抓取进度日志（{diag.navProgress.length} 条）
              </summary>
              <pre style={{
                background: 'var(--accent-soft)', padding: 8, borderRadius: 4, fontSize: 11,
                overflow: 'auto', maxHeight: 200, marginTop: 4, lineHeight: 1.6,
              }}>
                {diag.navProgress.map((e, i) => (
                  <div key={i}>
                    <span style={{ color: 'var(--text-mute)' }}>[{e.ts.slice(11, 19)}]</span>{' '}
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{e.phase}</span>{' '}
                    {e.msg}
                  </div>
                ))}
              </pre>
            </details>
          )}

          {diag.recentErrors?.length > 0 && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--danger)' }}>
                最近错误记录（{diag.recentErrors.length} 条）
              </summary>
              <pre style={{
                background: 'var(--danger-soft)', padding: 8, borderRadius: 4, fontSize: 11,
                overflow: 'auto', maxHeight: 260, marginTop: 4, lineHeight: 1.6,
              }}>
                {diag.recentErrors.map((e, i) => (
                  <div key={i} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 4, marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-mute)' }}>[{e.ts.slice(11, 19)}]</span>{' '}
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{e.module}</span>{' '}
                    {e.message}
                  </div>
                ))}
              </pre>
            </details>
          )}

          {Object.entries(diag.sample).filter(([, rows]) => rows.length > 0).map(([t, rows]) => (
            <details key={t} style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                {t}（{rows.length} 行示例）
              </summary>
              <pre style={{
                background: 'var(--surface-soft)', padding: 8, borderRadius: 4, fontSize: 11,
                overflow: 'auto', maxHeight: 200, marginTop: 4,
              }}>
                {JSON.stringify(rows, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </Card>
  )
}

// 数据合并卡（07-①）：上=数据健康（本机存了多少），下=数据维护操作；开发者模式追加导出诊断
function DataCenterBody({ devMode }) {
  return (
    <>
      <DataHealthCard />
      <MarketRefreshCard />
      <NavPoolCard />
      {devMode && <DiagCard />}
    </>
  )
}

// AI 合并卡（07-②）：上=AI 配置，下=决策简报（简报的前提是配了密钥，挨着放）
function AiCenterBody() {
  return (
    <>
      <AiConfigCard />
      <BriefingCard />
    </>
  )
}

export default function More() {
  const [devMode, setDevMode] = useState(false)
  const [mine, setMine] = useState({ realPos: null, tradePos: null, funds: null, llm: null })
  const nav = useNav()
  // 下拉刷新：换 key 重挂页面内容 → 各卡片（概览 / 基金池 / 数据健康…）重新加载
  const [pullTick, setPullTick] = useState(0)
  useEffect(() => registerPullRefresh(() => setPullTick((t) => t + 1)), [])

  // 「我的」概览：持仓只数 / 本地基金数 / AI 是否在线（抓不到就留空，不显示假数据）
  // 结构隔离：`fetchPositions()` 按 (基金 + 来源) 成条（真实 + 虚拟都返回），
  //   此处**分来源分别计数**，避免"真实持仓 2 只"这类把虚拟盘算进来的口径错误。
  useEffect(() => {
    let alive = true
    Promise.all([fetchPositions(), getFundsCount(), jsLlmStatus()])
      .then(([p, f, l]) => {
        if (!alive) return
        const all = Array.isArray(p?.data) ? p.data : null
        setMine({
          realPos: all ? all.filter(x => x.source === 'real').length : null,
          tradePos: all ? all.filter(x => x.source === 'trade').length : null,
          funds: f?.ok ? Number(f.data) : null,
          // 概览卡 AI 状态要与详情页口径一致——同判「有 api_key 才算在线」。
          //   详情页用 status.configured（= 有 key），此处若存整条 PoolStatus 对象会恒 truthy → 没 key 也显示"在线"。
          //   故只存 .configured 布尔：有 key = true / 没 key 或取状态失败 = null（下方按 truthy 判"在线"）。
          llm: l?.ok ? !!(l.data && l.data.configured) : null,
        })
      })
      .catch(() => { /* 读不到就留空 */ })
    return () => { alive = false }
  }, [])

  // 开发者模式（默认关）。
  // 调试信息收进隐藏页，默认不显示；
  // 技术细节（表名 / 原始错误 / 抓取日志 / init 耗时）不进普通用户视野。
  useEffect(() => {
    jsSettingsGet()
      .then(r => { if (r.ok) setDevMode(String(r.data?.developer_mode || '') === '1') })
      .catch(() => { /* 读不到就按关 */ })
  }, [])

  const toggleDevMode = useCallback(async () => {
    const next = !devMode
    setDevMode(next)
    try { await jsSettingsSet({ developer_mode: next ? '1' : '0' }) } catch { /* ignore */ }
  }, [devMode])

  return (
    /* hold-root：与持仓/交易页一致的「全宽贴边、无左右边框」根容器（.stack 的 16px 内边距会让整页两边留边框） */
    <div className="hold-root" key={pullTick}>
      {/* 我的概览：持仓 / 本地基金 / AI 状态（真实数据，读不到留空） */}
      <div className="hold-block" style={{ marginTop: 8 }}>
        <div className="hold-block-title">我的概览</div>
        <div className="hold-row" style={{ cursor: 'default' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hold-row-name">持仓</div>
            <div className="hold-row-sub">真实（截图识别导入） / 虚拟盘（练手）</div>
          </div>
          <div className="hold-row-pct">
            {mine.realPos == null ? '—' : `${mine.realPos} / ${mine.tradePos} 只`}
          </div>
        </div>
        <div className="hold-row" style={{ cursor: 'default' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hold-row-name">本地基金库</div>
            <div className="hold-row-sub">已存到本机的基金数量</div>
          </div>
          <div className="hold-row-pct">{mine.funds == null ? '—' : `${mine.funds} 只`}</div>
        </div>
        <div className="hold-row" style={{ cursor: 'default' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="hold-row-name">智能助手</div>
            <div className="hold-row-sub">{mine.llm ? '已配置，可对话' : '未配置密钥，走本地兜底'}</div>
          </div>
          <div className="hold-row-pct" style={{ fontSize: 13, color: mine.llm ? 'var(--up)' : 'var(--text-mute)' }}>
            {mine.llm ? '在线' : '未配置'}
          </div>
        </div>
      </div>

      <ListGroup title="常用">
        <ListItem
          title="运行模式" sub="实际生效模式 / 智能助手是否在线"
          onClick={() => nav.push('page', { title: '运行模式', body: () => <EmergencyStopCard /> })}
        />
        <ListItem
          title="定投计划" sub="固定金额、固定节奏买入"
          onClick={() => nav.push('page', { title: '定投计划', body: () => <DingtouCard /> })}
        />
        <ListItem
          title="目标规划" sub="退休 / 教育 / 目标投：算缺口与每月需投"
          onClick={() => nav.push('page', { title: '目标规划', body: () => <GoalPanel /> })}
        />
      </ListGroup>

      <ListGroup title="资金与风控">
        <ListItem
          title="参数设置" sub="纪律提醒 / 运行方式 / 费率"
          onClick={() => nav.push('page', { title: '参数设置', body: () => <SettingsCard /> })}
        />
      </ListGroup>

      <ListGroup title="智能">
        <ListItem
          title="智能助手" sub="配置密钥 / 生成决策简报"
          onClick={() => nav.push('page', { title: '智能助手', body: () => <AiCenterBody /> })}
        />
      </ListGroup>

      <ListGroup title="风险与预警">
        <ListItem
          title="组合风险分析" sub="集中度 / 行业分布（只算你的真实持仓）"
          onClick={() => nav.push('page', { title: '组合风险分析', body: () => <RiskPanel /> })}
        />
        <ListItem
          title="调仓提醒" sub="设目标比例，偏离太多就提醒调仓"
          onClick={() => nav.push('page', { title: '调仓提醒', body: () => <RebalancePanel /> })}
        />
        <ListItem
          title="涨跌 / 净值预警" sub="设涨跌幅、净值高低，达到就本地提醒"
          onClick={() => nav.push('page', { title: '预警提醒', body: () => <AlertsPanel /> })}
        />
      </ListGroup>

      <ListGroup title="数据">
        <ListItem
          title="数据健康与维护" sub="本机存了多少 / 补全基金池"
          onClick={() => nav.push('page', { title: '数据', body: () => <DataCenterBody devMode={devMode} /> })}
        />
        <ListItem
          title="数据备份与导入" sub="导出/恢复个人数据（合并模式，不删现有）"
          onClick={() => nav.push('page', { title: '数据备份与导入', body: () => <BackupPanel /> })}
        />
        <ListItem
          title="分红跟踪" sub="现金分红 / 分红再买入记录"
          onClick={() => nav.push('page', { title: '分红跟踪', body: () => <DividendTrack /> })}
        />
      </ListGroup>

      <ListGroup title="外观">
        <ListItem
          title="深色模式" sub="浅色 / 深色 / 跟随系统"
          onClick={() => nav.push('page', { title: '深色模式', body: () => <ThemePanel /> })}
        />
      </ListGroup>

      {/* 开发者模式开关（默认关） */}
      <Card className="wide" title="开发者模式">
        <div className="muted cell-note" style={{ marginBottom: 10, lineHeight: 1.7 }}>
          打开后会显示「数据健康」「导出诊断」等排查用信息（含数据表、抓取日志）。
          平时不用开，遇到问题按指引再打开。
        </div>
        <button
          className={devMode ? 'btn-primary' : 'btn-secondary'}
          style={{ width: '100%' }}
          onClick={toggleDevMode}
        >
          {devMode ? '已开启 · 点此关闭' : '开启开发者模式'}
        </button>
      </Card>

      <Card className="wide" title="关于">
        <EmptyState
          title="版本信息"
          hint="基金沙盒 v1.0.0 · 以账户为主轴的基金投资组合管理工具"
        />
      </Card>
    </div>
  )
}

/** 深色模式：浅色 / 深色 / 跟随系统（由 lib/theme.js 写 <html data-theme>） */
function ThemePanel() {
  const [mode, setMode] = useState(getStoredTheme())
  const pick = (m) => {
    setMode(m)
    storeTheme(m)
    applyTheme(m)
  }
  const options = [
    { key: 'system', label: '跟随系统', sub: '随手机的深色模式自动切换' },
    { key: 'light', label: '浅色', sub: '始终使用浅色界面' },
    { key: 'dark', label: '深色', sub: '始终使用深色界面' },
  ]
  return (
    <div className="hold-root">
      <div className="hold-block" style={{ marginTop: 8 }}>
        <div className="hold-block-title">外观</div>
        {options.map((o) => (
          <div key={o.key} className="hold-row" onClick={() => pick(o.key)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="hold-row-name">{o.label}</div>
              <div className="hold-row-sub">{o.sub}</div>
            </div>
            <div className="hold-row-pct">{mode === o.key ? '✓' : ''}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
