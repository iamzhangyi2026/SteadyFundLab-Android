// src/components/ImportPanel.jsx · 真实持仓导入（本地离线 OCR）
// ------------------------------------------------------------
// 流程：相册选图 → 本机 Tesseract 识别 → 解析候选 → 确认写入真实持仓账本。
// OCR 在手机本地离线完成（资源打包在 APP 内），不联网、不调用任何 key。
// 识别不出的不猜：无代码的条目照常入库（名称留档），详情跳转仅对有代码的开放。

import { useState } from 'react'
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { recognizeImage, parseHoldingsFromText } from '../lib/ocr.js'
import { addRealHoldings } from '../lib/realLedger.js'
import { fetchLiveNav } from '../lib/live.js'

export default function ImportPanel({ onImported, onOpenFund }) {
  // phase：idle 待选图 / busy 识别中 / result 待确认 / done 已写入
  const [phase, setPhase] = useState('idle')
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState(0)
  const [items, setItems] = useState([])
  const [err, setErr] = useState('')
  const [written, setWritten] = useState(0)
  const [showText, setShowText] = useState(false)
  const [ocrText, setOcrText] = useState('')

  async function pick() {
    setErr('')
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Photos,
        quality: 90,
      })
      await runImport(photo.dataUrl)
    } catch (e) {
      const msg = e?.message || String(e)
      // 用户取消选图不提示错误
      if (!/cancel|取消/i.test(msg)) setErr(msg)
    }
  }

  async function runImport(dataUrl) {
    setPhase('busy')
    setStatus('正在识别…（首次要加载中文模型，约几秒）')
    setProgress(0)
    const r = await recognizeImage(dataUrl, (p, s) => {
      setProgress(p)
      if (s) setStatus(s)
    })
    if (!r.ok) {
      setErr(r.error || '识别失败')
      setPhase('idle')
      return
    }
    const parsed = parseHoldingsFromText(r.text)
    setOcrText(r.text || '')
    setItems(parsed)
    if (parsed.length === 0) {
      setStatus('')
      setPhase('empty')
    } else {
      setStatus('')
      setPhase('result')
    }
  }

  async function confirm() {
    // 记下导入当天的净值：截图里通常没有份额，日后市值只能靠这个基准换算
    const codes = items.map((i) => i.code).filter(Boolean)
    let navMap = {}
    if (codes.length) {
      try {
        navMap = await fetchLiveNav(codes)
      } catch {
        // 拉不到就留空，持仓面板会用当时的净值补基准
      }
    }
    const enriched = items.map((it) => ({
      ...it,
      nav_at_import: it.code ? navMap[it.code]?.nav ?? null : null,
      nav_date_at_import: it.code ? navMap[it.code]?.date ?? '' : '',
    }))

    const res = addRealHoldings(enriched)
    if (res.written === 0) {
      setErr('写入失败（存储空间不足？）')
      return
    }
    setWritten(res.written)
    setPhase('done')
    if (onImported) onImported()
  }

  function reset() {
    setPhase('idle')
    setItems([])
    setErr('')
    setProgress(0)
  }

  return (
    <>
      <div className="section-title">从截图导入</div>

      {err ? <div className="callout warn" style={{ marginBottom: 'var(--space-3)' }}>{err}</div> : null}

      {phase === 'idle' || phase === 'empty' ? (
        <div className="card">
          {phase === 'empty' ? (
            <div className="empty">
              <div className="empty-title">没识别到基金</div>
              <div className="empty-note">换一张更清晰、只含持仓列表的截图再试</div>
            </div>
          ) : (
            <div className="empty">
              <div className="empty-title">导入真实持仓</div>
              <div className="empty-note">
                选择支付宝 / 天天基金等 App 的持仓列表截图，本机离线识别后写入真实持仓
              </div>
            </div>
          )}
          <button className="btn btn-primary btn-block" onClick={pick} style={{ marginTop: 12 }}>
            选择持仓截图
          </button>
        </div>
      ) : null}

      {phase === 'busy' ? (
        <div className="card">
          <div className="hero-label">{status || '识别中…'}</div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-2, #eef1f7)', marginTop: 10, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round(progress * 100)}%`, background: 'var(--accent, #3b6ef6)', transition: 'width .2s' }} />
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {Math.round(progress * 100)}% · 识别全程在本机完成，不联网
          </div>
        </div>
      ) : null}

      {phase === 'result' ? (
        <>
          <div className="card plain card-list">
            {items.map((it, i) => (
              <div
                className="fund-row fund-row-static"
                key={i}
                style={it.code && onOpenFund ? { cursor: 'pointer' } : undefined}
                role={it.code && onOpenFund ? 'button' : undefined}
                tabIndex={0}
                onClick={it.code && onOpenFund ? () => onOpenFund(it.code, it.name) : undefined}
              >
                <div className="fund-main">
                  <div className="fund-name">{it.name || '（未识别名称）'}</div>
                  <div className="fund-meta">
                    {it.code ? <span className="num">{it.code}</span> : '无代码'}
                    {it.shares != null ? ` · ${it.shares.toFixed(2)} 份` : ''}
                    {it.amount != null ? ` · 市值 ¥${it.amount.toLocaleString('zh-CN')}` : ''}
                    {it.pct != null ? ` · ${it.pct > 0 ? '+' : ''}${it.pct.toFixed(2)}%` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button className="btn btn-primary btn-block" style={{ marginTop: 'var(--space-3)' }} onClick={confirm}>
            确认导入 {items.length} 条
          </button>
          <button className="btn btn-block" style={{ marginTop: 'var(--space-2)' }} onClick={reset}>
            重新选图
          </button>
          <div className="muted" style={{ marginTop: 8, fontSize: 12, textAlign: 'center' }}>
            <span
              className="link-btn"
              role="button"
              tabIndex={0}
              onClick={() => setShowText((v) => !v)}
            >
              {showText ? '收起识别原文' : '查看识别原文'}
            </span>
          </div>
          {showText ? (
            <div className="card" style={{ marginTop: 8 }}>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, margin: 0, color: 'var(--text-soft, #64748b)' }}>
                {ocrText || '（空）'}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}

      {phase === 'done' ? (
        <>
          <div className="callout teal" style={{ marginBottom: 'var(--space-3)' }}>
            已写入真实持仓 {written} 条，可在上方「真实持仓」查看
          </div>
          <button className="btn btn-block" onClick={reset}>再导一张</button>
        </>
      ) : null}
    </>
  )
}
