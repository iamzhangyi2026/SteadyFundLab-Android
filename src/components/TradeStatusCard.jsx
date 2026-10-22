// src/components/TradeStatusCard.jsx · 交易状态与限购额度卡
// ------------------------------------------------------------
// 展示申购/赎回状态、起购金额与单日上限。数据来自 lib/trade_status.js 的
// **状态字段**（SGZT / SHZT / BUY），不是按日历推算的。
// 状态未知时如实写「未知」，不猜成开放。

import Stat from './Stat.jsx'
import { buyGate, sellGate, stateLabel } from '../lib/trade_status.js'
import { effectiveSubmitDay, confirmDayStr, isCoveredYear } from '../lib/trade_days.js'

export default function TradeStatusCard({ st }) {
  const buy = buyGate(st)
  const sell = sellGate(st)
  // 按当前北京时间推算「提交生效日 → 预计确认日」，让卡内与详情页一致
  const submitDay = effectiveSubmitDay()
  const confirmDate = st?.buyConfirmDays ? confirmDayStr(submitDay, st.buyConfirmDays) : null
  // 日历只含 2026，落在表外年份时 T+n 推算只是「只排周末」近似，需提示
  const outOfTable = !isCoveredYear(submitDay)
  return (
    <>
      <div className="section-title">交易状态</div>
      <div className="card">
        <div className="stat-grid">
          <Stat k="申购" v={stateLabel(buy.state)} cls={buy.state === 'closed' ? 'down' : undefined} />
          <Stat k="赎回" v={stateLabel(sell.state)} cls={sell.state === 'closed' ? 'down' : undefined} />
          <Stat k="起购金额" v={st?.minBuy != null ? `${st.minBuy} 元` : '—'} />
          <Stat
            k="单日上限"
            v={st?.maxBuy != null ? `${st.maxBuy.toLocaleString('zh-CN')} 元` : '—'}
          />
        </div>
        {buy.ok === false || buy.ok === null ? (
          <p className="card-note" style={{ marginTop: 'var(--space-2)' }}>
            申购：{buy.text}
          </p>
        ) : null}
        {sell.ok === false || sell.ok === null ? (
          <p className="card-note" style={{ marginTop: 'var(--space-2)' }}>
            赎回：{sell.text}
          </p>
        ) : null}
        {st && (st.buyConfirmDays || st.redeemConfirmDays || st.redeemArriveDays || confirmDate) ? (
          <p className="card-note" style={{ marginTop: 'var(--space-2)' }}>
            确认与到账：
            {[
              st.buyConfirmDays ? `申购 T+${st.buyConfirmDays} 确认` : null,
              st.redeemConfirmDays ? `赎回 T+${st.redeemConfirmDays} 确认` : null,
              st.redeemArriveDays ? `T+${st.redeemArriveDays} 到账` : null,
              confirmDate ? `预计确认日 ${confirmDate}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        {outOfTable ? (
          <p className="card-note" style={{ marginTop: 'var(--space-2)' }}>
            日历数据仅含 2026，跨年推算仅供参考。
          </p>
        ) : null}
        {st?.redeemArrive ? (
          <p className="card-note" style={{ marginTop: 'var(--space-2)' }}>
            赎回到账：{st.redeemArrive}
          </p>
        ) : null}
        {!st ? (
          <p className="card-note" style={{ marginTop: 'var(--space-2)' }}>
            交易状态没抓到，下拉刷新可重试
          </p>
        ) : null}
      </div>
    </>
  )
}
