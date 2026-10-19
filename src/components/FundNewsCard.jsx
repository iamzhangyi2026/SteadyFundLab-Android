// src/components/FundNewsCard.jsx · 基金资讯卡（公告 + 重仓股新闻）
// ------------------------------------------------------------
// 资讯必须和这只基金挂钩 ——
// 抓基金自己的公告（人事/分红），再抓它前几大重仓股的新闻。
// 不抓宏观噪音，也不编造；拿不到就显示空态。

import { useEffect, useState } from 'react'
import { loadFundNews } from '../lib/fundNews.js'
import { buildEvents } from '../lib/intel.js'

export default function FundNewsCard({ code, name }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null })

  useEffect(() => {
    let alive = true
    setState({ status: 'loading', data: null, error: null })
    loadFundNews(code)
      .then((r) => {
        if (!alive) return
        if (r.data) setState({ status: 'ok', data: r.data, error: null, cached: r.fromCache })
        else setState({ status: 'empty', data: null, error: r.error })
      })
      .catch((e) => alive && setState({ status: 'empty', data: null, error: e.message }))
    return () => {
      alive = false
    }
  }, [code])

  const { announcements = [], stockNews = [] } = state.data || {}
  const events = buildEvents(announcements)
  const eventTypes = Object.entries(events.counts).filter(([k]) => k !== '其他')

  return (
    <div className="news-card">
      <div className="watch-section-head">
        <div>
          <span className="section-overline">NEWS &amp; NOTICE</span>
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
              <div className="news-group-title">基金公告</div>
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
                {events.rows.map((a, i) => (
                  <div className="news-row" key={`a${i}`}>
                    <span className="news-row-main">
                      <strong>{a.title}</strong>
                      <small>
                        {a.eventType !== '其他' ? (
                          <span className={'news-tag ' + (a.tone || '')}>{a.eventType}</span>
                        ) : null}
                        {a.date}
                      </small>
                    </span>
                  </div>
                ))}
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
                    href={n.url || undefined}
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
