// src/components/PrivacyGate.jsx · 首屏隐私说明（首次安装弹一次）
// ------------------------------------------------------------
// 本项目为开源项目，不做强制同意拦截：说明只弹一次，点「知道了」即进入。
// 同意状态记在本机（lib/consent.js），不联网、不上传。

import { useState } from 'react'
import Privacy from '../views/Privacy.jsx'

/**
 * 首屏隐私说明（轻量，不阻断）
 * ------------------------------------------------------------
 * 「知道了」→ 记录已读，进入 App（不再有「拒绝即退出」的强制门）。
 * 「查看全文」→ 打开 Privacy 页。
 */
export default function PrivacyGate({ onAgree }) {
  const [showFull, setShowFull] = useState(false)

  return (
    <div className="gate">
      <div className="gate-card">
        {showFull ? (
          <>
            <div className="gate-scroll">
              <Privacy />
            </div>
            <div className="gate-actions">
              <button className="btn btn-block" onClick={() => setShowFull(false)}>
                返回
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="gate-head">
              <div className="gate-title">使用说明</div>
              <div className="gate-sub">开源项目 · 数据只存在你的手机里</div>
            </div>

            <div className="gate-body">
              <p className="gate-p">
                本 App 不设账号、不上传任何数据、不做统计上报。持仓与自选只存本机。
                只有你主动使用 AI 分析时，相关内容才会发送到你自行配置的 AI 接口。
              </p>

              <button className="gate-link" onClick={() => setShowFull(true)}>
                查看完整隐私政策
              </button>
            </div>

            <div className="gate-actions">
              <button className="btn btn-primary btn-block" onClick={onAgree}>
                知道了
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
