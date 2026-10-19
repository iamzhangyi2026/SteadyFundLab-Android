/**
 * 指标格（.stat-grid 里的一格）
 * ------------------------------------------------------------
 * 结构固定为「标签 + 数值」，数值可带涨跌配色。
 * Detail.jsx 与 Holdings.jsx 原本各写了一份完全相同的实现，收敛到这里。
 *
 * @param {string}  k   - 标签，如「近 1 年」
 * @param {string}  v   - 数值文本（已格式化好的字符串）
 * @param {string} [cls] - 数值配色：'up' 涨 / 'down' 跌 / 'flat' 平，不传则用默认色
 */
export default function Stat({ k, v, cls }) {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className={`stat-v ${cls || ''}`}>{v}</div>
    </div>
  )
}
