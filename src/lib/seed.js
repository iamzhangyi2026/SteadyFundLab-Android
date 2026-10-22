// src/lib/seed.js · 内置种子数据（秒开）
// ------------------------------------------------------------
// 目的：首次安装 / 清数据后打开 App，发现页与详情页不等网络就能出数。
// 做法：把候选池基金最近 250 个交易日的净值序列随包打进 seed.json，
//       启动时写进 navCache（已有缓存的不覆盖），页面首屏直接用。
//
// 种子随版本更新：发版前跑 `node tools/gen-seed.mjs` 重新生成。
// 边界：只覆盖候选池基金（自选/持仓是用户自己的数据，不预置）。
//       种子是「快照」，不是最新价 —— 页面会在后台用真实数据刷新并覆盖。

import SEED from './seed.json'
import { saveNavCache, loadNavCache } from './navCache.js'

const APPLIED_KEY = 'seed_applied_v1'

/** 种子元信息（版本 / 只数 / 生成时间），用于界面说明与排查 */
export function seedMeta() {
  const funds = SEED?.funds || {}
  return {
    version: SEED?.version || '',
    generatedAt: SEED?.generated_at || '',
    count: Object.keys(funds).length,
    codes: Object.keys(funds),
  }
}

/** 日期字符串 → 当天 0 点时间戳（与 fmtNavDate 的本地时区口径一致） */
function tsOf(date) {
  const t = Date.parse(`${date}T00:00:00`)
  return Number.isFinite(t) ? t : null
}

/**
 * 取某只基金的种子数据，结构对齐 fetchFund 的返回
 * （netWorth / accWorth 都是 [{x: 时间戳, y: 值}]）
 * @param {string} code
 * @returns {{code:string,name:string,netWorth:Array,accWorth:Array,rate:null,sourceRate:null}|null}
 */
export function seedFund(code) {
  const one = SEED?.funds?.[code]
  if (!one || !Array.isArray(one.series) || one.series.length === 0) return null

  const netWorth = []
  const accWorth = []
  for (const p of one.series) {
    const x = tsOf(p.date)
    if (x == null || !Number.isFinite(Number(p.nav))) continue
    netWorth.push({ x, y: Number(p.nav) })
    if (Number.isFinite(Number(p.acc_nav))) accWorth.push({ x, y: Number(p.acc_nav) })
  }
  if (netWorth.length === 0) return null

  return {
    code,
    name: one.name || code,
    netWorth,
    accWorth,
    rate: null,
    sourceRate: null,
    minBuy: null,
    /* 种子没有重仓股字段，给空数组 —— 下游直接取 .length，undefined 会在渲染时抛错 */
    stockCodes: [],
    fromSeed: true,
  }
}

/** 种子里所有基金的净值序列（供预抓取跳过已覆盖的） */
export function seedCodes() {
  return Object.keys(SEED?.funds || {})
}

/**
 * 把种子写入 navCache（幂等，只写一次；已有缓存的不覆盖）
 * 在渲染前调用，同步完成，耗时在毫秒级。
 * @returns {{applied:boolean, wrote:number}}
 */
export function applySeed() {
  try {
    if (localStorage.getItem(APPLIED_KEY) === SEED?.version) {
      return { applied: false, wrote: 0 }
    }
  } catch {
    return { applied: false, wrote: 0 }
  }

  let wrote = 0
  for (const code of seedCodes()) {
    // 用户已经抓过真实数据的不覆盖（真实数据永远优先于种子快照）
    if (loadNavCache(code)) continue
    const one = SEED.funds[code]
    // 传 source:'seed'：让缓存被记成「发版快照」而非「刚抓过」，
    // 后台预抓取才会把它真正再抓一遍。
    if (saveNavCache(code, one.series, { source: 'seed' })) wrote++
  }

  try {
    localStorage.setItem(APPLIED_KEY, SEED?.version || '1')
  } catch {
    // 忽略
  }
  return { applied: true, wrote }
}
