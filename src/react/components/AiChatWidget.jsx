import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'
// AI 回复可能带 markdown 星号；Inline 只做「**加粗**」，其余原样，防星号外露
import { Inline } from '../lib/textLayout'
import { setPendingTrade } from '../lib/pendingAction'

// 右下角 金融小管家浮窗：
// - 收起态是一个固定右下角的圆形 icon
// - 点击后以「弹窗由小变大」的同一节奏展开成圆角毛玻璃对话框
// - 对话走本地配置的 LLM 服务（OpenAI 兼容接口，密钥存本机设置）

const WELCOME = {
  role: 'ai',
  text: '智能助手来咯',
}

// 快捷问题：手机上没有键盘流习惯，点一下就问，不用打字。
const QUICK_QUESTIONS = [
  '今天有什么推荐',
  '我的持仓怎么样',
  '债券基金能买吗',
]

/**
 * 调 AI。优先级：
 *   ① 本机已配置的 LLM（设置 → AI 配置）
 *   ② 本地兜底分析（不是指路话术，而是读本地库出真实分析结论，AI 离线时兜底）
 */
async function _askAi(text, history) {
  // ① 本机 LLM
  try {
    const mod = await import('../lib/dataAdapter')
    const r = await mod.jsLlmSimpleChat(text, '')
    if (r && r.ok && r.data) return r.data
  } catch { /* 走本地兜底 */ }

  return await _localFallback(text)
}

/** 本地兜底：问推荐/候选 → 引用每日兜底分析结论；其余说清「当前状态 + 数据在哪看」 */
async function _localFallback(text) {
  const t = String(text || '')
  if (/推荐|买什么|候选|哪些基金|可以买|洼地|筛选/.test(t)) {
    try {
      const mod = await import('../lib/dataAdapter')
      const r = await mod.jsLatestFallbackAnalysis()
      if (r && r.ok && r.data) {
        const fa = r.data
        const day = String(fa.ts || fa.as_of || '').slice(0, 10)
        if (fa.candidates && fa.candidates.length) {
          const lines = fa.candidates.slice(0, 5).map((c, i) =>
            `${i + 1}. **${c.fund_name}**（${c.fund_code}）：评分 ${c.score ?? '—'}，历史位置 ${c.percentile}%，` +
            `近1年 ${c.ret_1y > 0 ? '+' : ''}${c.ret_1y}%，最大跌幅 ${c.max_dd ?? '—'}%`)
          return `【兜底分析 · ${day}】${fa.conclusion}\n\n候选：\n${lines.join('\n')}\n\n风险点：\n${(fa.risks || []).map(x => '· ' + x).join('\n')}`
        }
        return `【兜底分析 · ${day}】${fa.conclusion}`
      }
    } catch { /* 落到指路文案 */ }
  }
  if (/持仓|仓位|我的基金|买了/.test(t)) {
    return '本次由本地兜底回答：持仓与今日/昨日收益在「持仓」页；想买卖或看单只基金详情，去「交易」页选中该基金。'
  }
  if (/净值|收益|涨|跌|估值/.test(t)) {
    return '本次由本地兜底回答：基金的最新净值与收益——真实持仓在「持仓」页，想下单或看单只在「交易」页选中查看。'
  }
  if (/纪律|止损|止盈|回撤/.test(t)) {
    return '本次由本地兜底回答：提醒规则由本机每天自动检查一次，结果出现在「持仓」页的「今天该怎么办」。'
  }
  return '智能助手通道尚未接入（本机没有可用的智能服务）。当前本地能力：持仓与当日/昨日收益、基金净值与收益、提醒规则与操作建议、每日兜底分析（问「今天有什么推荐」可看）、资讯与情报。'
}

// AI 只产出文字建议，不创建订单。
// 「去交易」按钮只做**预填**（基金 + 建议金额 + 理由摘要），最后一步永远是人改数量 + 按「确认」。
function _extractFundCode(text) {
  const m = String(text || '').match(/(?<!\d)\d{6}(?!\d)/)
  return m ? m[0] : null
}
function _extractAmount(text) {
  const m = String(text || '').match(/(\d[\d,]{2,}(?:\.\d+)?)\s*元/)
  if (!m) return null
  const v = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(v) && v > 0 ? v : null
}
function _gotoTradeWithSuggestion(text) {
  const code = _extractFundCode(text)
  if (!code) return
  setPendingTrade({ code, amount: _extractAmount(text), reason: String(text).slice(0, 80) })
  try { window.dispatchEvent(new Event('fundapp:goto-trade')) } catch { /* 忽略 */ }
  setTimeout(() => {
    try { window.dispatchEvent(new Event('fundapp:fund-trade')) } catch { /* 忽略 */ }
  }, 80)
}

function Fab({ onClick }) {
  return (
    <button
      className="ai-chat-fab"
      onClick={onClick}
      title="智能助手"
      aria-label="打开智能助手"
    >
      <Icon.ai className="ico" />
    </button>
  )
}

export default function AiChatWidget() {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [messages, setMessages] = useState([WELCOME])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef(null)

  const handleClose = useCallback(() => setClosing(true), [])

  const onAnimationEnd = useCallback(() => {
    if (closing) {
      setOpen(false)
      setClosing(false)
    }
  }, [closing])

  const sendText = useCallback(async (raw) => {
    const text = String(raw ?? '').trim()
    if (!text || loading) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text }])
    setLoading(true)
    try {
      // 把本会话已聊过的内容作为 history 带上
      const history = messages
        .filter((m) => m.text !== '智能助手来咯')
        .map((m) => ({ role: m.role, content: m.text }))
      const reply = await _askAi(text, history)
      setMessages((m) => [...m, { role: 'ai', text: reply }])
    } catch (e) {
      setMessages((m) => [...m, { role: 'ai', text: '发送失败，请稍后重试' }])
    } finally {
      setLoading(false)
    }
  }, [loading, messages])

  const onSend = useCallback(() => sendText(input), [sendText, input])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, open])

  if (!open) {
    return createPortal(<Fab onClick={() => setOpen(true)} />, document.body)
  }

  return createPortal(
    <div
      className={`ai-chat-widget ${closing ? 'closing' : ''}`}
      role="dialog"
      aria-label="智能助手"
      onAnimationEnd={onAnimationEnd}
    >
      <div className="ai-chat-header">
        <span className="ai-chat-title">
          <Icon.ai className="ico" />
          <span>智能助手</span>
        </span>
        <button className="ai-chat-close" onClick={handleClose} aria-label="关闭">
          <Icon.close className="ico" />
        </button>
      </div>

      <div className="ai-chat-body">
        {messages.map((m, i) => (
          <div key={i} className={`ai-chat-bubble ${m.role}`}>
            <Inline text={m.text} />
            {/* 11 AI 开放：真 AI（非本地兜底）的建议里带基金代码 → 出「去交易」预填按钮。
                兜底回复只做指路，不出交易按钮。 */}
            {m.role === 'ai'
              && !/兜底|本地兜底/.test(m.text)
              && _extractFundCode(m.text)
              && (
                <button
                  type="button"
                  className="ai-quick-chip"
                  style={{ marginTop: 8, width: '100%' }}
                  onClick={() => _gotoTradeWithSuggestion(m.text)}
                >
                  去交易（按此建议预填，金额可改）
                </button>
              )}
          </div>
        ))}
        {loading && (
          <div className="ai-chat-bubble ai">
            <span className="ai-chat-typing">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
          </div>
        )}
        {/* 快捷问题：只在还没聊过时展示，点一下就发出（手机端不想打字） */}
        {messages.length <= 1 && !loading && (
          <div className="ai-chat-quick">
            {QUICK_QUESTIONS.map((q) => (
              <button key={q} type="button" className="ai-quick-chip" onClick={() => sendText(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="ai-chat-footer">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSend() }}
          placeholder="输入问题…"
          disabled={loading}
        />
        <button
          className="btn btn-sm btn-primary"
          onClick={onSend}
          disabled={!input.trim() || loading}
          aria-label="发送"
        >
          <Icon.play className="ico" style={{ width: 14, height: 14 }} />
        </button>
      </div>
    </div>,
    document.body
  )
}
