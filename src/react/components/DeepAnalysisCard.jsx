// DeepAnalysisCard.jsx · 六段式深度分析（APP 版式）
//
// 结构：核心结论 / 硬指标 / 催化事件 / 估值与业绩 / 关注信号 / 投资建议。
// 由 core/deep_analysis.ts 的代码规则生成（不调大模型），本组件只负责渲染：
// 宽表格改成「行式列表」适配窄屏，信息项不减少；拿不到的字段如实显示「—」。

const SECTION_TITLE = {
  fontSize: 13,
  fontWeight: 700,
  margin: '14px 0 6px',
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
}

const SECTION_NO = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--accent, #3b6ef6)',
}

const ROW = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  padding: '6px 0',
  borderBottom: '1px solid rgba(0,0,0,0.05)',
}

// 收益正负 → 涨跌色（涨红跌绿，与全站一致）
function toneClassOf(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  if (Number.isNaN(n)) return ''
  return n > 0 ? 'tone-up' : n < 0 ? 'tone-down' : ''
}

function MetricRowView({ row }) {
  const tone = toneClassOf(row.value)
  return (
    <div style={ROW}>
      <span style={{ flex: '0 0 108px', fontSize: 12, fontWeight: 600, lineHeight: 1.5 }}>{row.label}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className={tone} style={{ fontSize: 13, fontWeight: 700, fontFeatureSettings: '"tnum"' }}>
          {row.value ?? '—'}
        </span>
        <span className="muted cell-note" style={{ display: 'block', marginTop: 2, lineHeight: 1.6 }}>
          {row.note}（来源：{row.source}）
        </span>
      </span>
    </div>
  )
}

export default function DeepAnalysisCard({ report }) {
  if (!report || !report.ok) return null

  const bandTag = report.positionBand === 'overvalued' ? 'warn'
    : report.positionBand === 'undervalued' ? 'ok' : 'neutral'

  return (
    <div className="sub-card" style={{ marginTop: 12 }}>
      <div className="subhead">
        深度分析
        <span className="muted cell-note">六段式 · 代码规则生成</span>
      </div>

      {/* 一、核心结论 */}
      <div style={SECTION_TITLE}><span style={SECTION_NO}>一</span>核心结论</div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
        padding: '8px 10px', borderRadius: 8, background: 'var(--accent-soft, #eef3fe)',
      }}>
        <span style={{ fontSize: 18, fontWeight: 800 }}>{report.verdict}</span>
        <span className={`tag ${bandTag}`}>{report.positionLabel}</span>
        <span className="tag neutral">趋势{report.trendLabel}</span>
      </div>
      <div className="muted cell-note" style={{ marginTop: 6, lineHeight: 1.8 }}>
        {report.summary}
      </div>

      {/* 二、硬指标 */}
      <div style={SECTION_TITLE}><span style={SECTION_NO}>二</span>硬指标</div>
      {report.metrics.map((m) => <MetricRowView key={m.label} row={m} />)}
      <div className="muted cell-note" style={{ marginTop: 8, lineHeight: 1.8 }}>
        {report.facts.map((f, i) => <div key={i}>· {f}</div>)}
      </div>

      {/* 三、催化事件 */}
      <div style={SECTION_TITLE}><span style={SECTION_NO}>三</span>催化事件</div>
      {report.catalysts.length === 0 ? (
        <div className="muted cell-note" style={{ lineHeight: 1.7 }}>{report.catalystsNote}</div>
      ) : (
        <>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {report.catalysts.map((c, i) => (
              <li key={`${c.kind}-${c.pub_time}-${i}`} style={{ padding: '6px 0', borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span className="tag neutral" style={{ flex: '0 0 auto' }}>
                    {c.kind === 'announce' ? '公告' : '新闻'}
                  </span>
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600, lineHeight: 1.55 }}>{c.title}</span>
                </div>
                <div className="muted cell-note" style={{ marginTop: 2 }}>
                  {c.pub_time || '时间未知'} · {c.source || '来源未知'}
                </div>
              </li>
            ))}
          </ul>
          <div className="muted cell-note" style={{ marginTop: 6, lineHeight: 1.6 }}>{report.catalystsNote}</div>
        </>
      )}

      {/* 四、估值与业绩 */}
      <div style={SECTION_TITLE}><span style={SECTION_NO}>四</span>估值与业绩</div>
      <div>
        {report.valuation.map((v) => (
          <div key={v.target} style={ROW}>
            <span style={{ flex: '0 0 52px', fontSize: 12, fontWeight: 600 }}>{v.target}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="muted cell-note" style={{ display: 'block' }}>{v.metric}</span>
              <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.6 }}>{v.value}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="muted cell-note" style={{ marginTop: 6, lineHeight: 1.7 }}>{report.valuationNote}</div>

      {/* 五、关注信号 */}
      <div style={SECTION_TITLE}><span style={SECTION_NO}>五</span>关注信号</div>
      <div>
        {report.signals.map((s) => (
          <div key={s.name} style={ROW}>
            <span style={{ flex: '0 0 52px', fontSize: 12, color: 'var(--warn)', letterSpacing: -1 }}>{s.priority}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{s.name}</span>
              <span className="muted cell-note" style={{ display: 'block', lineHeight: 1.6 }}>
                {s.standard}
              </span>
              <span className="muted cell-note" style={{ display: 'block', lineHeight: 1.6 }}>
                当前：{s.status}
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* 六、投资建议 */}
      <div style={SECTION_TITLE}><span style={SECTION_NO}>六</span>投资建议</div>
      <div className="muted cell-note" style={{ lineHeight: 1.7 }}>{report.advice.disclaimer}</div>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>优先关注</div>
        {report.advice.focus.map((f, i) => (
          <div key={i} className="muted cell-note" style={{ marginTop: 4, lineHeight: 1.75 }}>· {f}</div>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>风险点</div>
        {report.advice.risks.map((r, i) => (
          <div key={i} className="muted cell-note" style={{ marginTop: 4, lineHeight: 1.75 }}>· {r}</div>
        ))}
      </div>
    </div>
  )
}
