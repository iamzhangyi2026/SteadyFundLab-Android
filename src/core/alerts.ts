// ─────────────────────────────────────────────
// alerts.ts · 涨跌 / 净值预警
//
// 用户给某只基金设阈值（日涨跌幅 / 单位净值高低），App 打开或刷新净值后
// 评估；命中且过了 24h 冷却 → 记一条触发记录 +（权限允许时）弹本地通知。
//
// 触发值口径（诚实、稳健，不依赖盘中估值接口，也不造假）：
//   - pct_down / pct_up：用 nav_daily 最近两行算「当日净值较昨日涨跌幅%」
//     （盘中估值更及时但接口不稳定，v1 用已落库净值，足够预警）
//   - nav_below / nav_above：用 nav_daily 最新一行单位净值
//   数据不足（不足两行 / 无净值）→ 跳过，不造假。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

/** 四类预警的元数据（UI 下拉 + 通知文案复用） */
export const ALERT_KINDS: Record<string, { key: string; label: string; unit: string; desc: string }> = {
  pct_down:  { key: 'pct_down',  label: '一天跌够', unit: '%', desc: '今天的净值比昨天跌得够多，就提醒你' },
  pct_up:    { key: 'pct_up',    label: '一天涨够', unit: '%', desc: '今天的净值比昨天涨得够多，就提醒你' },
  nav_below: { key: 'nav_below', label: '每份净值跌破', unit: '', desc: '最新每份净值低于这个数，就提醒你' },
  nav_above: { key: 'nav_above', label: '每份净值涨过', unit: '', desc: '最新每份净值高于这个数，就提醒你' },
}

export interface AlertRow {
  id: number
  fund_code: string
  fund_name?: string | null
  kind: string
  threshold: number
  enabled: number
  created_at: string
  last_triggered?: string | null
  trigger_count: number
}

/** 新增预警（相同 基金+类型+阈值 用 INSERT OR IGNORE 去重，不报已存在） */
export async function addAlert(
  db: LedgerDb,
  p: { fund_code: string; fund_name?: string | null; kind: string; threshold: number },
): Promise<number> {
  if (!ALERT_KINDS[p.kind]) throw new Error('未知预警类型: ' + p.kind)
  if (!p.fund_code) throw new Error('基金代码为空')
  if (!Number.isFinite(p.threshold)) throw new Error('阈值必须是数字')
  const created_at = new Date().toISOString()
  const r = await db.run(
    `INSERT OR IGNORE INTO price_alerts
       (fund_code, fund_name, kind, threshold, enabled, created_at, trigger_count)
     VALUES (?,?,?,?,1,?,0)`,
    [p.fund_code, p.fund_name ?? null, p.kind, p.threshold, created_at],
  ) as { lastInsertId?: number } | undefined
  return r?.lastInsertId ?? 0  // 0 = 已存在，未插入
}

/** 列出所有预警（含关闭的），UI 侧按 enabled 区分 */
export async function listAlerts(db: LedgerDb): Promise<AlertRow[]> {
  return db.query<AlertRow>(
    `SELECT id, fund_code, fund_name, kind, threshold, enabled, created_at, last_triggered, trigger_count
       FROM price_alerts ORDER BY created_at DESC`,
    [],
  )
}

/** 删除预警 */
export async function deleteAlert(db: LedgerDb, id: number): Promise<void> {
  await db.run('DELETE FROM price_alerts WHERE id=?', [id])
}

export interface LatestNav {
  nav: number
  navDate: string
  prevNav: number | null
  prevDate: string | null
}

/** 取最近两行净值（算日涨跌需要昨天的） */
export async function getLatestNav(db: LedgerDb, fundCode: string): Promise<LatestNav | null> {
  const rows = await db.query<{ nav_date: string; nav: number }>(
    `SELECT nav_date, nav FROM nav_daily WHERE fund_code=? ORDER BY nav_date DESC LIMIT 2`,
    [fundCode],
  )
  if (!rows.length) return null
  const latest = rows[0]
  const prev = rows[1] ?? null
  return {
    nav: latest.nav,
    navDate: latest.nav_date,
    prevNav: prev?.nav ?? null,
    prevDate: prev?.nav_date ?? null,
  }
}

export interface TriggeredAlert extends AlertRow {
  triggered_value: number
  triggered_at: string
}

/**
 * 评估所有启用中的预警，命中且过冷却 → 记触发记录 + 更新冷却/次数。
 * 返回本次新触发的列表（供上层发本地通知）。
 * 数据不足一律跳过（不造假）。
 */
export async function evaluateAlerts(
  db: LedgerDb,
  opts: { cooldownHours?: number } = {},
): Promise<TriggeredAlert[]> {
  const cooldownHours = opts.cooldownHours ?? 24
  const all = await listAlerts(db)
  const enabled = (all || []).filter(a => a.enabled !== 0)
  const triggered: TriggeredAlert[] = []
  const now = new Date()

  for (const a of enabled) {
    const nav = await getLatestNav(db, a.fund_code)
    if (!nav || nav.prevNav == null) continue   // 不足两行 → 数据不足，跳过

    let value: number
    let hit = false
    if (a.kind === 'nav_below') {
      value = nav.nav
      hit = nav.nav < a.threshold
    } else if (a.kind === 'nav_above') {
      value = nav.nav
      hit = nav.nav > a.threshold
    } else {
      const changePct = ((nav.nav - nav.prevNav) / nav.prevNav) * 100
      value = changePct
      if (a.kind === 'pct_down') hit = changePct <= -Math.abs(a.threshold)
      else if (a.kind === 'pct_up') hit = changePct >= Math.abs(a.threshold)
    }
    if (!hit) continue

    // 冷却：24h 内已触发过 → 跳过（避免每天开 App 都弹）
    const last = a.last_triggered ? new Date(a.last_triggered) : null
    if (last && (now.getTime() - last.getTime()) < cooldownHours * 3600 * 1000) continue

    const at = now.toISOString()
    await db.run(
      'UPDATE price_alerts SET last_triggered=?, trigger_count=trigger_count+1 WHERE id=?',
      [at, a.id],
    )
    await db.run(
      `INSERT INTO alert_history (alert_id, fund_code, fund_name, kind, threshold, triggered_value, triggered_at)
       VALUES (?,?,?,?,?,?,?)`,
      [a.id, a.fund_code, a.fund_name, a.kind, a.threshold, value, at],
    )
    triggered.push({ ...a, triggered_value: value, triggered_at: at })
  }
  return triggered
}

export interface HistoryRow {
  id: number
  alert_id: number | null
  fund_code: string
  fund_name?: string | null
  kind: string
  threshold: number
  triggered_value: number
  triggered_at: string
}

/** 触发历史（最新在前） */
export async function listHistory(db: LedgerDb, limit = 50): Promise<HistoryRow[]> {
  return db.query<HistoryRow>(
    `SELECT id, alert_id, fund_code, fund_name, kind, threshold, triggered_value, triggered_at
       FROM alert_history ORDER BY triggered_at DESC LIMIT ?`,
    [limit],
  )
}
