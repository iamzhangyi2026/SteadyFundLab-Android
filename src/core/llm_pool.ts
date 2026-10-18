// ─────────────────────────────────────────────
// llm_pool.ts · 轻量 LLM 调用池（离线安全）
//
// - callLlm(prompt, context): 优先用 llm_client.simpleChat；不可用时返回桩字符串
// - poolStatus(): 返回池状态
// **绝不抛异常**。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'
import { loadLlmConfig, isConfigured, simpleChat } from './llm_client.ts'

export async function callLlm(db: LedgerDb, prompt: string, context = ''): Promise<string> {
  try {
    return await simpleChat(db, prompt, context)
  } catch {
    return `[stub] 当前环境暂未配置可用 LLM，已忽略请求：${String(prompt).slice(0, 60)}`
  }
}

export interface PoolStatus {
  available: boolean
  configured: boolean
  model: string | null
  base_url: string | null
  pool_size: number
}

export async function poolStatus(db: LedgerDb): Promise<PoolStatus> {
  try {
    const cfg = await loadLlmConfig(db)
    return {
      available: true,
      configured: isConfigured(cfg),
      model: cfg.model,
      base_url: cfg.base_url,
      pool_size: 1,
    }
  } catch {
    return { available: false, configured: false, model: null, base_url: null, pool_size: 0 }
  }
}
