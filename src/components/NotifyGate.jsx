/**
 * 通知权限说明弹窗（第二道门）
 * ------------------------------------------------------------
 * 跟正常 App 请求权限一致：一句话说明用途，然后交用户决定。
 * 先解释再请求是必要的 —— Android 13+ 被拒两次后系统不再弹窗，
 * 等于永久失去机会，只能让用户自己去系统设置里翻。
 */
export default function NotifyGate({ onAllow, onDeny, busy }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-head">
          <div className="gate-title">开启通知</div>
          <div className="gate-sub">用于通知基金相关内容</div>
        </div>

        <div className="gate-body">
          <p className="gate-p">
            开启后可以收到基金相关提醒，随时可在系统设置中关闭。
          </p>
        </div>

        <div className="gate-actions">
          <button className="btn btn-primary btn-block" onClick={onAllow} disabled={busy}>
            {busy ? '处理中…' : '开启'}
          </button>
          <button className="btn btn-block" onClick={onDeny} disabled={busy}>
            暂不开启
          </button>
        </div>
      </div>
    </div>
  )
}
