// ─────────────────────────────────────────────
// coordinator.ts · 混合运行协调（AI 在线接管 / 离线规则兜底）
//
//
//   AI 在线  → AI 负责分析决策，规则引擎降级为「执行者」+ 风控拦截
//   AI 离线  → 规则引擎升格为「决策者」，按纪律线自主交易
//
// 判定"在不在"靠心跳：AI 每次操作刷新时间戳，超时即判定离线。
// ⚠️ 存储改用 app_settings（心跳 + 紧急停止），与设置页统一。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

const KEY_ESTOP = 'emergency_stop'
const KEY_HB_SEEN = 'heartbeat_last_seen'
const KEY_HB_SRC = 'heartbeat_source'

const DEFAULT_HEARTBEAT_TIMEOUT_H = 6

function _nowIso(): string { return new Date().toISOString().slice(0, 19) }

async function _get(db: LedgerDb, key: string): Promise<string | null> {
  try {
    const rows = await db.query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [key])
    return rows[0]?.value ?? null
  } catch { return null }
}

async function _set(db: LedgerDb, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, value, _nowIso()],
  )
}

// ─── 紧急停止 ─────────────────────────────────────────────

export async function isEmergencyStop(db: LedgerDb): Promise<boolean> {
  return (await _get(db, KEY_ESTOP)) === '1'
}

export async function setEmergencyStop(
  db: LedgerDb, on: boolean, note = '',
): Promise<{ stop: boolean; updated_at: string; note: string }> {
  await _set(db, KEY_ESTOP, on ? '1' : '0')
  if (note) await _set(db, 'emergency_stop_note', note)
  return { stop: !!on, updated_at: _nowIso(), note }
}

// ─── 心跳 ─────────────────────────────────────────────

export async function touchHeartbeat(db: LedgerDb, source = 'ai', note = ''): Promise<void> {
  await _set(db, KEY_HB_SEEN, _nowIso())
  await _set(db, KEY_HB_SRC, source)
  if (note) await _set(db, 'heartbeat_note', note)
}

export async function readHeartbeat(db: LedgerDb): Promise<{ last_seen: string; source: string } | null> {
  const seen = await _get(db, KEY_HB_SEEN)
  if (!seen) return null
  const src = (await _get(db, KEY_HB_SRC)) || 'ai'
  return { last_seen: seen, source: src }
}

/** AI 是否在线（只有 source="ai" 的心跳才算在线）。 */
export async function isAiOnline(db: LedgerDb, timeoutHours?: number): Promise<boolean> {
  const hb = await readHeartbeat(db)
  if (!hb || hb.source !== 'ai') return false
  const last = new Date(hb.last_seen.replace(' ', 'T')).getTime()
  if (Number.isNaN(last)) return false
  const timeout = timeoutHours ?? DEFAULT_HEARTBEAT_TIMEOUT_H
  return (Date.now() - last) < timeout * 3600 * 1000
}

/** 当前实际生效的运行模式（结合心跳判断）。 */
export async function currentMode(db: LedgerDb, configuredMode = 'auto'): Promise<'external' | 'rule' | string> {
  if (configuredMode !== 'auto') return configuredMode
  return (await isAiOnline(db)) ? 'external' : 'rule'
}

export interface CoordStatus {
  configured_mode: string
  effective_mode: string
  ai_online: boolean
  heartbeat_timeout_hours: number
  last_seen: string | null
  last_source: string | null
  idle_hours: number | null
  emergency_stop: boolean
}

export async function status(db: LedgerDb, configuredMode = 'auto'): Promise<CoordStatus> {
  const hb = await readHeartbeat(db)
  const mode = await currentMode(db, configuredMode)
  let idle: number | null = null
  if (hb) {
    const last = new Date(hb.last_seen.replace(' ', 'T')).getTime()
    if (!Number.isNaN(last)) idle = Math.round(((Date.now() - last) / 3600000) * 100) / 100
  }
  return {
    configured_mode: configuredMode,
    effective_mode: mode,
    ai_online: await isAiOnline(db),
    heartbeat_timeout_hours: DEFAULT_HEARTBEAT_TIMEOUT_H,
    last_seen: hb?.last_seen ?? null,
    last_source: hb?.source ?? null,
    idle_hours: idle,
    emergency_stop: await isEmergencyStop(db),
  }
}
