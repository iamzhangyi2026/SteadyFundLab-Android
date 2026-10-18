// pendingAction.js · 跨页一次性指令
//
// 场景：详情页（fundDetail 二级页）底部的「手动买入 / 手动赎回」按钮。
// 按钮写入一条一次性指令 → 切到交易页 → 交易页挂载/收到事件时消费它，
// 把该基金设为选中并展开金额输入区，用户直接在交易页完成买卖。
//
// 为什么用模块级变量而不是 URL 参数：导航栈（lib/nav.jsx）的 params 只传 body/render，
// 且 Trade 是常驻 Tab 页（可能已挂载、不重新 mount），模块级 pending + 事件双通道最稳。

let _pending = null

/** 写一条待处理指令（覆盖旧的）。可带 amount（建议金额预填）与 reason（AI 理由摘要） */
export function setPendingTrade(v) {
  _pending = v && v.code
    ? {
        code: String(v.code),
        action: v.action || 'buy',
        amount: v.amount != null && Number.isFinite(Number(v.amount)) && Number(v.amount) > 0 ? Number(v.amount) : null,
        reason: v.reason ? String(v.reason).slice(0, 120) : null,
      }
    : null
}

/** 取走指令（取一次即清空，避免重复消费） */
export function takePendingTrade() {
  const v = _pending
  _pending = null
  return v
}
