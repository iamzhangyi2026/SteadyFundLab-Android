// backup.js · 数据备份与导入（本地离线，零后端）
//
// 导出：把本机「个人数据」六张表（funds / orders / lots / cash_ledger /
//        portfolio_daily / dividends）导出为多 sheet 的 .xlsx，中文表头，便于人读/迁移。
// 导入：合并模式 ——
//       有主键的表（funds / orders / portfolio_daily / dividends）按主键 INSERT OR REPLACE；
//       无业务主键的表（lots / cash_ledger）按自然签名去重后只追加新行；
//       **绝不 DELETE / 清空现有数据**（合并模式只增不删）。
// 文件格式：导出 .xlsx（多 sheet）；导入兼容本应用导出的 .xlsx 与单表 .csv。

import { getDb } from './dataAdapter'

// 每张表：中文 sheet 名 + 列映射（[db列, 中文表头]）+ 主键/导入策略
const TABLES = [
  {
    table: 'funds',
    sheet: '基金',
    mode: 'replace',
    key: 'fund_code', // 主键
    labels: [
      ['fund_code', '基金代码'], ['fund_name', '基金名称'], ['category', '类别'],
      ['purchase_fee_rate', '申购费率'], ['min_purchase', '起购金额'], ['is_qdii', '是否QDII'],
      ['status', '状态'], ['added_at', '添加时间'], ['note', '备注'],
    ],
  },
  {
    table: 'orders',
    sheet: '订单',
    mode: 'replace',
    key: 'order_id', // UNIQUE 约束触发 REPLACE
    labels: [
      ['order_id', '订单号'], ['type', '类型'], ['fund_code', '基金代码'], ['amount', '金额'],
      ['nav_date', '净值日'], ['status', '状态'], ['decision_source', '决策来源'], ['reason', '理由'],
      ['fee_rate', '费率'], ['fee_purchase', '申购费'], ['net_amount', '净金额'], ['confirm_date', '确认日'],
      ['filled_nav', '成交净值'], ['filled_shares', '成交份额'], ['filled_net_amount', '成交净金额'],
      ['expected_arrival_date', '预计到账日'], ['created_at', '创建时间'], ['updated_at', '更新时间'],
    ],
  },
  {
    table: 'lots',
    sheet: '份额批次',
    mode: 'dedupe', // 无业务主键，按自然签名去重追加
    signature: (r) => [r.fund_code, r.buy_order_id, r.buy_date, r.confirm_date, r.shares, r.cost_amount].join('|'),
    insertCols: ['fund_code', 'buy_order_id', 'buy_date', 'confirm_date', 'shares', 'remaining_shares', 'cost_amount', 'status', 'created_at'],
    labels: [
      ['fund_code', '基金代码'], ['buy_order_id', '买入订单号'], ['buy_date', '买入日'], ['confirm_date', '确认日'],
      ['shares', '份额'], ['remaining_shares', '剩余份额'], ['cost_amount', '成本金额'], ['status', '状态'],
      ['created_at', '创建时间'],
    ],
  },
  {
    table: 'cash_ledger',
    sheet: '现金账',
    mode: 'dedupe',
    signature: (r) => [r.created_at, r.action, r.fund_code, r.amount, r.order_id].join('|'),
    insertCols: ['amount', 'memo', 'action', 'fund_code', 'order_id', 'shares', 'cost_amount', 'created_at'],
    labels: [
      ['amount', '金额'], ['memo', '备注'], ['action', '动作'], ['fund_code', '基金代码'],
      ['order_id', '订单号'], ['shares', '份额'], ['cost_amount', '成本金额'], ['created_at', '创建时间'],
    ],
  },
  {
    table: 'portfolio_daily',
    sheet: '组合日报',
    mode: 'replace',
    key: 'snap_date', // 主键
    labels: [
      ['snap_date', '快照日'], ['total_assets', '总资产'], ['market_value', '市值'], ['cash', '现金'],
      ['total_cost', '总成本'], ['unrealized_pnl', '浮动盈亏'], ['realized_pnl', '已实现盈亏'],
      ['cumulative_pnl', '累计收益'], ['created_at', '创建时间'],
    ],
  },
  {
    table: 'dividends',
    sheet: '分红',
    mode: 'replace',
    key: 'composite', // UNIQUE(fund_code, ex_date)
    labels: [
      ['fund_code', '基金代码'], ['ex_date', '除息日'], ['dividend_per_share', '每份分红'],
      ['nav_before', '前净值'], ['nav_after', '后净值'], ['reinvest', '红利再投'], ['source', '来源'], ['created_at', '创建时间'],
    ],
  },
]

// db 行 → 中文表头对象
function toLabels(rows, labels) {
  const out = []
  for (const row of rows) {
    const o = {}
    for (const [col, label] of labels) {
      const v = row[col]
      o[label] = v == null ? '' : v
    }
    out.push(o)
  }
  return out
}

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 导出备份：六张个人表 → 多 sheet .xlsx → 触发下载。
 * 返回 { ok, data:{ fileName, total }, error? }
 */
export async function exportBackup() {
  const db = getDb()
  if (!db) return { ok: false, error: 'app_not_initialized' }
  try {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const now = new Date()
    const fileName =
      `fund-app-备份-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
      `-${pad2(now.getHours())}${pad2(now.getMinutes())}`
    let total = 0
    for (const t of TABLES) {
      const rows = await db.query(`SELECT * FROM ${t.table}`)
      const labeled = toLabels(rows, t.labels)
      total += labeled.length
      if (labeled.length) {
        const ws = XLSX.utils.json_to_sheet(labeled)
        XLSX.utils.book_append_sheet(wb, ws, t.sheet.slice(0, 31))
      }
    }
    XLSX.writeFile(wb, `${fileName}.xlsx`)
    return { ok: true, data: { fileName: `${fileName}.xlsx`, total } }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// 单表写入（中文表头原始行 → 映射回 db 列 → upsert）
async function importSheet(db, t, rawRows) {
  const labelToCol = {}
  for (const [col, label] of t.labels) labelToCol[label] = col
  const dbRows = rawRows
    .map((r) => {
      const o = {}
      for (const [label, val] of Object.entries(r)) {
        const col = labelToCol[label]
        if (col) o[col] = val === '' || val == null ? null : val
      }
      return o
    })
    .filter((r) => Object.keys(r).length > 0)
  return await upsertTable(db, t, dbRows)
}

async function upsertTable(db, t, rows) {
  if (!rows.length) return { updated: 0, inserted: 0, skipped: 0 }

  if (t.mode === 'replace') {
    // 现有主键集合（用于区分「覆盖」与「新增」）
    let existingKeys = new Set()
    if (t.key === 'composite') {
      const ex = await db.query(`SELECT fund_code, ex_date FROM ${t.table}`)
      for (const r of ex) existingKeys.add(`${r.fund_code}|${r.ex_date}`)
    } else {
      const ex = await db.query(`SELECT ${t.key} FROM ${t.table}`)
      for (const r of ex) existingKeys.add(String(r[t.key]))
    }
    const keyOf = (r) =>
      t.key === 'composite' ? `${r.fund_code}|${r.ex_date}` : String(r[t.key])

    let updated = 0
    let inserted = 0
    await db.transaction(async (tx) => {
      for (const r of rows) {
        const cols = Object.keys(r)
        const colList = cols.join(',')
        const placeholders = cols.map(() => '?').join(',')
        const vals = cols.map((c) => r[c])
        await tx.run(
          `INSERT OR REPLACE INTO ${t.table} (${colList}) VALUES (${placeholders})`,
          vals,
        )
        if (existingKeys.has(keyOf(r))) updated++
        else inserted++
      }
    })
    return { updated, inserted, skipped: 0 }
  }

  // dedupe 模式（lots / cash_ledger）：按自然签名去重，只追加新行
  const existing = await db.query(`SELECT * FROM ${t.table}`)
  const sigSet = new Set(existing.map((r) => t.signature(r)))
  let inserted = 0
  let skipped = 0
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const sig = t.signature(r)
      if (sigSet.has(sig)) { skipped++; continue }
      const cols = t.insertCols.filter((c) => r[c] !== undefined)
      const colList = cols.join(',')
      const placeholders = cols.map(() => '?').join(',')
      const vals = cols.map((c) => r[c])
      await tx.run(
        `INSERT INTO ${t.table} (${colList}) VALUES (${placeholders})`,
        vals,
      )
      inserted++
      sigSet.add(sig)
    }
  })
  return { updated: 0, inserted, skipped }
}

/**
 * 导入备份（合并模式，不删除现有数据）。
 * 支持：本应用导出的多 sheet .xlsx；或单表 .csv（按表头匹配最佳表）。
 * 返回 { ok, data:{ results: { 表名: {updated,inserted,skipped} } }, error? }
 */
export async function importBackup(file) {
  const db = getDb()
  if (!db) return { ok: false, error: 'app_not_initialized' }
  try {
    if (!file || typeof file.arrayBuffer !== 'function') {
      return { ok: false, error: '未获取到文件' }
    }
    const buf = await file.arrayBuffer()
    const XLSX = await import('xlsx')
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const results = {}

    // 1) 按中文 sheet 名匹配（xlsx 多表）
    for (const t of TABLES) {
      const ws = wb.Sheets[t.sheet]
      if (!ws) continue
      const rows = XLSX.utils.sheet_to_json(ws)
      results[t.table] =
        rows.length === 0
          ? { updated: 0, inserted: 0, skipped: 0 }
          : await importSheet(db, t, rows)
    }

    // 2) CSV 兜底：只有一个工作表，按表头重叠匹配最佳表
    if (Object.keys(results).length === 0) {
      const names = Object.keys(wb.Sheets)
      if (names.length === 1) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[names[0]])
        if (rows.length) {
          const fileLabels = new Set(Object.keys(rows[0]))
          let best = null
          let bestScore = 0
          for (const t of TABLES) {
            const score = t.labels.reduce(
              (s, [, label]) => s + (fileLabels.has(label) ? 1 : 0),
              0,
            )
            if (score > bestScore) { bestScore = score; best = t }
          }
          if (best && bestScore >= 2) {
            results[best.table] = await importSheet(db, best, rows)
          } else {
            return { ok: false, error: '无法识别备份文件结构（表头不匹配任何已知表）' }
          }
        }
      }
    }

    if (Object.keys(results).length === 0) {
      return { ok: false, error: '备份文件为空或无可用工作表' }
    }
    return { ok: true, data: { results } }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}
