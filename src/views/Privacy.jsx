/**
 * 隐私政策全文
 * ------------------------------------------------------------
 * 本项目为开源项目，政策按「如实说明」写：不设账号、不上传数据、
 * 不做统计上报，只有你主动使用 AI 时才会向你自己配置的接口发请求。
 */

export default function Privacy({ onBack }) {
  /* ⚠️ 同 About：隐私页两处都在别人的滚动容器里渲染
     （首屏 gate 的 .gate-scroll / 「我的」页所在的 App .app-body），
     所以这里只给内容，不套整页骨架。 */
  return (
    <>
      <div className="card">
        <p className="card-note" style={{ lineHeight: 1.8 }}>
          基金沙盒是开源项目。本政策如实说明 App 会做什么、不会做什么。
        </p>
      </div>

        <div className="section-title">一、数据存储</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            你添加的自选基金、真实持仓、模拟账本以及偏好设置，全部保存在你的设备本地。
            没有服务器端账号，也没有云端同步。卸载 App 会清除全部本地数据。
          </p>
        </div>

        <div className="section-title">二、网络连接</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            只在两种情况下联网：① 获取公开的基金行情、净值、公告等数据（只读请求，
            不携带你的持仓）；② 你主动使用「AI 分析」时，把当前基金或持仓信息发送到
            你自己在设置里填写的 AI 接口。除此之外不发起其他网络请求。
          </p>
        </div>

        <div className="section-title">三、不做的事</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            不设账号、不收集设备信息、不上报使用时长或电量、不做匿名统计、
            不内置任何第三方统计或广告 SDK。
          </p>
        </div>

        <div className="section-title">四、通知</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            通知权限默认关闭，只用于你开启的基金提醒（涨跌 / 估值洼地 / 定投到期），
            可随时在系统设置中关闭。
          </p>
        </div>

        <div className="section-title">五、开源</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            代码公开可查，上述边界都可以在源码中核对。欢迎自行构建、修改与分发。
          </p>
        </div>

        <div className="section-title">六、你的权利</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            你的数据都在自己手里：可随时查看、修改、删除，或卸载 App 全部清除。
          </p>
        </div>

        <div className="section-title">七、政策更新</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            政策随版本更新，改动会在更新日志中说明。
          </p>
        </div>

      {onBack ? (
        <button className="btn btn-block" onClick={onBack}>
          返回
        </button>
      ) : null}
    </>
  )
}
