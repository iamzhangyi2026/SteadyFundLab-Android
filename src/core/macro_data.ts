// ─────────────────────────────────────────────
// macro_data.ts · 宏观指标读取/抓取
//
// 说明：无独立的 macro/indicator 表，因此：
//   - getMacro: 返回 {}（无本地持久化宏观数据）
//   - fetchMacro: 未接权威 HTTP 源 → 降级为 {}
// 离线安全。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

export type MacroData = Record<string, unknown>

/** 返回最新宏观指标。当前无本地表，返回空对象（离线安全）。 */
export async function getMacro(_db: LedgerDb): Promise<MacroData> {
  return {}
}

/**
 * 尝试抓取宏观指标。未接权威 HTTP 源 → 返回空对象。
 */
export async function fetchMacro(_db: LedgerDb): Promise<MacroData> {
  return {}
}
