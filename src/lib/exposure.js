// src/lib/exposure.js · 基金行业穿透分析
// ------------------------------------------------------------
// 「分析方法」不只是给几个数字，而是**有判断、有结论**：
//   ① 行业配置：这只基金的钱实际压在哪些行业（季报口径）
//   ② 集中度：最大单一行业占净值是否超过阈值（默认 50%）
//   ③ 风格漂移：名字宣称的方向 vs 实际持仓占比（「XX消费精选」实际消费只占 12% → 名不副实）
//   ④ 人读叙述：把上面三条翻译成一句普通人看得懂的话
//
// 数据源：东财基金行业配置接口（季报口径）。
// 抓不到就返回空，不编。

const CACHE_PREFIX = 'fund_exposure_v3_' // 带版本号：判断逻辑变更后旧缓存要作废
const CACHE_TTL = 24 * 60 * 60 * 1000 // 季报口径，缓存一天足够

/** 名称关键词 → 行业 */
const NAME_INDUSTRY_HINTS = [
  { keywords: ['消费', '内需'], industry: '消费' },
  { keywords: ['医药', '医疗', '生物'], industry: '医药' },
  { keywords: ['科技', '创新', '成长', '新兴'], industry: '科技' },
  { keywords: ['新能源', '光伏', '锂电'], industry: '新能源' },
  { keywords: ['半导体', '芯片', '集成电路'], industry: '半导体' },
  { keywords: ['军工', '国防', '安全'], industry: '军工' },
  { keywords: ['金融', '银行', '证券'], industry: '金融' },
  { keywords: ['农业', '食品', '白酒'], industry: '农业食品' },
]

/** 单一行业占净值超过这个比例算「集中」 */
const CONCENTRATION_WARN_PCT = 50
/** 名称宣称方向的实际占比低于这个比例算「漂移」 */
const DRIFT_WARN_PCT = 50

async function getText(url, timeoutMs = 10000) {
  const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fundf10.eastmoney.com/' },
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
    const d = res?.data
    return typeof d === 'string' ? d : d == null ? '' : JSON.stringify(d)
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

/**
 * 基金行业配置：取**最新一期报告**的行业占比。
 * ⚠️ 接口一次返回多个报告期，不筛会算出重复且矛盾的行业占比
 *    （有的基金返回 42 条，混了 2025 和 2024 两期）。
 * @returns {Promise<{allocation: Array<{industry, weight}>, reportDate: string}>}
 */
export async function fetchIndustryAllocation(code) {
  const year = new Date().getFullYear()
  const url = `https://api.fund.eastmoney.com/f10/HYPZ/?fundCode=${code}&year=${year}`
  try {
    const raw = await getText(url)
    const quarters = JSON?.parse(raw)?.Data?.QuarterInfos ?? []
    if (quarters.length === 0) return { allocation: [], reportDate: '' }

    // 取报告期最新的那一期（JZRQ 形如 2026-06-30 这类报告期日期）
    const latest = quarters.reduce((a, b) => (String(a.JZRQ) >= String(b.JZRQ) ? a : b))
    const rows = latest?.HYPZInfo ?? []
    const merged = {}
    for (const r of rows) {
      const ind = String(r.HYMC ?? '').trim()
      const w = parseFloat(String(r.ZJZBL ?? ''))
      if (!ind || !Number.isFinite(w)) continue
      merged[ind] = (merged[ind] || 0) + w
    }
    const allocation = Object.entries(merged)
      .map(([industry, weight]) => ({ industry, weight: Math.round(weight * 100) / 100 }))
      .sort((a, b) => b.weight - a.weight)
    return { allocation, reportDate: String(latest.JZRQ ?? '') }
  } catch {
    return { allocation: [], reportDate: '' }
  }
}

/** 行业穿透：行业配置 + 集中度判断（analyze_exposure） */
export async function analyzeExposure(code) {
  const { allocation, reportDate } = await fetchIndustryAllocation(code)
  if (allocation.length === 0) return { allocation: [], reportDate: '', topIndustry: '', topWeight: 0, concentrated: false }
  const top = allocation[0]
  return {
    allocation,
    reportDate,
    topIndustry: top.industry,
    topWeight: top.weight,
    concentrated: top.weight >= CONCENTRATION_WARN_PCT,
  }
}

/** 风格漂移：名字宣称的方向 vs 实际持仓（detect_style_drift） */
export function detectStyleDrift(fundName, allocation) {
  const name = String(fundName || '')
  let hint = null
  for (const h of NAME_INDUSTRY_HINTS) {
    if (h.keywords.some((kw) => name.includes(kw))) {
      hint = h
      break
    }
  }
  if (!hint) {
    return { claimed: null, verdict: 'unknown', actualPct: 0, drifted: false, note: '名字里没有明确的行业指向' }
  }
  /* 用宣称行业的关键词去匹配实际行业名。
     ⚠️ 匹配不到时要**收手**：东财的行业分类很粗，白酒股归在「制造业」下、
     银行归在「金融业」下，名称里的「白酒」「银行」在行业名里根本找不到。
     这种情况下硬下「漂移」结论，就是把口径差异说成基金名不副实 —— 不编。 */
  const matched = allocation.filter((a) => hint.keywords.some((kw) => a.industry.includes(kw)))
  if (matched.length === 0) {
    return {
      claimed: hint.industry,
      verdict: 'unknown',
      actualPct: 0,
      drifted: false,
      note: '持仓的行业分类与名字用词对不上（如白酒归在制造业），对不上就不下结论',
    }
  }
  const actual = matched.reduce((s, a) => s + a.weight, 0)
  return {
    claimed: hint.industry,
    verdict: actual < DRIFT_WARN_PCT ? 'drifted' : 'consistent',
    actualPct: Math.round(actual * 100) / 100,
    drifted: actual < DRIFT_WARN_PCT,
  }
}

/** 把穿透结果翻译成人话（build_narrative 的单基金部分） */
export function buildFundNarrative({ fundName, exposure, drift }) {
  const paras = []
  if (!exposure?.allocation?.length) {
    paras.push('这只基金暂未披露行业配置（季报还没更新），穿透分析跳过。')
    return paras
  }
  paras.push(
    `${fundName} 的行业配置（截至 ${exposure.reportDate || '最新报告期'}）：` +
      exposure.allocation
        .slice(0, 3)
        .map((a) => `${a.industry} ${a.weight}%`)
        .join('、') +
      '。',
  )
  if (exposure.concentrated) {
    paras.push(
      `⚠️ 集中度：最大单一行业「${exposure.topIndustry}」占 ${exposure.topWeight}%，已超过 ${CONCENTRATION_WARN_PCT}% 阈值 —— 这个行业的波动会直接主导这只基金。`,
    )
  } else {
    paras.push(
      `✅ 集中度：最大单一行业「${exposure.topIndustry}」占 ${exposure.topWeight}%，未超过 ${CONCENTRATION_WARN_PCT}% 阈值，行业分布相对分散。`,
    )
  }
  if (drift?.claimed) {
    if (drift.verdict === 'drifted') {
      paras.push(
        `⚠️ 名不副实：名字写着「${drift.claimed}」，实际持仓里这个方向只占 ${drift.actualPct}% —— 不能按名字理解这只基金。`,
      )
    } else if (drift.verdict === 'consistent') {
      paras.push(
        `✅ 名副其实：名字写着「${drift.claimed}」，实际持仓里这个方向占 ${drift.actualPct}%。`,
      )
    } else {
      paras.push(`ⓘ ${drift.note} —— 这一项不下结论。`)
    }
  }
  return paras
}

/** 一次拿全：行业穿透 + 漂移 + 叙述。带 24h 本地缓存。 */
export async function analyzeFundIndustry(code, fundName) {
  const key = CACHE_PREFIX + code
  let hit = null
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const obj = JSON.parse(raw)
      if (Date.now() - obj.at < CACHE_TTL) hit = obj.value
    }
  } catch {
    // 缓存读失败就重抓
  }
  if (hit) return hit

  const exposure = await analyzeExposure(code)
  const drift = detectStyleDrift(fundName, exposure.allocation)
  const narrative = buildFundNarrative({ fundName, exposure, drift })
  const value = { exposure, drift, narrative }
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), value }))
  } catch {
    // 存满就算了
  }
  return value
}
