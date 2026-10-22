// src/lib/watchlist.js · 自选列表（人工可增删 + 算法动态生成）
// ------------------------------------------------------------
// 两类来源，分开标注：
//   - algo   算法动态生成：跑全市场三轨筛选（近1年>0、位置<50%、下跌<50%，
//            即项目 screen_rules 定义的「标准」），把达标的、综合分靠前的基金
//            列出来。数量不固定——达标几个列几个，最多 ALGO_OPTS.limit 只。
//            每次点「更新」重算，离线时保留上次结果。
//   - manual 用户手动添加（标「人工」），用户完全掌控增删与标签。
//
// 存储结构：
//   [{ code, name, tag, source:'algo'|'manual', score?, reasons?, created_at }]
// 算法条目由 recomputeAlgo 生成并写入；旧版本写死的 4 只（source=algo 且无
// score 字段）会在首次检测到时由算法结果整体替换，不再写死任何样本。

import { fetchFundRank, enrichHistory, screenRows, scoreOf } from './screener.js'

const KEY = 'watchlist_v1'

/** 算法自选参数：候选池取全市场近1年前 N 只，补历史指标前 M 只，最终列前 L 只 */
export const ALGO_OPTS = { rankSize: 50, enrichSize: 20, limit: 12 }

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/**
 * 读取自选列表。
 * 不再写死样本：首次无数据时返回空数组，算法列表由 recomputeAlgo 生成，
 * 人工列表由用户添加。旧版本写死的 4 只（source=algo 且无 score）会在
 * recomputeAlgo 时被整体替换。
 */
export function loadWatch() {
  const cur = read()
  if (cur) return cur
  return []
}

/**
 * 算法自选：跑全市场三轨筛选，返回达标且综合分靠前的基金。
 * 标准（对齐项目 screen_rules）：近1年>0、历史位置<50%、最深跌<50%。
 * 数量不固定——达标几个列几个，最多 limit 只。
 * @returns {Promise<Array<{code,name,tag,source,score,reasons,created_at}>>}
 */
export async function computeAlgoCandidates(opts = {}) {
  const { rankSize = ALGO_OPTS.rankSize, enrichSize = ALGO_OPTS.enrichSize, limit = ALGO_OPTS.limit } = opts
  let rows = []
  try {
    const r = await fetchFundRank({ sort: '1nzf', order: 'desc', size: rankSize, page: 1 })
    rows = r?.rows || []
  } catch {
    return null
  }
  // 排行都拿不到 = 接口失败，不是「真 0 只达标」——必须返回 null，
  // 否则调用方会把空结果当成功、把已有算法条目全部抹掉。
  if (!rows.length) return null
  let enriched = []
  try {
    enriched = await enrichHistory(rows.slice(0, enrichSize))
  } catch {
    return null
  }
  const passed = screenRows(enriched)
  return passed
    .map((r) => {
      const score = scoreOf(r)
      const reasons = []
      if (r.percentile != null && r.percentile < 50) reasons.push('洼地')
      if (r.y1 != null && r.y1 > 0) reasons.push('近1年正')
      if (r.maxDrawdown != null && Math.abs(r.maxDrawdown) < 50) reasons.push('下跌可控')
      return { r, score, reasons }
    })
    .filter((x) => x.score != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({
      code: x.r.code,
      name: x.r.name || '',
      tag: x.reasons.includes('洼地') ? '洼地' : '达标',
      source: 'algo',
      score: x.score,
      reasons: x.reasons,
      created_at: new Date().toISOString(),
    }))
}

/**
 * 重算算法自选并合并进存储：保留人工条目，整体替换算法条目。
 * 计算失败（如离线）返回 null，且不破坏已有算法条目——上次结果仍可见。
 * @returns {Promise<Array|null>}
 */
export async function recomputeAlgo(opts = {}) {
  let algoItems
  try {
    algoItems = await computeAlgoCandidates(opts)
  } catch {
    return null
  }
  // [] 是「真的 0 只达标」，null 才是失败。只有失败才不写库，
  // 否则会把上次的算法结果整体抹成空。
  if (algoItems == null) return null
  const list = loadWatch()
  const manual = list.filter((w) => w.source === 'manual')
  const next = [...manual, ...algoItems]
  write(next)
  return next
}

/**
 * 是否需要重算算法列表：无算法条目，或算法条目是旧版写死样本（无 score）。
 * @param {Array} list loadWatch() 的结果
 */
export function needsAlgoCompute(list) {
  const algo = (list || []).filter((w) => w.source === 'algo')
  if (algo.length === 0) return true
  return algo.some((w) => w.score == null)
}

/**
 * 添加自选（按 code 去重）。
 * @param {{code:string, name?:string, tag?:string, source?:'algo'|'manual'}} item
 * @returns {{ok:boolean, reason?:'exists'|'storage'|'invalid'}}
 */
export function addWatch({ code, name = '', tag = '', source = 'manual' }) {
  const c = String(code || '').trim()
  if (!/^\d{6}$/.test(c)) return { ok: false, reason: 'invalid' }
  const list = loadWatch()
  if (list.some((w) => w.code === c)) return { ok: false, reason: 'exists' }
  list.push({
    code: c,
    name: name || '',
    tag: tag || '',
    source: source === 'algo' ? 'algo' : 'manual',
    created_at: new Date().toISOString(),
  })
  return write(list) ? { ok: true } : { ok: false, reason: 'storage' }
}

/** 移除自选（按 code） */
export function removeWatch(code) {
  const list = loadWatch()
  const next = list.filter((w) => w.code !== code)
  if (next.length === list.length) return false
  return write(next)
}

/** 修改自选（标签 / 名称） */
export function updateWatch(code, patch = {}) {
  const list = loadWatch()
  const i = list.findIndex((w) => w.code === code)
  if (i < 0) return false
  list[i] = {
    ...list[i],
    ...(patch.tag != null ? { tag: String(patch.tag).slice(0, 8) } : {}),
    ...(patch.name != null ? { name: String(patch.name) } : {}),
  }
  return write(list)
}

/** 某基金是否在自选里 */
export function inWatch(code) {
  return loadWatch().some((w) => w.code === code)
}
