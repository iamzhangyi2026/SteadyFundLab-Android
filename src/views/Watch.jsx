/**
 * 自选观察页。
 * 自选条目可增删改，逐条标注来源（算法 / 人工）；查找走全市场搜索（lib/fundSearch.js）。
 * 数据源：lib/watchlist.js（localStorage，source 字段区分 algo / manual）
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchFund, latestNetWorth, dayChange, fmtNavDate } from '../lib/eastmoney.js'
import { seedFund } from '../lib/seed.js'
import { cachedToWorth } from '../lib/navCache.js'
import { searchFunds } from '../lib/fundSearch.js'
import RowSkeleton from '../components/RowSkeleton.jsx'
import { usePullRefresh } from '../lib/usePullRefresh.js'
import { loadWatch, addWatch, removeWatch, updateWatch, recomputeAlgo, needsAlgoCompute } from '../lib/watchlist.js'
import { QuickBuyForm, QuickDingtouForm } from '../components/QuickActions.jsx'

export default function Watch({ onOpen, onDiscover, onSimLedger }) {
  /* 自选列表（含 source：algo 算法添加 / manual 人工添加） */
  const [watch, setWatch] = useState(() => loadWatch())
  /* 首屏：先用本地已抓过的净值出数（真数据、随自选变化），没有再吃内置种子，后台再刷新 */
  const [state, setState] = useState(() => {
    const items = loadWatch()
      .map((w) => {
        const d = cachedToWorth(w.code) || seedFund(w.code)
        return d ? { ...w, d, error: null } : null
      })
      .filter(Boolean)
    return items.length ? { status: 'ok', items } : { status: 'loading', items: [] }
  })

  /* 下拉刷新（手势在 App 根，事件分发给当前页面）
     ⚠️ state 必须先声明再传给 usePullRefresh：回调里引用的绑定要在挂上之前
        初始化，否则依赖初始化顺序，属于 TDZ 隐患。 */
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  usePullRefresh(() => setRefreshTrigger((k) => k + 1))

  /* 行内展开状态：editing / buying / dingtou 各记一个 code */
  const [editingCode, setEditingCode] = useState(null)
  const [editTag, setEditTag] = useState('')
  const [buyingCode, setBuyingCode] = useState(null)
  const [dingtouCode, setDingtouCode] = useState(null)

  /* 算法自选：重算状态与错误 */
  const [algoBusy, setAlgoBusy] = useState(false)
  const [algoError, setAlgoError] = useState(false)
  const mountedRef = useRef(true)

  /* 添加自选 */
  const [adding, setAdding] = useState(false)
  const [newCode, setNewCode] = useState('')
  const [newTag, setNewTag] = useState('')
  const [addMsg, setAddMsg] = useState(null)
  const [addBusy, setAddBusy] = useState(false)

  /* 查找 = 全市场搜索：q 非空时进入搜索模式，结果替代自选列表显示 */
  const [query, setQuery] = useState('')
  const q = query.trim()
  const [search, setSearch] = useState({ status: 'idle', items: [], error: '' })
  /* 后到请求先回来的守卫：只认最新一次搜索的结果 */
  const searchSeq = useRef(0)
  /* 本次会话里从搜索结果加过的 code（切回列表前保持「已自选」态） */
  const [addedCodes, setAddedCodes] = useState(() => new Set())
  const inWatch = useMemo(() => new Set(watch.map((w) => w.code)), [watch])

  /* 输入防抖 350ms 后搜索；卸载或又输入了新词则丢弃旧结果 */
  const hadQuery = useRef(false)
  useEffect(() => {
    const key = q
    if (!key) {
      /* 搜索过再清空：刷新一次列表，让搜索里新加的自选立刻可见 */
      if (hadQuery.current) {
        hadQuery.current = false
        load()
      }
      searchSeq.current += 1
      setSearch({ status: 'idle', items: [], error: '' })
      return
    }
    hadQuery.current = true
    const seq = (searchSeq.current += 1)
    const timer = setTimeout(async () => {
      if (!mountedRef.current) return
      setSearch({ status: 'loading', items: [], error: '' })
      try {
        const items = await searchFunds(key, { limit: 10 })
        if (seq !== searchSeq.current || !mountedRef.current) return
        setSearch({ status: 'ok', items, error: '' })
      } catch (e) {
        if (seq !== searchSeq.current || !mountedRef.current) return
        setSearch({ status: 'error', items: [], error: e?.message || '搜索失败' })
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [q])

  /** 从搜索结果加入自选；本机存储失败要明确告知，不静默 */
  function addFromSearch(item) {
    const r = addWatch({ code: item.code, name: item.name, tag: '', source: 'manual' })
    if (r.ok || r.reason === 'exists') {
      setAddedCodes((prev) => new Set(prev).add(item.code))
      setWatch(loadWatch())
    } else {
      window.alert('添加失败：本机存储不可用')
    }
  }

  // 并发抓观察池：每只基金独立 fetchFund，成功带数据、失败带 error，互不影响
  async function fetchWatchItems(list) {
    return Promise.all(
      list.map(async (w) => {
        try {
          return { ...w, d: await fetchFund(w.code), error: null }
        } catch (e) {
          return { ...w, d: null, error: e.message }
        }
      }),
    )
  }

  async function load() {
    const list = loadWatch()
    setWatch(list)
    /* 已有数据（种子或上次抓取）时不闪骨架，直接静默替换 */
    setState((prev) => (prev.items.length ? prev : { status: 'loading', items: [] }))
    const items = await fetchWatchItems(list)
    // 抓数要几秒，期间用户可能已退出页面 —— 卸载后不再 setState
    if (!mountedRef.current) return
    setState({ status: 'ok', items })
  }

  useEffect(() => {
    let alive = true
    const list = loadWatch()
    setWatch(list)
    fetchWatchItems(list).then((items) => alive && setState({ status: 'ok', items }))
    return () => {
      alive = false
    }
  }, [refreshTrigger])

  /**
   * 跑算法重算自选：保留人工条目、整体替换算法条目。
   * 计算失败（离线）时返回 null，不破坏已有算法条目，并置 algoError。
   */
  async function refreshAlgo() {
    if (algoBusy) return
    setAlgoBusy(true)
    setAlgoError(false)
    const next = await recomputeAlgo()
    if (!mountedRef.current) return
    setAlgoBusy(false)
    if (next === null) {
      setAlgoError(true)
      load()
      return
    }
    setWatch(next)
    load()
  }

  // 首启无算法列表，或检测到旧版写死样本（无 score）：自动跑一次算法生成
  useEffect(() => {
    mountedRef.current = true
    if (needsAlgoCompute(loadWatch())) refreshAlgo()
    return () => {
      mountedRef.current = false
    }
  }, [])

  const summary = useMemo(() => {
    const valid = state.items.filter((item) => item.d)
    const up = valid.filter((item) => (dayChange(item.d.netWorth) ?? 0) > 0).length
    const down = valid.filter((item) => (dayChange(item.d.netWorth) ?? 0) < 0).length
    return { valid: valid.length, up, down }
  }, [state.items])

  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date())

  /* 添加：先抓名称，抓不到也允许只存代码 */
  async function submitAdd() {
    const code = newCode.trim()
    if (!/^\d{6}$/.test(code)) {
      setAddMsg({ ok: false, text: '请输入 6 位基金代码' })
      return
    }
    setAddBusy(true)
    setAddMsg(null)
    let name = ''
    try {
      const d = await fetchFund(code)
      name = d?.name || ''
    } catch {
      // 抓不到名称不阻塞：代码先入库，列表刷新时会再取
    }
    const r = addWatch({ code, name, tag: newTag.trim(), source: 'manual' })
    setAddBusy(false)
    if (r.ok) {
      setAddMsg({ ok: true, text: `已加入自选：${name || code}` })
      setNewCode('')
      setNewTag('')
      load()
    } else if (r.reason === 'exists') {
      setAddMsg({ ok: false, text: '这只基金已经在自选里了' })
    } else {
      setAddMsg({ ok: false, text: '添加失败：本机存储不可用' })
    }
  }

  function del(code, name) {
    if (!window.confirm(`把「${name || code}」从自选移除？\n只删观察列表，不影响持仓。`)) return
    removeWatch(code)
    if (editingCode === code) setEditingCode(null)
    if (buyingCode === code) setBuyingCode(null)
    if (dingtouCode === code) setDingtouCode(null)
    load()
  }

  function startEdit(w) {
    setEditingCode(w.code)
    setEditTag(w.tag || '')
    setBuyingCode(null)
    setDingtouCode(null)
  }

  function saveEdit(code) {
    updateWatch(code, { tag: editTag.trim() })
    setEditingCode(null)
    load()
  }

  return (
    <div className="watch-page">
      <section className="watch-welcome">
        <div className="watch-eyebrow"><span className="live-dot" /> 自选 <span>·</span> {date}</div>
        <h1>把每一次观察，<br /><em>变成有据可依。</em></h1>
        <p>净值、费率与持仓线索，一屏看清。</p>
      </section>

      <section className="market-card" aria-label="自选行情摘要">
        <div className="market-topline">
          <div><div className="market-kicker">自选行情</div><div className="market-title">今日观察</div></div>
          <span className={`market-status ${state.status === 'loading' ? 'is-loading' : ''}`}>
            <i />{state.status === 'loading' ? '正在更新' : summary.valid ? `已获取 ${summary.valid}/${watch.length} 只` : '数据暂不可用'}
          </span>
        </div>
        <div className="market-bottomline">
          <div className="market-count"><strong>{state.status === 'loading' ? '—' : summary.valid}</strong><span>只基金已获取净值</span></div>
          <div className="market-mood">
            <span className="mood-up">↑ {state.status === 'loading' ? '—' : summary.up}</span>
            <span className="mood-down">↓ {state.status === 'loading' ? '—' : summary.down}</span>
          </div>
        </div>
        <div className="market-foot"><span className="market-foot-mark">i</span>按基金公布净值展示；投资海外的基金公布时间可能晚一两天</div>
      </section>

      <div className="watch-section-head">
        <div>
          
          <h2>{q ? '搜索结果' : '关注列表'}</h2>
        </div>
        <div className="watch-head-actions">
          <button className="text-action" onClick={() => { setAdding((v) => !v); setAddMsg(null) }}>
            {adding ? '收起' : '＋ 添加'}
          </button>
          <button className="text-action" onClick={refreshAlgo} disabled={algoBusy}>{algoBusy ? '算法重算中…' : '↻ 重算'}</button>
        </div>
      </div>

      {adding ? (
        <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
          <div className="field-row">
            <label className="field">
              <span>基金代码（6 位）</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.replace(/\D/g, ''))}
                placeholder="如 040001"
              />
            </label>
            <label className="field">
              <span>标签（可空，如「红利」）</span>
              <input
                type="text"
                maxLength={8}
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="自定"
              />
            </label>
          </div>
          <button className="btn btn-primary btn-block" disabled={addBusy} onClick={submitAdd}>
            {addBusy ? '正在获取基金信息…' : '加入自选'}
          </button>
          {addMsg ? (
            <div className={'callout ' + (addMsg.ok ? 'teal' : 'danger')} style={{ marginTop: 8 }}>
              {addMsg.text}
            </div>
          ) : null}
          <p className="card-note" style={{ marginTop: 8 }}>
            手动添加的标「人工」、可随意增删；「算法」列表由全市场三轨筛选动态生成（点「重算」刷新），自动维护、不写死。
          </p>
        </div>
      ) : null}

      <div className="watch-find">
        <span className="watch-find-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜全市场基金：名称 / 代码"
          aria-label="搜索全市场基金"
        />
        {q ? (
          <>
            {search.status === 'ok' ? <span className="watch-find-count">{search.items.length} 只</span> : null}
            <button type="button" className="watch-find-clear" onClick={() => setQuery('')}>清空</button>
          </>
        ) : null}
      </div>

      {q ? (
        <section className="watch-list-card" aria-label="全市场搜索结果">
          {search.status === 'loading' ? (
            <div className="search-hint">正在全市场搜索「{q}」…</div>
          ) : search.status === 'error' ? (
            <div className="search-hint is-error">搜索失败：{search.error}。请检查网络后重试</div>
          ) : search.items.length === 0 ? (
            <div className="search-hint">全市场没找到「{q}」相关的基金，换个关键词试试</div>
          ) : (
            search.items.map((it) => {
              const added = inWatch.has(it.code) || addedCodes.has(it.code)
              return (
                <div className="watch-search-row" key={it.code}>
                  <div className="watch-search-main">
                    <strong>{it.name}</strong>
                    <small>
                      <span className="fund-code">{it.code}</span><i />{it.type}
                      {it.nav ? <><i />净值 {it.nav.toFixed(4)}{it.navDate ? `（${it.navDate}）` : ''}</> : null}
                    </small>
                  </div>
                  <button
                    type="button"
                    className={'btn btn-sm ' + (added ? 'is-added' : 'btn-primary')}
                    disabled={added}
                    onClick={() => addFromSearch(it)}
                  >
                    {added ? '已自选' : '＋ 自选'}
                  </button>
                </div>
              )
            })
          )}
        </section>
      ) : (
        <section className="watch-list-card">
        {state.status === 'loading' ? (
          watch.length === 0 ? (
            <div className="empty">
              <div className="empty-title">{algoBusy ? '算法分析全市场中…' : algoError ? '算法分析暂不可用' : '正在加载'}</div>
              <div className="empty-note">
                {algoBusy
                  ? '按「近1年>0、位置<50%、下跌<50%」三轨筛选，达标的基金会自动列出'
                  : algoError
                    ? '请检查网络后点右上角「重算」重试'
                    : '请稍候'}
              </div>
            </div>
          ) : (
            watch.map((w) => <RowSkeleton key={w.code} />)
          )
        ) : state.items.length === 0 ? (
          <div className="empty">
            <div className="empty-title">自选是空的</div>
            <div className="empty-note">点上方搜索框搜全市场基金，或点右上角「＋ 添加」输入代码</div>
          </div>
        ) : (
          state.items.map((item) => (
            <WatchRow
              key={item.code}
              item={item}
              onOpen={() => item.d && onOpen(item.code)}
              editing={editingCode === item.code}
              editTag={editTag}
              setEditTag={setEditTag}
              buying={buyingCode === item.code}
              dingtou={dingtouCode === item.code}
              onStartEdit={() => startEdit(item)}
              onSaveEdit={() => saveEdit(item.code)}
              onCancelEdit={() => setEditingCode(null)}
              onStartBuy={() => { setBuyingCode(item.code); setDingtouCode(null); setEditingCode(null) }}
              onStartDingtou={() => { setDingtouCode(item.code); setBuyingCode(null); setEditingCode(null) }}
              onDelete={() => del(item.code, item.d?.name)}
              onSaved={() => { setBuyingCode(null); setDingtouCode(null); load() }}
            />
          ))
        )}
      </section>
      )}
      {state.status === 'ok' && summary.valid < watch.length && !q && (
        <div className="data-note"><span>!</span>部分基金暂未获取到数据；缺失值保持空白，不做推测。</div>
      )}

      <div className="watch-section-head tools-heading">
        <div><h2>继续探索</h2></div>
      </div>
      <section className="quick-actions">
        <button className="quick-card discover-action" onClick={onDiscover}>
          <span className="quick-icon">⌕</span><span className="quick-title">发现机会</span><span className="quick-caption">查看历史位置与趋势</span><span className="quick-arrow">↗</span>
        </button>
        <button className="quick-card ledger-action" onClick={onSimLedger}>
          <span className="quick-icon">▤</span><span className="quick-title">模拟账本</span><span className="quick-caption">记录策略推演与交易</span><span className="quick-arrow">↗</span>
        </button>
      </section>

      <div className="privacy-note"><span>⌂</span><div><strong>记录留在本机</strong><small>持仓与推演数据仅保存在这台设备</small></div><span className="privacy-check">✓</span></div>
      <p className="watch-disclaimer">行情信息用于学习与策略验证，不构成投资建议。</p>
    </div>
  )
}

/**
 * 自选行：主区点击进详情；下方一行是来源徽章 + 编辑/加仓/定投/删除。
 * 操作按钮与主区分离（button 不能嵌套 button），点操作不会误触进详情。
 */
function WatchRow({
  item, onOpen, editing, editTag, setEditTag, buying, dingtou,
  onStartEdit, onSaveEdit, onCancelEdit, onStartBuy, onStartDingtou, onDelete, onSaved,
}) {
  const { d, error, tag, code, source } = item
  const last = d ? latestNetWorth(d.netWorth) : null
  const chg = d ? dayChange(d.netWorth) : null
  const cls = chg == null || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down'
  const sign = chg > 0 ? '+' : ''
  const dateLabel = last ? fmtNavDate(last.x, 'short') : '日期未知'
  const srcLabel = source === 'algo' ? '算法' : '人工'

  return (
    <div className="watch-row-wrap">
      <div className="watch-row-mainline">
        {error || !d ? (
          <div className="watch-fund-row unavailable">
            <div className="fund-avatar">{(tag || code || '?').slice(0, 1)}</div>
            <div className="watch-fund-main">
              <strong>基金 {code}</strong>
              <small>{error || '暂无数据'}</small>
            </div>
            <span className="fund-unavailable">暂不可用</span>
          </div>
        ) : (
          <button className="watch-fund-row" onClick={onOpen}>
            <span className={`fund-avatar avatar-${tag || 'default'}`}>{(tag || d.name || '?').slice(0, 1)}</span>
            <span className="watch-fund-main">
              <strong>{d.name}</strong>
              <small>
                <span className="fund-code">{d.code}</span><i />{tag || '未分类'}<i />净值 {dateLabel}
              </small>
            </span>
            <span className="watch-fund-numbers">
              <strong>{last ? last.y.toFixed(4) : '—'}</strong>
              <small className={cls}>{chg == null ? '涨跌 —' : `${sign}${chg.toFixed(2)}%`}</small>
            </span>
            <span className="row-chevron">›</span>
          </button>
        )}
      </div>

      <div className="watch-row-ops">
        <span className={`src-badge ${source === 'algo' ? 'algo' : 'manual'}`} title={source === 'algo' ? '算法动态生成（全市场三轨筛选达标）' : '你自己添加的'}>
          {srcLabel}
        </span>
        <button className="btn btn-sm" onClick={onStartEdit}>编辑</button>
        <button className="btn btn-sm" onClick={onStartBuy}>加仓</button>
        <button className="btn btn-sm" onClick={onStartDingtou}>定投</button>
        {source === 'manual' ? (
          <button className="btn btn-sm" onClick={onDelete}>删除</button>
        ) : (
          <button className="btn btn-sm" disabled title="算法自动维护，点「重算」刷新">删除</button>
        )}
      </div>

      {editing ? (
        <div className="rh-edit quick-form">
          <label className="field">
            <span>标签（显示在行内，最多 8 字）</span>
            <input type="text" maxLength={8} value={editTag} onChange={(e) => setEditTag(e.target.value)} placeholder="如 红利 / 港股" />
          </label>
          <div className="goal-form-actions">
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={onSaveEdit}>保存</button>
            <button className="btn" onClick={onCancelEdit}>取消</button>
          </div>
        </div>
      ) : null}

      {buying ? (
        <QuickBuyForm code={code} name={d?.name || item.name} nav={last?.y} navDate={last ? fmtNavDate(last.x) : ''} onSaved={onSaved} />
      ) : null}

      {dingtou ? <QuickDingtouForm code={code} name={d?.name || item.name} onSaved={onSaved} /> : null}
    </div>
  )
}
