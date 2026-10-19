/**
 * 列表行骨架屏
 * ------------------------------------------------------------
 * 数据没到之前先占位，避免「白屏一闪 → 内容突然顶上来」。
 * 结构照着 .fund-row 的排布做（左侧两行文字 + 右侧两行数字），
 * 所以加载完成时高度不跳。
 *
 * Watch.jsx 与 Discover.jsx 原本各写了一份，收敛到这里。
 */
export default function RowSkeleton() {
  return (
    <div className="fund-row">
      <div className="fund-main">
        <div className="skeleton" style={{ height: 15, width: '60%', marginBottom: 7 }} />
        <div className="skeleton" style={{ height: 11, width: '55%' }} />
      </div>
      <div className="fund-num">
        <div className="skeleton" style={{ height: 17, width: 62, marginBottom: 6 }} />
        <div className="skeleton" style={{ height: 11, width: 46, marginLeft: 16 }} />
      </div>
    </div>
  )
}
