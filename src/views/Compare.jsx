// src/views/Compare.jsx · 多基金对比页（C4）
// ------------------------------------------------------------
// 入口在「发现」页。候选 = 真实持仓 + 内置观察池，最多选 6 只。
// 只做并排统计，不排名、不推荐。

import { useMemo, useState } from 'react'
import CompareTable from '../components/CompareTable.jsx'
import { loadRealHoldings } from '../lib/realLedger.js'

const POOL = [
  { code: '040001', name: '华安创新混合' },
  { code: '110010', name: '易方达价值成长混合' },
  { code: '000021', name: '华夏优势增长' },
  { code: '100038', name: '富国沪深300指数增强A' },
  { code: '001594', name: '天弘中证银行' },
  { code: '519674', name: '银河创新成长' },
]

const MAX = 6

export default function Compare({ onOpen }) {
  const candidates = useMemo(() => {
    const held = loadRealHoldings()
      .filter((r) => r.code)
      .map((r) => ({ code: r.code, name: r.name || r.code }))
    const seen = new Set()
    return [...held, ...POOL].filter((x) => {
      if (!x.code || seen.has(x.code)) return false
      seen.add(x.code)
      return true
    })
  }, [])

  const [picked, setPicked] = useState(() => candidates.slice(0, 3).map((x) => x.code))

  function toggle(code) {
    setPicked((prev) => {
      if (prev.includes(code)) {
        return prev.length <= 2 ? prev : prev.filter((c) => c !== code)
      }
      return prev.length >= MAX ? prev : [...prev, code]
    })
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
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="section-title">对比结果</div>
      <CompareTable codes={picked} onOpen={onOpen} />

      <p className="card-note" style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
        对比仅用于观察，不构成买入建议。
      </p>
    </>
  )
}
