// ImportHoldingsPanel.jsx · 「从截图导入持仓」面板（本地离线 OCR）
//
// 流程：选图 → 本机 Tesseract 识别 → 解析候选 → 自动抓取识别出的基金资料/净值 → 直接写入真实持仓。
// OCR 在手机本地离线完成；识别出的基金自动联网抓取（用于估值/分位）。识别即导入，无需二次确认。

import { useState } from 'react'
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { ocrHoldingsFromImage, importHoldings, importHoldingByCode, findImportedImage, markImageImported } from '../lib/dataAdapter'
import { useData } from '../hooks/useData'
import { useNav } from '../lib/nav.jsx'

export default function ImportHoldingsPanel() {
  const nav = useNav()
  const { refresh } = useData()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [img, setImg] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [manual, setManual] = useState({})    // 未匹配条目手工补的 6 位代码 { 下标: code }
  const [fixBusy, setFixBusy] = useState(-1)  // 正在「补代码导入」的条目下标
  const [ocrText, setOcrText] = useState('')  // OCR 识别原文（排查识别漏条用）
  const [showText, setShowText] = useState(false)
  const [dup, setDup] = useState(null)        // 重复截图 { dataUrl, at } —— 命中则提示、不读取

  // 退出面板不释放 OCR worker：中文模型首次加载要几秒，保留常驻后
  // 「再导一张 / 连续导入多张」免掉这段等待（worker 在 ocr.ts 内模块级缓存）。

  // 真实持仓导入面板里点「已匹配」基金 → 跳「基金详情查看页」（看净值/估值/分位），
  // 与 Overview 真实持仓行一致。绝不跳交易页（交易页是虚拟资金沙盒，真实持仓不该引导去买卖）。
  const goDetail = (code, name) => {
    try { nav.push('fundDetail', { code, name: name || code, hideTrade: true }) } catch { /* ignore */ }
  }

  // 真正执行「识别 → 写入」的一段（正常导入与「仍要重新导入」共用）
  const doImport = async (dataUrl) => {
    setImg(dataUrl)
    setBusy(true)
    setStatus('正在识别…（首次要加载中文模型，约几秒）')
    try {
      const r = await ocrHoldingsFromImage(dataUrl, (p, s) => {
        setStatus(s || (p ? `识别中 ${Math.round(p * 100)}%` : '识别中…'))
      })
      if (!r.ok) { setErr(r.error || '识别失败'); return }
      const parsed = r.items || []
      setItems(parsed)
      setOcrText(r.text || '')   // 保留识别原文，便于排查识别漏条
      // 识别即导入：OCR 读出的就是真实持仓，自动抓取资料/净值后直接写入，不再二次确认
      setStatus('正在写入真实持仓…')
      const w = await importHoldings(parsed)
      const res = w.data || { inserted: 0, skipped: [] }
      setImportResult(res)
      // 记下这张截图的指纹（只记真写入了的 —— 识别失败/0 条不占坑，方便用户换图或重试）
      if ((res.inserted || 0) > 0) {
        try { await markImageImported(dataUrl, res.inserted) } catch { /* 记录失败不影响导入结果 */ }
      }
      await refresh?.()   // 持仓页/账户数据即时反映
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false); setStatus('')
    }
  }

  const pick = async () => {
    setErr(''); setItems(null); setImportResult(null); setDup(null)
    let dataUrl = null
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Photos,
        quality: 80,
      })
      dataUrl = photo?.dataUrl || null
    } catch (e) {
      setErr('没拿到图片：' + (e?.message || String(e)))
      return
    }
    if (!dataUrl) return
    // 同一张截图重复导入 → 不重复读取，避免持仓重复 / 覆盖手改过的成本。
    try {
      const hit = await findImportedImage(dataUrl)
      if (hit) { setImg(dataUrl); setDup({ dataUrl, at: hit.at }); return }
    } catch { /* 去重查询失败不阻塞正常导入 */ }
    await doImport(dataUrl)
  }

  // 未匹配条目手工补 6 位代码 → 联网抓资料/净值 → 匹配 → 写入真实持仓（隔离不变，只写 real）
  const fixUnmatched = async (i, code) => {
    const c = String(code || '').trim()
    if (!/^\d{6}$/.test(c)) { setErr('请输入 6 位基金代码'); return }
    setErr(''); setFixBusy(i)
    try {
      const w = await importHoldingByCode(items[i], c)
      if (!w.ok) { setErr(w.error || '导入失败'); return }
      const d = w.data || {}
      setItems(prev => prev.map((x, k) => (k === i ? { ...x, code: c, matched: d.matched || { fund_code: c, fund_name: c } } : x)))
      setImportResult(prev => {
        const base = prev || { inserted: 0, skipped: [], incomplete: [] }
        return {
          inserted: (base.inserted || 0) + (d.inserted || 0),
          skipped: [...(base.skipped || []), ...(d.skipped || [])],
          incomplete: [...(base.incomplete || []), ...(d.incomplete || [])],
        }
      })
      await refresh?.()
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setFixBusy(-1)
    }
  }

  return (
    <div>
      <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 12 }}>
        上传支付宝 / 天天基金等 APP 的持仓截图，截图<b>在手机本地离线识别</b>（不上传、不花钱）；识别出的基金会自动<b>联网抓取资料与净值</b>（用于看估值贵贱）。<br />
        识别即导入：读出的持仓会<b>直接写入「真实持仓」</b>，与「交易」页的买卖账本<b>完全分开</b>：不动交易本金、不算交易收益。<br />
        截图若只有「持有金额」没有「份额」，会先按 0 记份额写入，<b>导入后在持仓页点该行「修改」补全</b>即可。<br />
        <b>同一张截图重复导入会被自动跳过</b>（不重复识别），避免持仓重复；持仓有变化请重新截图。
      </div>

      <button className="btn-primary btn-block" style={{ width: '100%' }} disabled={busy} onClick={pick}>
        {importResult ? '再导入一张' : (busy ? (status || '识别中…') : '选择持仓截图')}
      </button>

      {/* 重复截图提示（同一张图不重复读取，避免持仓重复） */}
      {dup && (
        <div className="sub-card" style={{ marginTop: 12, lineHeight: 1.8 }}>
          <b>这张截图之前已经导入过了</b>
          <div className="muted cell-note" style={{ marginTop: 4 }}>
            上次导入时间：{dup.at}。这张图已识别过，本次跳过。
          </div>
          <div className="muted cell-note" style={{ marginTop: 4 }}>
            持仓有变化请重新截图；要用这张图重导，点「仍要重新导入」。
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn" style={{ flex: 1 }} onClick={() => { const d = dup.dataUrl; setDup(null); doImport(d) }}>仍要重新导入</button>
            <button className="btn" style={{ flex: 1 }} onClick={() => { setDup(null); setImg(null) }}>知道了</button>
          </div>
        </div>
      )}

      {img && (
        <img src={img} alt="已选截图" style={{ width: '100%', borderRadius: 12, marginTop: 12, border: '1px solid rgba(0,0,0,.06)' }} />
      )}

      {err && <div className="error-banner" style={{ marginTop: 12 }}>⚠ {err}</div>}

      {items && items.length === 0 && (
        <div className="muted cell-note" style={{ marginTop: 14, lineHeight: 1.7 }}>
          没识别到基金信息。换一张更清晰、只含持仓列表的截图再试。
        </div>
      )}

      {items && items.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="muted cell-note" style={{ marginBottom: 6 }}>
            识别到 <b>{items.length}</b> 条，匹配上 <b>{items.filter((x) => x.matched).length}</b> 条
            {items.some((x) => !x.matched) && (
              <>，<span style={{ color: 'var(--warn)' }}>未匹配 {items.filter((x) => !x.matched).length} 条</span></>
            )}
            （点已匹配的可看基金详情）
            {ocrText && (
              <>
                {' '}
                <span
                  className="link-btn"
                  role="button"
                  tabIndex={0}
                  onClick={() => setShowText((v) => !v)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowText((v) => !v) } }}
                >{showText ? '收起识别原文' : '查看识别原文'}</span>
              </>
            )}
          </div>
          {showText && ocrText && (
            <pre style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, lineHeight: 1.6,
              background: 'rgba(127,127,127,.12)', color: 'var(--text-soft)',
              padding: 8, borderRadius: 6, maxHeight: 220, overflow: 'auto', marginBottom: 8,
            }}>{ocrText}</pre>
          )}
          <div className="mini-list">
            {items.map((it, i) => (
              <div
                key={i}
                className="mini-item"
                style={{ cursor: it.matched ? 'pointer' : 'default' }}
                onClick={() => { if (it.matched) goDetail(it.matched.fund_code, it.matched.fund_name) }}
              >
                <div className="mini-top">
                  <span className="mini-title">{it.matched?.fund_name || it.name || it.code || '未识别'}</span>
                  {it.matched
                    ? <span className="ov-tag ok">已匹配</span>
                    : <span className="ov-tag warn">未匹配</span>}
                </div>
                <div className="mini-stats">
                  {it.code && <span className="mini-stat">代码 <b>{it.code}</b></span>}
                  {it.shares != null && <span className="mini-stat">份额 <b>{it.shares}</b></span>}
                  {it.amount != null && <span className="mini-stat">金额 <b>{it.amount}</b></span>}
                  {it.pct != null && <span className="mini-stat">收益 <b className={it.pct >= 0 ? 'pos' : 'neg'}>{it.pct}%</b></span>}
                </div>
                <div className="muted cell-note" style={{ marginTop: 4, fontSize: 11, opacity: .7 }}>{it.raw}</div>
                {/* 未匹配（截图无基金代码 / 名称识别不准）→ 手工补 6 位代码即可导入 */}
                {!it.matched && (
                  <div
                    style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      className="inp"
                      placeholder="补 6 位代码"
                      inputMode="numeric"
                      maxLength={6}
                      value={manual[i] ?? ''}
                      onChange={(e) => setManual(m => ({ ...m, [i]: e.target.value.replace(/\D/g, '') }))}
                      style={{ width: 104, fontSize: 13, padding: '5px 8px' }}
                    />
                    <button
                      className="btn"
                      style={{ fontSize: 12, padding: '5px 10px' }}
                      disabled={fixBusy === i}
                      onClick={() => fixUnmatched(i, manual[i])}
                    >{fixBusy === i ? '抓取中…' : '补代码导入'}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="muted cell-note" style={{ marginTop: 10, lineHeight: 1.7 }}>
            识别不出的字段已留空，可在持仓页补全。
          </div>

          {/* 导入回执（识别即写入，这里只展示结果） */}
          {importResult && (
            <div className="sub-card" style={{ marginTop: 12, lineHeight: 1.8 }}>
              <b>已写入真实持仓 {importResult.inserted} 条</b>
              {(importResult.skipped || []).length > 0 && (
                <div className="muted cell-note" style={{ marginTop: 6 }}>
                  {importResult.skipped.map((s, i) => (
                    <div key={i}>· {s.name}：跳过（{s.reason}）</div>
                  ))}
                </div>
              )}
              {(importResult.incomplete || []).length > 0 && (
                <div style={{ marginTop: 8, padding: '8px 10px', borderLeft: '3px solid var(--warn)', background: 'var(--surface-soft, rgba(0,0,0,.03))', borderRadius: 6 }}>
                  <div style={{ color: 'var(--warn)', fontWeight: 600, fontSize: 13 }}>
                    ⚠ {importResult.incomplete.length} 条缺字段，已先按 0 写入
                  </div>
                  <div className="muted cell-note" style={{ marginTop: 4 }}>
                    {importResult.incomplete.map((s, i) => (
                      <div key={i}>· {s.name}：缺 {s.missing.join('、')}</div>
                    ))}
                  </div>
                  <div className="muted cell-note" style={{ marginTop: 4 }}>
                    请回「持仓」页点该行「修改」补全份额 / 成本（截图只有持有金额、没有份额）。
                  </div>
                </div>
              )}
              <div className="muted cell-note" style={{ marginTop: 6 }}>
                回「持仓」页即可看到。导入有误可在持仓页「修改」或「移除」。
              </div>
              <button
                className="btn-primary btn-block"
                style={{ width: '100%', marginTop: 10 }}
                onClick={() => nav.pop()}
              >
                返回持仓查看
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
