// src/views/Compare.jsx · 多基金对比页
// ------------------------------------------------------------
// 入口在「发现」页。候选 = 真实持仓 + 内置观察池，最多选 6 只。
// 只做并排统计，不排名、不推荐。

import { useEffect, useMemo, useState } from 'react'
import CompareTable from '../components/CompareTable.jsx'
import { loadRealHoldings } from '../lib/realLedger.js'
import { fetchFund } from '../lib/eastmoney.js'

// 候选池只放代码：名称一律用接口返回值，抓不到就显示代码，不写死会过期的名称
const POOL = ['040001', '110010', '000021', '100038', '001594', '519674']

const MAX = 6

export default function Compare({ onOpen }) {
  const candidates = useMemo(() => {
    const held = loadRealHoldings()
      .filter((r) => r.code)
      .map((r) => ({ code: r.code, name: r.name || '', held: true }))
    const seen = new Set(held.map((x) => x.code))
    return [
      ...held,
      ...POOL.filter((c) => !seen.has(c)).map((code) => ({ code, name: '', held: false })),
    ]
  }, [])

  /* 内置池的名称先空着，等接口返回再补。
     fetchFund 有模块级缓存，对比表格随后取同一只不会重复请求。 */
  const [names, setNames] = useState({})
  useEffect(() => {
    let alive = true
    candidates
      .filter((c) => !c.held)
      .forEach((c) =>
        fetchFund(c.code)
          .then((d) => {
            if (alive && d?.name) setNames((p) => ({ ...p, [c.code]: d.name }))
          })
          .catch(() => {}),
      )
    return () => {
      alive = false
    }
  }, [candidates])

  const [picked, setPicked] = useState(() => candidates.slice(0, 3).map((x) => x.code))
  const [msg, setMsg] = useState('')

  function toggle(code) {
    if (picked.includes(code)) {
      if (picked.length <= 2) {
        setMsg('至少保留 2 只才能对比')
        return
      }
      setPicked(picked.filter((c) => c !== code))
      setMsg('')
      return
    }
    if (picked.length >= MAX) {
      setMsg(`最多同时对比 ${MAX} 只`)
      return
    }
    setPicked([...picked, code])
    setMsg('')
  }

  return (
    <>
      <div className="card">
        <div className="card-note" style={{ marginTop: 0, marginBottom: 'var(--space-3)' }}>
          选择 2–{MAX} 只基金并排比较（已选 {picked.length} 只）。候选来自你的真实持仓与内置观察池。
        </div>
        <div className="chip-row">
          {candidates.map((c) => (
            <button
              key={c.code}
              className={'chip' + (picked.includes(c.code) ? ' info' : '')}
              onClick={() => toggle(c.code)}
              style={{ border: 0, cursor: 'pointer' }}
            >
              {c.held ? c.name || c.code : names[c.code] || c.code}
            </button>
          ))}
        </div>
        {msg ? (
          <div className="card-note" style={{ marginTop: 'var(--space-2)' }}>
            {msg}
          </div>
        ) : null}
      </div>

      <div className="section-title">对比结果</div>
      <CompareTable codes={picked} onOpen={onOpen} />

      <p className="card-note" style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
        对比仅用于观察，不构成买入建议。
      </p>
    </>
  )
}
