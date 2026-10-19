// src/components/CompareTable.jsx · 多基金对比（C4）
// ------------------------------------------------------------
// 并排比较：近1年 / 近6月 / 近3月 / 最大回撤 / 年化波动。
// 全部用**累计净值**口径（区间收益与回撤），与详情页/深度分析一致。
// 拿不到某只基金就整行标注「抓取失败」，不拿空值参与排序。
// 净值序列含数据源异常跳变时（见 lib/navSanitize.js），该行指标全部留空
// 并标注「数据异常」，不显示跨口径的失真收益。

import { useEffect, useState } from 'react'
import { fetchFund, latestNetWorth, rangeReturn } from '../lib/eastmoney.js'
import { drawdownRecovery, annualVol } from '../lib/navlab.js'
import { toSeries } from '../lib/navCache.js'
import { detectJumps } from '../lib/navSanitize.js'
import RowSkeleton from './RowSkeleton.jsx'

const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`)
const cls = (v) => (v == null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down')

export default function CompareTable({ codes, onOpen }) {
  const [rows, setRows] = useState(null)

  useEffect(() => {
    let alive = true
    setRows(null)
    Promise.all(
      (codes || []).map(async (code) => {
        try {
          const d = await fetchFund(code)
          const series = toSeries(d)
          const suspect = detectJumps(series).length > 0
          return {
            code,
            name: d.name,
            error: null,
            suspect,
            nav: latestNetWorth(d.netWorth)?.y ?? null,
            r1y: suspect ? null : rangeReturn(d.accWorth, 365),
            r6m: suspect ? null : rangeReturn(d.accWorth, 182),
            r3m: suspect ? null : rangeReturn(d.accWorth, 91),
            dd: suspect ? null : drawdownRecovery(series)?.maxDrawdown ?? null,
            vol: suspect ? null : annualVol(series),
            samples: d.netWorth?.length ?? 0,
          }
        } catch (e) {
          return { code, name: `基金 ${code}`, error: e?.message || '抓取失败' }
        }
      }),
    ).then((r) => alive && setRows(r))
    return () => {
      alive = false
    }
  }, [codes])

  if (!rows) {
    return (
      <div className="card plain card-list">
        {(codes || []).slice(0, 4).map((c) => (
          <RowSkeleton key={c} />
        ))}
      </div>
    )
  }

  return (
    <div className="card cmp-wrap">
      <div className="cmp-scroll">
        <table className="cmp-table">
          <thead>
            <tr>
              <th className="cmp-name">基金</th>
              <th>近1年</th>
              <th>近6月</th>
              <th>近3月</th>
              <th>最大回撤</th>
              <th>年化波动</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.code}
                onClick={() => !r.error && onOpen && onOpen(r.code)}
                className={r.error ? 'cmp-error' : ''}
              >
                <td className="cmp-name">
                  <strong>{r.name}</strong>
                  <small>
                    <span className="fund-code">{r.code}</span>
                    {r.nav != null ? ` · ${r.nav.toFixed(4)}` : ''}
                  </small>
                </td>
                {r.error ? (
                  <td colSpan={5} className="cmp-fail">
                    {r.error}
                  </td>
                ) : (
                  <>
                    <td className={cls(r.r1y)}>{r.suspect ? '数据异常' : fmtPct(r.r1y)}</td>
                    <td className={cls(r.r6m)}>{r.suspect ? '—' : fmtPct(r.r6m)}</td>
                    <td className={cls(r.r3m)}>{r.suspect ? '—' : fmtPct(r.r3m)}</td>
                    <td className="down">{r.dd == null ? '—' : `${r.dd.toFixed(2)}%`}</td>
                    <td>{r.vol == null ? '—' : `${r.vol.toFixed(2)}%`}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
        区间收益与回撤用累计净值计算；年化波动 = 日收益率标准差 × √252。
        数据缺失显示「—」，不参与推断。点行可进详情。
      </p>
    </div>
  )
}
