import { useEffect, useState } from 'react'

// 决策速览：总览「AI决策日志」用。
// 只显示「决策结果 + 时间戳 + 简短原因」——买入/定投/赎回 是有动作的决策，
// 「不动」（观望/持有）也照实显示并写明原因。多条自动轮换，鼠标悬停暂停。
// 颜色沿用全站约定：买入/定投=红（up），赎回=绿（down），不动=中性。
const ACTION_META = {
  buy: { label: '买入', cls: 'up' },
  dingtou: { label: '定投', cls: 'up' },
  redeem: { label: '赎回', cls: 'down' },
  hold: { label: '不动', cls: 'muted' },
}

// 时间戳：取「MM-DD HH:MM」，决策跨天也能看清是哪天做的
function stamp(ts) {
  const s = String(ts || '').replace('T', ' ')
  if (s.length >= 16) return `${s.slice(5, 10)} ${s.slice(11, 16)}`
  return s
}

export default function DecisionTicker({ items = [] }) {
  const [idx, setIdx] = useState(0)
  const [paused, setPaused] = useState(
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
  const len = items.length

  useEffect(() => {
    if (paused || len <= 1) return
    const t = setInterval(() => setIdx((i) => (i + 1) % len), 5000)
    return () => clearInterval(t)
  }, [paused, len])

  // 条数变化（新决策落库）时把越界下标拉回来
  useEffect(() => {
    if (idx >= len) setIdx(0)
  }, [len, idx])

  if (!len) return null
  const it = items[idx]
  const meta = ACTION_META[it.action] || { label: it.action || '—', cls: 'muted' }

  return (
    <div className="decision-ticker">
      <div className="dt-head">
        <span className="kicker">今天该怎么办</span>
        {len > 1 && (
          <button
            className="btn btn-sm"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            aria-label={paused ? '继续轮播' : '暂停轮播'}
          >
            {paused ? '▶ 播放' : '⏸ 暂停'}
          </button>
        )}
      </div>

      <div
        className="dt-body"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div className="dt-row">
          <span className={`tag ${meta.cls}`}>{meta.label}</span>
          <strong className="dt-fund">{it.fund_name || it.fund_code}</strong>
          <span className="muted cell-note dt-ts">{stamp(it.ts)}</span>
        </div>
        <p className="dt-reason">{it.reason || '（未填写原因）'}</p>
      </div>

      {len > 1 && (
        <div className="nr-dots">
          {items.map((_, i) => (
            <button
              key={i}
              className={`nr-dot ${i === idx ? 'on' : ''}`}
              onClick={() => setIdx(i)}
              aria-label={`切到第 ${i + 1} 条`}
              aria-current={i === idx || undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
