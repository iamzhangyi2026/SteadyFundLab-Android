// BackupPanel.jsx · 数据备份与导入二级页
//
// 导出：把本机个人数据（基金/订单/份额批次/现金账/组合日报/分红）导出为 .xlsx 多 sheet 备份。
// 导入：合并模式（不删除现有数据）—— 相同主键覆盖、新增追加。

import { useState, useRef } from 'react'
import { exportBackup, importBackup } from '../lib/backup'

const cellStyle = { padding: '5px 8px', borderBottom: '1px solid rgba(0,0,0,.06)' }

export default function BackupPanel() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [result, setResult] = useState(null)
  const fileRef = useRef(null)

  const doExport = async () => {
    setErr(''); setMsg(''); setResult(null)
    setBusy(true)
    try {
      const r = await exportBackup()
      if (!r.ok) { setErr(r.error || '导出失败'); return }
      setMsg(`已导出备份：${r.data.fileName}（共 ${r.data.total} 行，已保存到下载目录）`)
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }

  const onPick = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选同一文件
    if (!file) return
    setErr(''); setMsg(''); setResult(null)
    setBusy(true)
    try {
      const r = await importBackup(file)
      if (!r.ok) { setErr(r.error || '导入失败'); return }
      setResult(r.data.results)
      setMsg('导入完成（合并模式：相同主键覆盖、新增追加，未删除任何现有数据）')
    } catch (e) {
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div className="muted cell-note" style={{ lineHeight: 1.75, marginBottom: 14 }}>
        把本机<b>个人数据</b>（基金 / 订单 / 份额批次 / 现金账 / 组合日报 / 分红）导出为 .xlsx 备份。
        换手机或重装前先导出，需要时再导入恢复。导出不含净值等行情 bulk 数据（可重新抓取）。
      </div>

      <button className="btn-primary btn-block" style={{ width: '100%' }} disabled={busy} onClick={doExport}>
        {busy ? '导出中…' : '导出备份（.xlsx）'}
      </button>

      <div style={{ margin: '16px 0', borderTop: '1px solid rgba(0,0,0,.06)' }} />

      <div className="muted cell-note" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        导入为<b>合并模式</b>：文件与本地都有的记录按主键覆盖；文件有、本地没有则新增；
        本地有、文件没有<b>保留不动</b>（不会删除任何现有数据）。
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv"
        style={{ display: 'none' }}
        onChange={onPick}
      />
      <button
        className="btn-primary btn-block"
        style={{ width: '100%', background: 'var(--surface-solid)', color: 'var(--accent)', border: '1px solid var(--accent)' }}
        disabled={busy}
        onClick={() => fileRef.current?.click()}
      >
        {busy ? '导入中…' : '选择备份文件导入'}
      </button>

      {err && <div className="error-banner" style={{ marginTop: 12 }}>⚠ {err}</div>}
      {msg && <div className="sub-card" style={{ marginTop: 12, lineHeight: 1.8 }}>{msg}</div>}

      {result && (
        <div className="sub-card" style={{ marginTop: 12, lineHeight: 1.9, fontSize: 13 }}>
          <b>导入明细</b>
          <table style={{ width: '100%', marginTop: 8, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-soft)' }}>
                <th style={cellStyle}>表</th>
                <th style={cellStyle}>覆盖</th>
                <th style={cellStyle}>新增</th>
                <th style={cellStyle}>跳过</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result).map(([tbl, r]) => (
                <tr key={tbl}>
                  <td style={cellStyle}>{tbl}</td>
                  <td style={cellStyle}>{r.updated ?? 0}</td>
                  <td style={cellStyle}>{r.inserted ?? 0}</td>
                  <td style={cellStyle}>{r.skipped ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
