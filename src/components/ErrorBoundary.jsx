// src/components/ErrorBoundary.jsx · 渲染错误兜底
// ------------------------------------------------------------
// 作用：React 渲染一旦抛错，不让整页白屏，而是显示可操作的错误页。
// 技术细节只进 logcat（componentDidCatch 里的 console.error），不铺到界面上。
//
// 边界：拦「渲染/生命周期」错误，不拦异步回调（那些由各自的 catch 管）。

import { Component, Fragment } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null, remountKey: 0 }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    // 留着排查：logcat 里能看到堆栈
    console.error('[ErrorBoundary]', error?.message || error, info?.componentStack || '')
  }

  reset = () => {
    /* 只把 error 清掉的话，同一份 children 会原样重渲染一遍 ——
       确定性错误（比如访问不存在的字段）立刻又被抛出来，
       用户点「重试」看起来毫无反应。这里换 remountKey 强制重建子树。 */
    this.setState((s) => ({ error: null, info: null, remountKey: s.remountKey + 1 }))
  }

  render() {
    const { error, remountKey } = this.state
    if (!error) return <Fragment key={remountKey}>{this.props.children}</Fragment>

    return (
      <div className="gate">
        <div className="gate-card">
          <div className="gate-head">
            <div className="gate-title">页面出错了</div>
            <div className="gate-sub">点「重试」再来一次；还不行就重新加载 App</div>
          </div>
          <div className="gate-actions">
            <button className="btn btn-primary btn-block" onClick={this.reset}>
              重试
            </button>
            <button
              className="btn btn-block"
              onClick={() => {
                this.reset()
                window.location.reload()
              }}
            >
              重新加载 App
            </button>
          </div>
        </div>
      </div>
    )
  }
}
