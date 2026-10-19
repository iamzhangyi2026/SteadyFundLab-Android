// src/views/Holdings.jsx · 持仓页（只放真实持仓）
// ------------------------------------------------------------
// 这一页只装自己的钱：真实持仓 + 截图导入入口。
// 模拟盘（练手）不在这里 —— 它是独立页面 views/SimHoldings.jsx，
// 从「自选」页的「模拟账本」进，避免真假持仓挤在同一屏。
//
// 展示走 components/RealHoldingsPanel（首页同款，口径唯一）。

import { useEffect, useRef, useState } from 'react'
import ImportPanel from '../components/ImportPanel.jsx'
import RealHoldingsPanel from '../components/RealHoldingsPanel.jsx'
import { usePullRefresh } from '../lib/usePullRefresh.js'

export default function Holdings({ onOpenFund }) {
  const [importOpen, setImportOpen] = useState(false)
  const [realKey, setRealKey] = useState(0)
  const panelRef = useRef(null)

  // 下拉刷新：重新读账本 + 重新抓行情（force 由面板自己控制）
  usePullRefresh(() => setRealKey((k) => k + 1))

  // 面板展开时滚入视口（导入面板较长，按钮会被底部页签遮住）
  useEffect(() => {
    if (importOpen && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [importOpen])

  return (
    <>
      <RealHoldingsPanel
        refreshKey={realKey}
        onOpenFund={onOpenFund}
        showImportCta={false}
        showTools
      />

      <button
        className="btn btn-block"
        style={{ marginTop: 'var(--space-3)' }}
        onClick={() => setImportOpen((v) => !v)}
      >
        {importOpen ? '收起导入' : '＋ 导入真实持仓截图'}
      </button>

      {importOpen ? (
        <div className="card" style={{ marginTop: 'var(--space-3)' }} ref={panelRef}>
          <ImportPanel onImported={() => setRealKey((k) => k + 1)} onOpenFund={onOpenFund} />
        </div>
      ) : null}
    </>
  )
}
