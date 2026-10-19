// src/lib/io.js · 导入 / 导出（C10）
// ------------------------------------------------------------
// 数据主权：真实持仓与模拟持仓都能导出成 CSV，也能把 CSV 导回来。
//
// 格式（UTF-8，带 BOM，Excel 打开中文不乱码）：
//   code,name,shares,amount,pct,nav_at_import,nav_date_at_import
//   code 可为空（无代码的条目按名称去重）
//
// 只做真实数据读写，不做任何字段猜测：导不出的列留空。

import { loadRealHoldings, addRealHoldings } from './realLedger.js'
import { loadSimHoldings } from './simLedger.js'

const HEADER = ['code', 'name', 'shares', 'amount', 'pct', 'nav_at_import', 'nav_date_at_import']

function esc(v) {
  if (v == null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows) {
  const lines = [HEADER.join(',')]
  for (const r of rows) {
    lines.push(
      [
        esc(r.code),
        esc(r.name),
        esc(r.shares),
        esc(r.amount),
        esc(r.pct),
        esc(r.nav_at_import),
        esc(r.nav_date_at_import),
      ].join(','),
    )
  }
  return '\ufeff' + lines.join('\r\n')
}

/** 真实持仓 CSV 文本 */
export function realHoldingsCsv() {
  return toCsv(loadRealHoldings())
}

/** 模拟持仓 CSV 文本（列同真实持仓，便于统一处理） */
export function simHoldingsCsv() {
  return toCsv(
    loadSimHoldings().map((r) => ({
      code: r.code,
      name: r.name,
      shares: r.shares,
      amount: r.amount,
      pct: null,
      nav_at_import: r.nav,
      nav_date_at_import: r.nav_date,
    })),
  )
}

/** 触发浏览器/WebView 下载 */
export function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  try {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
    return true
  } catch {
    return false
  }
}

/** 极简 CSV 解析：支持双引号包裹与转义（""），够本 App 的导出格式用 */
export function parseCsv(text) {
  const raw = String(text || '').replace(/^\ufeff/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quoted) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') {
      cell += ch
    }
  }
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''))
}

const numOrNull = (v) => {
  const n = parseFloat(String(v ?? '').trim())
  return Number.isFinite(n) ? n : null
}

/**
 * 解析真实持仓 CSV → 可写入账本的条目。
 * 表头必须含 code 或 name；数值列解析失败一律 null（不编 0）。
 */
export function parseRealHoldingsCsv(text) {
  const rows = parseCsv(text)
  if (rows.length < 2) return { items: [], error: '文件里没有数据行' }
  const head = rows[0].map((h) => String(h).trim().toLowerCase())
  const idx = (k) => head.indexOf(k)
  if (idx('code') < 0 && idx('name') < 0) {
    return { items: [], error: '缺少表头 code / name' }
  }
  const items = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const code = idx('code') >= 0 ? String(r[idx('code')] || '').trim() : ''
    const name = idx('name') >= 0 ? String(r[idx('name')] || '').trim() : ''
    if (!code && !name) continue
    items.push({
      code: code || null,
      name: name || null,
      shares: idx('shares') >= 0 ? numOrNull(r[idx('shares')]) : null,
      amount: idx('amount') >= 0 ? numOrNull(r[idx('amount')]) : null,
      pct: idx('pct') >= 0 ? numOrNull(r[idx('pct')]) : null,
      nav_at_import: idx('nav_at_import') >= 0 ? numOrNull(r[idx('nav_at_import')]) : null,
      nav_date_at_import:
        idx('nav_date_at_import') >= 0 ? String(r[idx('nav_date_at_import')] || '').trim() : '',
    })
  }
  return { items, error: items.length ? null : '没有解析到有效行' }
}

/** 导入并写入真实账本（按 code/name 覆盖，不累加） */
export function importRealHoldingsCsv(text) {
  const { items, error } = parseRealHoldingsCsv(text)
  if (error) return { written: 0, total: 0, error }
  const r = addRealHoldings(items)
  return { ...r, error: null }
}
