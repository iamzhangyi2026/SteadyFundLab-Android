// useNotify.jsx · 铃铛面板状态管理
// 提供简单的 open/close toggle，让铃铛按钮可以打开通知面板
import { useState, useCallback } from 'react'

export function useNotify() {
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen(v => !v), [])
  const close = useCallback(() => setOpen(false), [])
  return { open, toggle, close }
}

export default useNotify
