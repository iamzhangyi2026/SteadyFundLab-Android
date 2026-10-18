// FundProfileCard.jsx · 基金深度（能力评分 / 规模 / 资产配置 / 持有人结构）
// 数据：pingzhongdata（fetchFundProfileFor）。抓不到就明说"取不到"，不造假。
import { useEffect, useState } from 'react'
import { fetchFundProfileFor } from '../lib/dataAdapter'

export default function FundProfileCard({ code }) {
  const [p, setP] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    try {
      const r = await fetchFundProfileFor(code)
      setP(r.ok ? r.data : null)
    } finally { setBusy(false) }
  }
  useEffect(() => { load() }, [code])

  if (p == null) {
    return (
      <div className="sub-card" style={{ marginTop: 12 }}>
        <div className="subhead">基金深度</div>
        <div className="muted cell-note" style={{ lineHeight: 1.8 }}>
          {busy ? '正在拉取…' : '暂时取不到（数据源问题）——不是没有，是没拿到，点下面刷新重试。'}
        </div>
        <button className="btn-tiny" style={{ marginTop: 8 }} disabled={busy} onClick={load}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>
    )
  }

  // 平均分 → 1~5 星（每 20 分一星）
  const stars = p.score_avr != null ? Math.max(1, Math.min(5, Math.round(p.score_avr / 20))) : null

  return (
    <div className="sub-card" style={{ marginTop: 12 }}>
      <div className="subhead">基金深度</div>

      {(p.score_avr != null || p.score_items.length > 0) ? (
        <>
            {p.score_avr != null && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 700 }}>{p.score_avr.toFixed(1)}</span>
                <span className="muted cell-note">综合能力（百分制）</span>
                {stars != null && (
                  <span style={{ marginLeft: 'auto', color: 'var(--warn)', letterSpacing: 1 }}>
                    {'★'.repeat(stars)}{'☆'.repeat(5 - stars)}
                  </span>
                )}
              </div>
            )}

            {p.score_items.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {p.score_items.map(it => (
                  <div key={it.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span className="muted cell-note" style={{ flex: '0 0 60px', width: 60 }}>{it.name}</span>
                    <div style={{ flex: 1, height: 6, background: 'rgba(15,23,42,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.max(0, Math.min(100, it.value))}%`, height: '100%', background: 'var(--accent)' }} />
                    </div>
                    <span className="muted cell-note" style={{ width: 30, textAlign: 'right' }}>{it.value.toFixed(0)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="muted cell-note" style={{ marginTop: 6 }}>综合能力评分暂未取到（不是没有，是这次没拿到）</div>
        )}

      <div className="muted cell-note" style={{ marginTop: 10, lineHeight: 1.9 }}>
        {p.scale_latest != null && (
          <div>规模 {p.scale_latest.toFixed(2)} 亿元{p.scale_mom ? `（环比 ${p.scale_mom}）` : ''}</div>
        )}
        {(p.alloc_stock != null || p.alloc_bond != null || p.alloc_cash != null) && (
          <div>资产配置　股票 {p.alloc_stock ?? '—'}% · 债券 {p.alloc_bond ?? '—'}% · 现金 {p.alloc_cash ?? '—'}%</div>
        )}
        {(p.holder_inst != null || p.holder_person != null) && (
          <div>持有人　机构 {p.holder_inst ?? '—'}% · 个人 {p.holder_person ?? '—'}%{p.holder_date ? `（${p.holder_date}）` : ''}</div>
        )}
      </div>

      <button className="btn-tiny" style={{ marginTop: 8 }} disabled={busy} onClick={load}>
        {busy ? '刷新中…' : '刷新'}
      </button>
    </div>
  )
}
