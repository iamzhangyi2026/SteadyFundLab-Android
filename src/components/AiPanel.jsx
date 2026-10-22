// src/components/AiPanel.jsx · AI 设置 + 对话
// ------------------------------------------------------------
// LlmSettingsPanel：Base URL / API Key / 模型名，由用户自己填，只存本机。
// AiChatPanel：带当前基金/持仓上下文的对话，只基于提供的数据回答。
//
// ⚠️ 密钥不写进代码、不随 APK 分发；未配置时明确提示「去设置」，
//    不用规则结果冒充 AI 回复。

import { useState } from 'react'
import {
  loadLlmConfig,
  saveLlmConfig,
  clearLlmConfig,
  hasLlmConfig,
  chatCompletion,
  testLlmConnection,
} from '../lib/llm.js'

/* ---------------- AI 设置 ---------------- */
export function LlmSettingsPanel() {
  const [cfg, setCfg] = useState(loadLlmConfig)
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  function set(k, v) {
    setCfg((p) => ({ ...p, [k]: v }))
  }

  function save() {
    const next = saveLlmConfig({
      baseUrl: String(cfg.baseUrl || '').trim(),
      apiKey: String(cfg.apiKey || '').trim(),
      model: String(cfg.model || '').trim(),
    })
    setCfg(next)
    setMsg({ ok: true, text: '已保存到本机（不会上传、不会打进安装包）' })
  }

  async function test() {
    setBusy(true)
    setMsg(null)
    try {
      // 先把当前输入存下来，测试的就是用户刚填的值
      saveLlmConfig({
        baseUrl: String(cfg.baseUrl || '').trim(),
        apiKey: String(cfg.apiKey || '').trim(),
        model: String(cfg.model || '').trim(),
      })
      const reply = await testLlmConnection()
      setMsg({ ok: true, text: `连接成功，模型回复：${reply}` })
    } catch (e) {
      setMsg({ ok: false, text: e?.message || '连接失败' })
    } finally {
      setBusy(false)
    }
  }

  function clear() {
    setCfg(clearLlmConfig())
    setMsg({ ok: true, text: '已清除本机密钥' })
  }

  return (
    <>
      <div className="section-title">AI 设置</div>
      <div className="card">
          <p className="card-note" style={{ marginTop: 0 }}>
            密钥由你自己填写，<b>只存这台手机</b>，不上传、不打进安装包。
            兼容 OpenAI 的 /chat/completions 协议（OpenAI、DeepSeek、通义、Moonshot、自建网关等）。
            ⚠️ 不要在公用 / 共享设备上填写密钥。
          </p>

        <label className="field">
          <span>Base URL（到 /v1 这一层）</span>
          <input
            value={cfg.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder="https://api.openai.com/v1"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>

        <label className="field">
          <span>API Key</span>
          <div className="ai-key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={cfg.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder="sk-..."
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button className="btn btn-sm" type="button" onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
        </label>

        <label className="field">
          <span>模型名</span>
          <input
            value={cfg.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder="gpt-4o-mini"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>

        <div className="ai-actions">
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={save} disabled={busy}>
            保存
          </button>
          <button className="btn" onClick={test} disabled={busy}>
            {busy ? '测试中…' : '测试连接'}
          </button>
          <button className="btn" onClick={clear} disabled={busy}>
            清除
          </button>
        </div>

        {msg ? (
          <div className={'callout ' + (msg.ok ? 'teal' : 'danger')} style={{ marginTop: 'var(--space-3)' }}>
            {msg.text}
          </div>
        ) : null}

        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          未配置时，AI 分析入口只会提示去设置，不会用规则结果冒充模型回复。
        </p>
      </div>
    </>
  )
}

/* ---------------- AI 对话 ---------------- */
const QUICK_QUESTIONS = [
  '结合当前数据，这只基金的主要风险是什么？',
  '现在的位置适合加仓、持有还是观察？说明理由。',
  '用三句话解释它的最深跌意味着什么。',
]

function buildSystemPrompt(ctx) {
  const rules = [
    '你是一名严谨的基金分析助手。必须遵守：',
    '1) 只使用用户提供的数据回答，数据缺失就明确说「缺这项数据」，绝不编造数字；',
    '2) 不给出买卖指令，只给关注点、风险与需要复核的条件；',
    '3) 用简体中文，分点作答，尽量短。',
  ]
  if (ctx && Object.keys(ctx).length > 0) {
    rules.push('用户提供的当前基金/持仓数据（JSON）：')
    rules.push(JSON.stringify(ctx, null, 0))
  }
  return rules.join('\n')
}

/**
 * @param {{context?: object, compact?: boolean}} props
 *   context 会作为 system prompt 的数据部分（如基金名称/位置/趋势/下跌/仓位）
 */
export function AiChatPanel({ context = null }) {
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const configured = hasLlmConfig()

  async function send(text) {
    const q = String(text ?? input).trim()
    if (!q || busy) return
    if (!hasLlmConfig()) {
      setErr('还没有配置 API Key，请先到「我的 → AI 设置」填写')
      return
    }
    const next = [...msgs, { role: 'user', content: q }]
    setMsgs(next)
    setInput('')
    setBusy(true)
    setErr('')
    try {
      const reply = await chatCompletion({
        messages: [{ role: 'system', content: buildSystemPrompt(context) }, ...next],
      })
      setMsgs([...next, { role: 'assistant', content: reply }])
    } catch (e) {
      setErr(e?.message || '请求失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="section-title">AI 分析</div>
      <div className="card">
        {!configured ? (
          <div className="callout warn">
            还没有配置大模型。请到「我的 → AI 设置」填入你自己的 API Key，
            配置后这里会基于当前基金的真实数据回答。密钥只存本机。
          </div>
        ) : null}

        {msgs.length === 0 ? (
        <p className="card-note" style={{ marginTop: 0 }}>
          基于当前基金数据提问。模型只使用这里提供的数据，缺数据会直接说明，不编造。
          分析时会把当前基金/持仓数据发送到你配置的 AI 接口（不会发任何厂商后台）。
        </p>
        ) : (
          <div className="ai-thread">
            {msgs.map((m, i) => (
              <div className={'ai-msg ' + (m.role === 'user' ? 'ai-msg-user' : 'ai-msg-assistant')} key={i}>
                <span className="ai-msg-role">{m.role === 'user' ? '你' : 'AI'}</span>
                <div className="ai-msg-body">{m.content}</div>
              </div>
            ))}
            {busy ? <div className="ai-msg ai-msg-assistant"><span className="ai-msg-role">AI</span><div className="ai-msg-body">正在思考…</div></div> : null}
          </div>
        )}

        {msgs.length === 0 ? (
          <div className="chip-row" style={{ marginTop: 'var(--space-3)' }}>
            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q}
                className="chip"
                style={{ border: 0, cursor: 'pointer' }}
                onClick={() => send(q)}
                disabled={busy}
              >
                {q}
              </button>
            ))}
          </div>
        ) : null}

        <div className="ai-input-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="问点什么…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') send()
            }}
            disabled={busy}
          />
          <button className="btn btn-primary" onClick={() => send()} disabled={busy || !input.trim()}>
            发送
          </button>
        </div>

        {err ? (
          <div className="callout danger" style={{ marginTop: 'var(--space-3)' }}>
            {err}
          </div>
        ) : null}

        <p className="card-note" style={{ marginTop: 'var(--space-3)' }}>
          模型输出仅供判断参考，不构成投资建议。密钥只在发请求时带上，不落日志。
        </p>
      </div>
    </>
  )
}
