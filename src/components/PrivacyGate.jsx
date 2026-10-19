// src/components/PrivacyGate.jsx · 首屏隐私政策弹窗（第一道门）
// ------------------------------------------------------------
// 首次安装 / 卸载重装后出现，两个选项：
//   「知道了」  → 记录已同意，进入第二道门（通知权限）
//   「查看全文」→ 打开 Privacy 页
// 同意状态记在本机（lib/consent.js），不联网、不上传。

import { useState } from 'react'
import Privacy from '../views/Privacy.jsx'

/**
 * 首屏隐私政策弹窗（第一道门）
 * ------------------------------------------------------------
 * 首次安装 / 卸载重装后出现，两个选项：
 *   「知道了」  → 记录已同意，进入第二道门（通知权限）
 *   「忍心拒绝」→ 结束进程（与正常 App 拒绝隐私政策时的表现一致）
 */
export default function PrivacyGate({ onAgree, onDecline }) {
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
              <div className="gate-title">隐私政策</div>
              <div className="gate-sub">请阅读并同意后继续使用</div>
            </div>

            <div className="gate-body">
              <p className="gate-p">
                使用前请先阅读隐私政策，了解你的数据如何被处理。
              </p>

              <button className="gate-link" onClick={() => setShowFull(true)}>
                查看完整隐私政策
              </button>
            </div>

            <div className="gate-actions">
              <button className="btn btn-primary btn-block" onClick={onAgree}>
                知道了
              </button>
              <button className="btn btn-block" onClick={onDecline}>
                忍心拒绝
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
