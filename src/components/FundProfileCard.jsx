// src/components/FundProfileCard.jsx · 基金档案（C8）
// ------------------------------------------------------------
// 基金经理 / 评级 / 投资风格。数据来自 fund_profile.js（24h 缓存）。
// 取不到的字段如实显示「暂无」，不编造姓名或星级。
// 投资风格公开接口没有可靠字段，固定标注「未提供」。

import { useEffect, useState } from 'react'
import { fetchFundProfile } from '../lib/fund_profile.js'

export default function FundProfileCard({ code }) {
  const [p, setP] = useState(null)

  useEffect(() => {
    if (!code) return
    let alive = true
    setP(null)
    fetchFundProfile(code)
      .then((r) => alive && setP(r))
      .catch(() => alive && setP({ manager: null, rating: null, styleBox: null }))
    return () => {
      alive = false
    }
  }, [code])

  if (!p) {
    return (
      <div className="card">
        <div className="skeleton" style={{ height: 18, width: '40%', marginBottom: 10 }} />
        <div className="skeleton" style={{ height: 14, width: '70%' }} />
      </div>
    )
  }

  const manager = Array.isArray(p.manager) ? p.manager : []
  const first = manager[0]
  const rating = p.rating

  return (
    <div className="card">
      <div className="da-row">
        <span className="da-row-k">基金经理</span>
        <span className="da-row-v">
          <b>{first ? first.name : '暂无'}</b>
          <small>
            {first
              ? [
                  first.startDate ? `任职 ${first.startDate}` : null,
                  manager.length > 1 ? `共 ${manager.length} 位` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '任职信息未提供'
              : '公开接口未返回经理信息'}
          </small>
        </span>
      </div>
      <div className="da-row">
        <span className="da-row-k">评级</span>
        <span className="da-row-v">
          <b>{rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '暂无'}</b>
          <small>{rating ? `${rating} 星（接口口径）` : '接口未返回评级，不用推测值代替'}</small>
        </span>
      </div>
      <div className="da-row">
        <span className="da-row-k">投资风格</span>
        <span className="da-row-v">
          <b>未提供</b>
          <small>公开接口无可靠的「大盘/中小盘 × 价值/成长」字段，不猜</small>
        </span>
      </div>
    </div>
  )
}
