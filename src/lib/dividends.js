// src/lib/dividends.js · 分红跟踪（C13 独立视图）
// ------------------------------------------------------------
// 聚合「真实持仓基金」的分红公告：分红 / 收益分配 / 派息。
// 数据来自 loadFundNews 的公告（24h 缓存），只报标题与日期 ——
// 每份金额公开接口不保证有，拿不到就不显示，不编。
//
// 公告源在部分网络环境下会被限流，失败的那只基金直接跳过，
// 界面上标注「部分基金暂未取到」，不假装完整。

import { loadFundNews } from './fundNews.js'

/**
 * @param {Array} holdings 真实持仓账本行
 * @returns {Promise<{rows:Array<{code,name,title,date}>, failed:number}>}
 */
export async function collectDividends(holdings) {
  const list = (holdings || []).filter((r) => r.code)
  if (list.length === 0) return { rows: [], failed: 0 }

  let failed = 0
  const pairs = await Promise.all(
    list.map(async (r) => {
      try {
        const res = await loadFundNews(r.code)
        const anns = res?.data?.announcements || []
        return anns
          .filter((a) => /分红|收益分配|派息/.test(a.title || ''))
          .map((a) => ({
            code: r.code,
            name: r.name || r.code,
            title: a.title,
            date: a.date || '',
          }))
      } catch {
        failed++
        return []
      }
    }),
  )

  const rows = pairs
    .flat()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))

  return { rows, failed }
}
