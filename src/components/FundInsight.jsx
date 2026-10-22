// src/components/FundInsight.jsx · 基金穿透分析卡
// ------------------------------------------------------------
// 对每只基金的分析不是给几个数字，而是**有判断、有结论**：
//   · 行业配置：钱实际压在哪些行业（季报口径）
//   · 集中度：最大单一行业占比是否超过 50%
//   · 风格漂移：名字宣称的方向 vs 实际持仓（「XX消费精选」实际消费只占 12% → 名不副实）
//   · 人读叙述：把上面几条翻译成一句普通人看得懂的话
//
// 全部走 lib/exposure.js（东财行业配置接口）。
// 抓不到就显示空态，不编。

import { useEffect, useState } from 'react'
import { analyzeFundIndustry } from '../lib/exposure.js'

export default function FundInsight({ code, name }) {
  const [state, setState] = useState({ status: 'loading', value: null })

  useEffect(() => {
    let alive = true
    setState({ status: 'loading', value: null })
    analyzeFundIndustry(code, name)
      .then((v) => alive && setState({ status: 'ok', value: v }))
      .catch(() => alive && setState({ status: 'empty', value: null }))
    return () => {
      alive = false
    }
  }, [code, name])

  const v = state.value

  return (
    <div className="insight-card">
      <div className="watch-section-head">
        <div>
          <h2>穿透分析</h2>
        </div>
        {v?.exposure?.reportDate ? (
          <span className="text-action" style={{ color: 'var(--text-mute)' }}>
            {v.exposure.reportDate} 报告
          </span>
        ) : null}
      </div>

      {state.status === 'loading' ? (
        <div className="card">
          <div className="skeleton" style={{ height: 44 }} />
        </div>
      ) : state.status === 'empty' || !v ? (
        <div className="card">
          <div className="empty">
            <div className="empty-title">暂无穿透数据</div>
            <div className="empty-note">行业配置接口暂不可用，稍后再试</div>
          </div>
        </div>
      ) : (
        <>
          {/* 行业分布 */}
          {v.exposure.allocation.length > 0 && (
            <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
              {v.exposure.allocation.slice(0, 6).map((a) => (
                <div className="insight-row" key={a.industry}>
                  <span className="insight-name">{a.industry}</span>
                  <span className="insight-bar">
                    <i style={{ width: `${Math.min(100, a.weight)}%` }} />
                  </span>
                  <span className="insight-pct num">{a.weight.toFixed(2)}%</span>
                </div>
              ))}
              {v.exposure.allocation.length > 6 && (
                <div className="card-note" style={{ marginTop: 6 }}>
                  其余 {v.exposure.allocation.length - 6} 个行业合计{' '}
                  {v.exposure.allocation
                    .slice(6)
                    .reduce((s, a) => s + a.weight, 0)
                    .toFixed(2)}
                  %
                </div>
              )}
            </div>
          )}

          {/* 人读叙述 */}
          <div className="card">
            {(v.narrative || []).map((p, i) => (
              <p className="insight-note" key={i}>
                {p}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
