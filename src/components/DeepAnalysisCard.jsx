// src/components/DeepAnalysisCard.jsx · 六段式深度分析卡
// ------------------------------------------------------------
// 由 lib/deep_analysis.js 的代码规则生成（不调大模型），本组件只负责渲染：
// 宽表格在窄屏改行式列表，信息项不减少；拿不到的字段如实显示「—」。

const SECTION_TITLE = { margin: 'var(--space-5) var(--space-1) var(--space-2)' }

function toneClass(v) {
  if (v == null) return ''
  const n = parseFloat(String(v))
  if (!Number.isFinite(n)) return ''
  return n > 0 ? 'up' : n < 0 ? 'down' : ''
}

function MetricRow({ label, value, note }) {
  return (
    <div className="da-row">
      <span className="da-row-k">{label}</span>
      <span className="da-row-v">
        <b className={toneClass(value)}>{value ?? '—'}</b>
        {note ? <small>{note}</small> : null}
      </span>
    </div>
  )
}

export default function DeepAnalysisCard({ report }) {
  if (!report || !report.ok) return null

  return (
    <div className="analysis-card">
      <div className="watch-section-head">
        <div>
          <h2>深度分析</h2>
        </div>
        <span className="text-action" style={{ color: '#9aa298' }}>
          代码规则生成
        </span>
      </div>

      {/* 一、核心结论 */}
      <div className="card">
        <div className="da-verdict">
          <strong>{report.verdict}</strong>
          <span className={`pill ${report.positionBand === 'overvalued' ? 'warn' : report.positionBand === 'undervalued' ? 'up' : 'flat'}`}>
            {report.positionLabel}
          </span>
          <span className="pill flat">趋势{report.trendLabel}</span>
        </div>
        <p className="card-note" style={{ marginTop: 8, lineHeight: 1.8 }}>
          {report.summary}
        </p>
      </div>

      {/* 二、硬指标 */}
      <div className="section-title" style={SECTION_TITLE}>硬指标</div>
      <div className="card plain" style={{ paddingTop: 4, paddingBottom: 4 }}>
        {report.metrics.map((m) => (
          <MetricRow key={m.label} label={m.label} value={m.value} note={`${m.note} · 来源：${m.source}`} />
        ))}
        <div className="card-note" style={{ marginTop: 8, lineHeight: 1.8 }}>
          {report.facts.map((f, i) => (
            <div key={i}>· {f}</div>
          ))}
        </div>
      </div>

      {/* 三、催化事件 */}
      <div className="section-title" style={SECTION_TITLE}>催化事件</div>
      {report.catalysts.length === 0 ? (
        <div className="card">
          <div className="card-note" style={{ lineHeight: 1.7 }}>{report.catalystsNote}</div>
        </div>
      ) : (
        <>
          <div className="card plain card-list">
            {report.catalysts.map((c, i) => (
              <div className="da-catalyst" key={`${c.kind}-${c.pub_time}-${i}`}>
                <span className="news-tag">{c.kind === 'announce' ? '公告' : '新闻'}</span>
                <span className="da-catalyst-main">
                  <strong>{c.title}</strong>
                  <small>
                    {c.pub_time || '时间未知'} · {c.source || '来源未知'}
                  </small>
                </span>
              </div>
            ))}
          </div>
          <p className="card-note" style={{ margin: '0 var(--space-1)' }}>{report.catalystsNote}</p>
        </>
      )}

      {/* 四、估值与业绩 */}
      <div className="section-title" style={SECTION_TITLE}>估值与业绩</div>
      <div className="card plain" style={{ paddingTop: 4, paddingBottom: 4 }}>
        {report.valuation.map((v) => (
          <div className="da-row" key={v.target}>
            <span className="da-row-k">{v.target}</span>
            <span className="da-row-v">
              <small>{v.metric}</small>
              <b>{v.value}</b>
            </span>
          </div>
        ))}
        <p className="card-note" style={{ marginTop: 8, lineHeight: 1.7 }}>{report.valuationNote}</p>
      </div>

      {/* 五、关注信号 */}
      <div className="section-title" style={SECTION_TITLE}>关注信号</div>
      <div className="card plain" style={{ paddingTop: 4, paddingBottom: 4 }}>
        {report.signals.map((s) => (
          <div className="da-row" key={s.name}>
            <span className="da-row-stars">{s.priority}</span>
            <span className="da-row-v">
              <b>{s.name}</b>
              <small>{s.standard}</small>
              <small>
                当前：<b>{s.status}</b>
              </small>
            </span>
          </div>
        ))}
      </div>

      {/* 六、投资建议 */}
      <div className="section-title" style={SECTION_TITLE}>投资建议</div>
      <div className="card">
        <p className="card-note" style={{ marginTop: 0, lineHeight: 1.7 }}>{report.advice.disclaimer}</p>
        <div className="da-advice-title">优先关注</div>
        {report.advice.focus.map((f, i) => (
          <p className="da-advice-item" key={i}>· {f}</p>
        ))}
        <div className="da-advice-title" style={{ marginTop: 10 }}>风险点</div>
        {report.advice.risks.map((r, i) => (
          <p className="da-advice-item" key={i}>· {r}</p>
        ))}
      </div>
    </div>
  )
}
