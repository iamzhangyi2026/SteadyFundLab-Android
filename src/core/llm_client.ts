// ─────────────────────────────────────────────
// llm_client.ts · LLM 客户端
//
//
// 设计要点：
//   - 不硬编码 API 密钥：从本地配置（app_settings）读取
//   - 支持多模型路由（OpenAI 兼容 /chat/completions；base_url / model / system_prompt 可配）
//   - 未配置时给兜底回复，不假装在线
//   - 绝不抛异常（错误走 error 字段）
//
// HTTP 由外部注入（setLlmHttp）：真机走 NativeHttp.post（绕过 WebView CORS/DNS）。
// ─────────────────────────────────────────────

import type { LedgerDb } from './ledger.ts'

export interface LlmConfig {
  base_url: string
  model: string
  api_key: string
  system_prompt: string
}

export const LLM_DEFAULTS = {
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4-flash',
}

export type LlmPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
) => Promise<{ status: number; data: unknown }>

let _post: LlmPost | null = null
export function setLlmHttp(fn: LlmPost | null): void { _post = fn }

/** 从 app_settings 读取 LLM 配置（缺省用默认值）。 */
export async function loadLlmConfig(db: LedgerDb): Promise<LlmConfig> {
  const out: LlmConfig = {
    base_url: LLM_DEFAULTS.base_url,
    model: LLM_DEFAULTS.model,
    api_key: '',
    system_prompt: '',
  }
  try {
    const rows = await db.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings
       WHERE key IN ('llm_base_url','llm_model','llm_api_key','llm_system_prompt')`,
    )
    for (const r of rows) {
      if (r.key === 'llm_base_url' && r.value) out.base_url = r.value
      else if (r.key === 'llm_model' && r.value) out.model = r.value
      else if (r.key === 'llm_api_key') out.api_key = r.value || ''
      else if (r.key === 'llm_system_prompt') out.system_prompt = r.value || ''
    }
  } catch { /* 读不到用默认 */ }
  return out
}

export function isConfigured(cfg: LlmConfig): boolean { return !!cfg.api_key }

export interface ChatResult { content: string; model?: string; error?: string }

/** 发送对话请求（OpenAI 兼容）。 */
export async function chat(
  cfg: LlmConfig,
  messages: { role: string; content: string }[],
  temperature = 0.7,
): Promise<ChatResult> {
  if (!cfg.api_key) return { content: '请先在「设置 → AI 配置」里填入密钥', error: 'llm_not_configured' }
  if (!_post) return { content: '当前环境不支持联网调用 AI', error: 'llm_http_not_injected' }

  let msgs = messages
  if (cfg.system_prompt && !messages.some(m => m.role === 'system')) {
    msgs = [{ role: 'system', content: cfg.system_prompt }, ...messages]
  }
  const url = `${cfg.base_url.replace(/\/+$/, '')}/chat/completions`
  const body = JSON.stringify({ model: cfg.model, messages: msgs, temperature })

  try {
    const res = await _post(
      url,
      { Authorization: `Bearer ${cfg.api_key}`, 'Content-Type': 'application/json' },
      body,
      60000,
    )
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
    const content = (data as any)?.choices?.[0]?.message?.content
    if (!content) return { content: 'AI 未返回内容', error: 'empty_response' }
    return { content, model: (data as any)?.model || cfg.model }
  } catch (e) {
    return { content: 'AI 服务暂时不可用，请稍后重试', error: (e as Error)?.message || String(e) }
  }
}

/**
 * 简单对话：未配置时给**诚实兜底**（指向本机能力），不编造投资建议。
 */
export async function simpleChat(db: LedgerDb, prompt: string, context = ''): Promise<string> {
  const cfg = await loadLlmConfig(db)
  if (!isConfigured(cfg)) return _fallback()
  const messages = context
    ? [{ role: 'system', content: context }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]
  const r = await chat(cfg, messages)
  return r.content || '抱歉，我无法回答这个问题'
}

function _fallback(): string {
  return 'AI 尚未配置（设置 → AI 配置）。当前可用的本地能力：持仓与净值看「账户 / 交易」，'
    + '纪律线看「决策速览」，选基看「分析 → 候选标的」。'
}
