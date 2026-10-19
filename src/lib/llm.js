// src/lib/llm.js · 大模型调用（用户自填密钥）
// ------------------------------------------------------------
// ⚠️ 密钥绝不写进代码 / 打包产物：
//   用户在「我的 → AI 设置」里自己填 Base URL、API Key、模型名，
//   只存本机 localStorage，不上传、不随 APK 分发。
//
// 兼容 OpenAI 的 /chat/completions 协议（OpenAI、DeepSeek、通义、
// Moonshot、自建网关等只要兼容该协议都能用）。
//
// 未配置时 hasLlmConfig() 为 false，界面必须显示「去设置」，
// 不允许用规则结果冒充 AI 回复。

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const KEY = 'llm_config'

export const LLM_DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
}

/** 读本机 LLM 配置（缺失字段用默认值补齐；存储损坏退回默认） */
export function loadLlmConfig() {
  try {
    const raw = localStorage.getItem(KEY)
    const obj = raw ? JSON.parse(raw) : null
    return { ...LLM_DEFAULTS, ...(obj && typeof obj === 'object' ? obj : {}) }
  } catch {
    return { ...LLM_DEFAULTS }
  }
}

/**
 * 局部更新 LLM 配置并落盘（只存本机）
 * @param {{baseUrl?:string, apiKey?:string, model?:string}} patch
 * @returns {object} 合并后的完整配置
 */
export function saveLlmConfig(patch) {
  const next = { ...loadLlmConfig(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // 存储失败：本次会话仍可用
  }
  return next
}

/**
 * 清除本机 LLM 配置（密钥一起删掉）
 * @returns {object} 默认配置
 */
export function clearLlmConfig() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 忽略
  }
  return { ...LLM_DEFAULTS }
}

/** 三项配置（Base URL / API Key / 模型名）是否都填了 */
export function hasLlmConfig() {
  const c = loadLlmConfig()
  return !!(String(c.apiKey || '').trim() && String(c.baseUrl || '').trim() && String(c.model || '').trim())
}

/** 错误信息中文化：把 HTTP 状态翻译成用户能看懂的提示 */
function friendlyError(status, body) {
  if (status === 401 || status === 403) return '密钥无效或没有权限（401/403），请检查 API Key'
  if (status === 404) return '接口地址不对（404），请检查 Base URL（应到 /v1 这一层）'
  if (status === 429) return '请求过于频繁或额度不足（429），稍后再试'
  if (status >= 500) return `模型服务异常（${status}），稍后再试`
  const msg = String(body || '').slice(0, 200)
  return `请求失败（${status}）${msg ? '：' + msg : ''}`
}

/**
 * 发一次对话请求
 * @param {{messages: Array<{role:'system'|'user'|'assistant', content:string}>,
 *          temperature?: number, maxTokens?: number, timeoutMs?: number}} p
 * @returns {Promise<string>} 模型回复文本
 */
export async function chatCompletion({ messages, temperature = 0.3, maxTokens = 900, timeoutMs = 60000 } = {}) {
  const cfg = loadLlmConfig()
  if (!String(cfg.apiKey || '').trim()) throw new Error('还没有配置 API Key，请先到「我的 → AI 设置」填写')
  if (!String(cfg.baseUrl || '').trim()) throw new Error('还没有配置 Base URL')
  if (!String(cfg.model || '').trim()) throw new Error('还没有配置模型名')
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('没有可发送的内容')

  const url = String(cfg.baseUrl).trim().replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model: String(cfg.model).trim(),
    messages,
    temperature,
    max_tokens: maxTokens,
  }
  /* ⚠️ 必须 trim：用户从别处粘贴密钥时常常带首尾空格或换行，
     拼进 Authorization 头会变成 `Bearer sk-xxx\n` → 服务端 401。 */
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${String(cfg.apiKey).trim()}`,
  }

  let status = 0
  let text = ''

  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.post({
      url,
      headers,
      data: body,
      connectTimeout: 15000,
      readTimeout: timeoutMs,
    })
    status = res?.status || 0
    const d = res?.data
    text = typeof d === 'string' ? d : d == null ? '' : JSON.stringify(d)
  } else {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      status = r.status
      text = await r.text()
    } catch (e) {
      throw new Error('网络不可达：' + (e?.message || e))
    } finally {
      clearTimeout(t)
    }
  }

  if (status < 200 || status >= 300) throw new Error(friendlyError(status, text))

  let json = null
  try {
    json = typeof text === 'string' ? JSON.parse(text) : text
  } catch {
    throw new Error('模型返回的不是 JSON，可能 Base URL 指向了网页而不是 API')
  }

  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('模型没有返回内容（可能是模型名不对或额度用尽）')
  }
  return content.trim()
}

/** 测试连接：发一条最短请求 */
export async function testLlmConnection() {
  const reply = await chatCompletion({
    messages: [{ role: 'user', content: '只回复两个字：可用' }],
    temperature: 0,
    maxTokens: 20,
    timeoutMs: 30000,
  })
  return reply
}
