/**
 * 基金数据抓取 —— 纯前端，零后端。
 *
 * 数据源：天天基金 pingzhongdata 接口
 *
 * 为什么用 <script> 标签而不是 fetch：
 *   该接口返回的是一段 JS 变量赋值（var fS_name = "..."），
 *   用 <script> 加载后变量会挂到 window 上，天然绕过 CORS。
 *   这是纯客户端方案能成立的关键支点——不需要服务器做代理。
 *
 */

const CACHE = new Map()

/**
 * 抓某只基金的 pingzhongdata（净值历史 / 累计净值 / 费率 / 名称）
 * 用 script 标签注入绕过 CORS；同一 code 的内存缓存命中后不再请求。
 * @param {string} code 6 位基金代码
 * @returns {Promise<{code:string,name:string,netWorth:Array,accWorth:Array,rate:number,sourceRate:number}>}
 */
export function fetchFund(code) {
  if (CACHE.has(code)) return Promise.resolve(CACHE.get(code))

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`
    script.charset = 'utf-8'

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('请求超时（12 秒）'))
    }, 12000)

    function cleanup() {
      clearTimeout(timer)
      script.remove()
    }

    script.onload = () => {
      try {
        // ⚠️ 接口返回的数组不保证按日期升序，显式排序，不依赖接口顺序。
        const netWorth = [...(window.Data_netWorthTrend || [])].sort(
          (a, b) => a.x - b.x
        )
        // ⚠️ 两个数组格式不一样：
        //   Data_netWorthTrend = [{x, y, equityReturn, unitMoney}, ...]  对象数组
        //   Data_ACWorthTrend  = [[时间戳, 累计净值], ...]               数组的数组
        // 不归一化的话累计净值的 d.y 恒为 undefined，区间涨幅会算成 NaN 渲染到界面。
        const accWorth = (window.Data_ACWorthTrend || [])
          .map((item) => (Array.isArray(item) ? { x: item[0], y: item[1] } : item))
          .sort((a, b) => a.x - b.x)

        const data = {
          code: window.fS_code,
          name: window.fS_name,
          sourceRate: parseFloat(window.fund_sourceRate), // 原始费率（%）
          rate: parseFloat(window.fund_Rate),             // 折后费率（%）
          minBuy: window.fund_minsg,
          netWorth,   // [{ x: 时间戳, y: 单位净值, equityReturn: 日涨幅, unitMoney: 分红 }]
          accWorth,   // [{ x: 时间戳, y: 累计净值 }]
          stockCodes: window.stockCodes || [],
        }

        CACHE.set(code, data)
        cleanup()
        resolve(data)
      } catch (e) {
        cleanup()
        reject(e)
      }
    }

    script.onerror = () => {
      cleanup()
      reject(new Error('接口不可达'))
    }

    document.head.appendChild(script)
  })
}

/** 从净值序列里取最新一条 */
export function latestNetWorth(netWorth) {
  if (!netWorth || netWorth.length === 0) return null
  return netWorth[netWorth.length - 1]
}

/** 时间戳 → 本地时区日期。
 *  style 'iso'：YYYY-MM-DD；style 'short'：MM/DD。
 *  ⚠️ 不能用 toISOString()——它输出 UTC，接口的时间戳是北京时间零点，
 *     直接转会把日期显示成前一天。 */
export function fmtNavDate(ts, style = 'iso') {
  if (ts == null) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  if (style === 'short') return `${p(d.getMonth() + 1)}/${p(d.getDate())}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 日涨跌幅（%）—— 用最近两个交易日的单位净值算 */
export function dayChange(netWorth) {
  if (!netWorth || netWorth.length < 2) return null
  const last = netWorth[netWorth.length - 1]
  const prev = netWorth[netWorth.length - 2]
  const a = Number(prev.y)
  const b = Number(last.y)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null
  return ((b - a) / a) * 100
}

/** 取最近 n 个点的净值序列，用于画迷你走势 */
export function recentSeries(netWorth, n = 60) {
  if (!netWorth || netWorth.length === 0) return []
  return netWorth.slice(-n).map((d) => Number(d.y)).filter(Number.isFinite)
}

/** 统计区间涨幅（%）—— 用累计净值算，这是历史表现口径 */
export function rangeReturn(accWorth, days) {
  if (!accWorth || accWorth.length < 2) return null
  const last = accWorth[accWorth.length - 1]
  const cutoff = last.x - days * 86400000
  const start = accWorth.find((d) => d.x >= cutoff) || accWorth[0]
  if (!start) return null
  // 显式校验：脏数据一律返回 null，绝不把 NaN 渲染到界面上
  const a = Number(start.y)
  const b = Number(last.y)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null
  return ((b - a) / a) * 100
}
