// src/components/FundNewsCard.jsx · 基金资讯卡（公告 + 重仓股新闻）
// ------------------------------------------------------------
// 资讯必须和这只基金挂钩 ——
// 抓基金自己的公告（人事/分红），再抓它前几大重仓股的新闻。
// 不抓宏观噪音，也不编造；拿不到就显示空态。

import { useEffect, useState } from 'react'
import { loadFundNews } from '../lib/fundNews.js'
import { buildEvents } from '../lib/intel.js'

/* 公告与新闻的链接都来自远端，直接塞进 href 会放行 javascript: 之类伪协议，
   这里统一做协议白名单，不合规的一律当纯文本渲染。 */
const SAFE_URL = /^https?:\/\//i
const safeUrl = (u) => {
  const s = String(u ?? '').trim()
  return SAFE_URL.test(s) ? s : undefined
}

export default function FundNewsCard({ code, name }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null })

  useEffect(() => {
    let alive = true
    setState({ status: 'loading', data: null, error: null })
    loadFundNews(code, { name })
      .then((r) => {
        if (!alive) return
        if (r.data) setState({ status: 'ok', data: r.data, error: null, cached: r.fromCache })
        else setState({ status: 'empty', data: null, error: r.error })
      })
      .catch((e) => alive && setState({ status: 'empty', data: null, error: e.message }))
    return () => {
      alive = false
    }
  }, [code, name])

  const { announcements = [], stockNews = [] } = state.data || {}
  const events = buildEvents(announcements)
  const eventTypes = Object.entries(events.counts).filter(([k]) => k !== '其他')

  return (
    <div className="news-card">
      <div className="watch-section-head">
        <div>
          <h2>资讯</h2>
        </div>
        {state.cached ? <span className="text-action" style={{ color: '#9aa298' }}>24 小时内已抓取</span> : null}
      </div>

      {state.status === 'loading' ? (
        <div className="card plain card-list">
          <div className="skeleton" style={{ height: 40 }} />
          <div className="skeleton" style={{ height: 40 }} />
          <div className="skeleton" style={{ height: 40 }} />
        </div>
      ) : state.status === 'empty' ? (
        <div className="card">
          <div className="empty">
            <div className="empty-title">暂未获取到资讯</div>
            <div className="empty-note">公告与重仓股新闻接口暂不可用，稍后再试</div>
          </div>
        </div>
      ) : (
        <>
          {announcements.length > 0 && (
            <>
              <div className="news-group-title">基金公告 · 公司官网 / 证监会披露</div>
              {state.data?.company ? (
                <p className="card-note" style={{ margin: '0 0 8px', lineHeight: 1.6 }}>
                  来源：{state.data.company}
                  {state.data.companySupported
                    ? state.data.companyMatched
                      ? '官网 + '
                      : '官网（近期公告里没有本基金条目）+ '
                    : '（官网源未接入）+ '}
                  证监会基金电子披露平台
                </p>
              ) : null}
              {eventTypes.length > 0 ? (
                <div className="chip-row" style={{ margin: '0 0 8px' }}>
                  {eventTypes.map(([t, n]) => (
                    <span className="chip" key={t}>
                      {t} {n}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="card plain card-list">
                {events.rows.map((a, i) => {
                  const link = safeUrl(a.url)
                  const RowTag = link ? 'a' : 'div'
                  return (
                    <RowTag
                      className="news-row"
                      key={`a${i}`}
                      {...(link ? { href: link, target: '_blank', rel: 'noreferrer' } : {})}
                    >
                      <span className="news-row-main">
                        <strong>{a.title}</strong>
                        <small>
                          {a.eventType !== '其他' ? (
                            <span className={'news-tag ' + (a.tone || '')}>{a.eventType}</span>
                          ) : null}
                          {a.date}
                        </small>
                      </span>
                      {link ? <span className="row-chevron">›</span> : null}
                    </RowTag>
                  )
                })}
              </div>
            </>
          )}

          {stockNews.length > 0 && (
            <>
              <div className="news-group-title">重仓股新闻</div>
              <div className="card plain card-list">
                {stockNews.map((n, i) => (
                  <a
                    className="news-row"
                    key={`n${i}`}
                    href={safeUrl(n.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="news-row-main">
                      <strong>{n.title}</strong>
                      <small>
                        <span className="news-tag">{n.related}</span>
                        {n.source ? `${n.source} · ` : ''}
                        {n.date}
                      </small>
                    </span>
                    <span className="row-chevron">›</span>
                  </a>
                ))}
              </div>
            </>
          )}

          {announcements.length === 0 && stockNews.length === 0 && (
            <div className="card">
              <div className="empty">
                <div className="empty-title">这只基金暂无相关资讯</div>
                <div className="empty-note">接口可用，但目前没有公告或重仓股新闻</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
