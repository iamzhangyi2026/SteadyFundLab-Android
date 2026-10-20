/**
 * 隐私政策全文
 * ------------------------------------------------------------
 * 按正常 App 的蓝本写：分章节、语气平和，不做撇清式声明。
 */

export default function Privacy({ onBack }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="app-title">隐私政策</div>
            <div className="app-sub">更新日期</div>
          </div>
        </div>
      </header>

      <main className="app-body">
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            欢迎使用基金沙盒。本政策说明我们如何处理与你相关的数据。
          </p>
        </div>

        <div className="section-title">一、数据存储</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            你添加的自选基金、持仓记录以及偏好设置，均保存在你的设备本地。
            你可以随时查看、修改或删除这些数据。卸载 App 将清除全部本地数据。
          </p>
        </div>

        <div className="section-title">二、网络连接</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            App 在以下情况会使用网络：获取基金行情数据、检查版本更新。
            除此之外不会主动发起其他网络请求。
          </p>
        </div>

        <div className="section-title">三、通知</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            通知权限默认关闭。你可以在首次启动时或「我的」页中开启，
            用于接收基金相关提醒。随时可在系统设置中关闭。
          </p>
        </div>

        <div className="section-title">四、账号</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            本 App 不设账号体系，无需注册或登录。
          </p>
        </div>

        <div className="section-title">五、你的权利</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            你有权查看、更正、删除你的数据，也可以随时关闭通知权限。
          </p>
        </div>

        <div className="section-title">六、政策更新</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            本政策如有更新，会在 App 内提示。继续使用即视为接受更新后的政策。
          </p>
        </div>

        {onBack ? (
          <button className="btn btn-block" onClick={onBack}>
            返回
          </button>
        ) : null}
      </main>
    </div>
  )
}
