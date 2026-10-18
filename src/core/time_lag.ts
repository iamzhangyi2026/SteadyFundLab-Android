// ─────────────────────────────────────────────
// time_lag.ts · 计算事件发生时点到对外发布时点的时滞（lag）
// ─────────────────────────────────────────────

export interface TimeLagRow {
  event_time: unknown
  publish_time: unknown
  lag_seconds: number | null
  lag_minutes: number | null
}

function _parse(ts: unknown): number | null {
  if (ts == null) return null
  if (ts instanceof Date) return ts.getTime()
  const s = String(ts).trim()
  if (!s) return null
  let t = Date.parse(s)
  if (!Number.isNaN(t)) return t
  // 兜底：把空格换 T、补时区
  t = Date.parse(s.replace(' ', 'T'))
  return Number.isNaN(t) ? null : t
}

/** 计算每条事件的时滞。无法解析的时间返回 lag_seconds=null。 */
export function detectTimeLag(events: { event_time?: unknown; publish_time?: unknown }[]): TimeLagRow[] {
  const out: TimeLagRow[] = []
  for (const ev of events || []) {
    try {
      const et = _parse(ev?.event_time)
      const pt = _parse(ev?.publish_time)
      if (et == null || pt == null) {
        out.push({ event_time: ev?.event_time, publish_time: ev?.publish_time, lag_seconds: null, lag_minutes: null })
        continue
      }
      const lag = (pt - et) / 1000
      out.push({ event_time: ev?.event_time, publish_time: ev?.publish_time, lag_seconds: lag, lag_minutes: Math.round((lag / 60) * 100) / 100 })
    } catch {
      out.push({ event_time: ev?.event_time, publish_time: ev?.publish_time, lag_seconds: null, lag_minutes: null })
    }
  }
  return out
}
