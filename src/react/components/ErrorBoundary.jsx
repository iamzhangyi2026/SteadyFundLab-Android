// ErrorBoundary.jsx · 全局错误边界（白板防御）
//
// 原则：白板是最糟的失败形式 —— 用户和开发者都不知道发生了什么。
// 包住路由树后，任何子组件崩溃都展示「页面加载失败 + 错误文本 + 重试按钮」，
// 而不是返回空白。错误同时进入结构化缓冲，供「更多 → 导出诊断」查看。
import { Component } from 'react'
import { pushFetchError } from '../../data/sqlite_fetcher.ts'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // 进入结构化错误缓冲（供「设置 → 导出诊断」查看）
    try {
      pushFetchError('ErrorBoundary', `${error?.message || String(error)} | ${info?.componentStack?.slice(0, 300) || ''}`)
    } catch {
      console.error('[ErrorBoundary]', error, info)
    }
    this.setState({ info })
  }

  handleRetry = () => {
    this.setState({ error: null, info: null })
  }

  handleHardReset = () => {
    try {
      localStorage.clear()
    } catch (_) { /* ignore */ }
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children

    const msg = String(this.state.error?.message || this.state.error || '未知错误')
    const stack = String(this.state.info?.componentStack || '').slice(0, 600)

    return (
      <div style={{
        padding: '24px 16px',
        margin: '12px 16px',
        background: 'var(--danger-soft)',
        border: '1px solid var(--danger)',
        borderRadius: 12,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: 'var(--danger)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          页面加载失败
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12, color: 'var(--danger)' }}>
          该页面的数据或渲染出现异常，已记录到本地诊断日志（更多 → 导出诊断）。
        </div>
        <div style={{
          background: 'var(--surface-solid)',
          border: '1px solid var(--danger-soft)',
          borderRadius: 6,
          padding: 10,
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          color: 'var(--danger)',
          maxHeight: 220,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          marginBottom: 12,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{msg}</div>
          {stack && <div style={{ color: 'var(--warn)' }}>{stack}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={this.handleRetry}
            style={{
              flex: 1,
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--danger)',
              background: 'var(--surface-solid)',
              color: 'var(--danger)',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            重试
          </button>
          <button
            onClick={this.handleHardReset}
            style={{
              flex: 1,
              padding: '10px 12px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--danger)',
              color: 'var(--on-accent)',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            清除缓存并重启
          </button>
        </div>
      </div>
    )
  }
}
