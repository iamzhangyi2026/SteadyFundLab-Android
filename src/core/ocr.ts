// src/core/ocr.ts · 本地 OCR（Tesseract.js WASM）
//
// 目的：识别持仓截图 → 文本 → 解析出「基金代码 / 名称 / 份额 / 金额 / 收益率」。
// 全部资源（worker + core + chi_sim 语言包）**打包在 APP 内**（public/tesseract/），
// **离线运行、不联网、不调用任何 key**。
//
// 原则：识别不出的不猜；低置信度交给用户确认。

import { createWorker, type Worker } from 'tesseract.js'

/** 打包在 APP 内的 tesseract 资源目录（WebView 根 = https://localhost/） */
const TESS_BASE = '/tesseract/'

let _workerPromise: Promise<Worker> | null = null
let _progressCb: ((progress: number, status: string) => void) | null = null

/** 注册识别进度回调（0~1 + 状态文案），用于 UI 显示进度 */
export function setOcrProgress(cb: ((progress: number, status: string) => void) | null): void {
  _progressCb = cb
}

/** 惰性创建 worker（首次会加载 core + 语言包，约几秒；之后复用） */
function _getWorker(): Promise<Worker> {
  if (!_workerPromise) {
    _workerPromise = createWorker('chi_sim', 1, {
      workerPath: TESS_BASE + 'worker.min.js',
      corePath: TESS_BASE,
      langPath: TESS_BASE,
      // ⚠️ gzip:false —— 语言包用**未压缩**的 chi_sim.traineddata。
      //   原因：Android 打包器会把 .gz 资产解压并**去掉后缀**（APK 里变 chi_sim.traineddata），
      //   再去取 .traineddata.gz 会 404。故直接放未压缩文件。
      gzip: false,
      logger: (m: { progress?: number; status?: string }) => {
        if (_progressCb) _progressCb(Number(m?.progress ?? 0), String(m?.status ?? ''))
      },
    }).then(async (w) => {
      // 识别参数调优：
      //   - preserve_interword_spaces：保留词间空格 → 持仓列表「名称 金额 收益率」分列更稳；
      //   - user_defined_dpi：跳过 Tesseract 的 DPI 估计（日志里的 "Estimating resolution as 405"），省时间。
      //   （PSM 保持默认 3 —— PSM 6 差异极小，PSM 11 虽置信度高但会拆行且认错字。）
      try {
        await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' })
      } catch { /* 参数不被支持时忽略，不影响识别 */ }
      return w
    })
  }
  return _workerPromise
}

/** OCR 整体超时（毫秒）。超过即判定卡死，避免 UI 永久假死。 */
const OCR_TIMEOUT_MS = 45000

/** Promise 超时包装：到时 reject，绝不永久挂起 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s），请换清晰小图重试`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

/** 主线程解码图片为 Image 元素（dataURL / objectURL 都可） */
function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败，换一张试试'))
    img.src = src
  })
}

/**
 * 主线程把图缩放到最长边 ≤ maxSide，并做**灰度 + 对比度拉伸**预处理，返回 canvas。
 * 预处理目的：提速 + 提高中文识别率。
 *  - 缩放：降低 WASM 负担，规避大图 OOM / 极慢。
 *  - 灰度：三通道 → 单通道，Tesseract 内部少一步转换（略提速）。
 *  - 对比度拉伸：截图多为浅灰底 / 彩色底 + 细笔画，直接喂给 Tesseract 中文识别率低；
 *    取灰度直方图 2%~98% 分位做线性拉伸，拉开笔画与背景的差距（**不做二值化**，避免丢浅色字）。
 *  - 预处理失败不影响识别（退回原图）。
 */
function scaleToCanvas(img: HTMLImageElement, maxSide = 2400): HTMLCanvasElement {
  const w0 = img.naturalWidth || img.width
  const h0 = img.naturalHeight || img.height
  if (!w0 || !h0) throw new Error('图片尺寸为 0')
  const scale = Math.min(1, maxSide / Math.max(w0, h0))
  const w = Math.max(1, Math.round(w0 * scale))
  const h = Math.max(1, Math.round(h0 * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  ctx.drawImage(img, 0, 0, w, h)
  try {
    const imgData = ctx.getImageData(0, 0, w, h)
    const d = imgData.data
    const hist = new Uint32Array(256)
    for (let i = 0; i < d.length; i += 4) {
      hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++
    }
    const total = w * h
    let lo = 0
    let hi = 255
    let acc = 0
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break } }
    acc = 0
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break } }
    const range = Math.max(1, hi - lo)
    const lut = new Uint8ClampedArray(256)
    for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round((v - lo) * 255 / range)))
    // 深色模式截图（深底浅字）→ 反色成「浅底深字」。
    //   Tesseract 按「黑字白底」训练，深底截图识别率会崩。用灰度直方图**众数**（面积最大者 = 背景）
    //   判断底色：背景偏暗（<128）→ 反色。必须在拉伸**之后**反色（拉伸已把字压向 0、底拉向 255）。
    let bgVal = 255
    let bgCnt = -1
    for (let v = 0; v < 256; v++) { if (hist[v] > bgCnt) { bgCnt = hist[v]; bgVal = v } }
    const invert = bgVal < 128
    for (let i = 0; i < d.length; i += 4) {
      let g = lut[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]
      if (invert) g = 255 - g
      d[i] = g
      d[i + 1] = g
      d[i + 2] = g
    }
    ctx.putImageData(imgData, 0, 0)
  } catch { /* 预处理失败 → 用原图 */ }
  return canvas
}

/**
 * 识别一张图 → 纯文本。失败返回 { ok:false }，不造假。
 * 注意：dataURL / Blob 在 **Web Worker 内部解码常挂起**（Capacitor WebView 已知坑，
 * 既不 resolve 也不 reject），故此处不把 dataURL 透传给 worker。
 * 先在主线程把图缩成 canvas，再传给 recognize —— worker 拿到的是已解码的 ImageData，
 * 绕开 worker 内 dataURL 解码挂起。再加超时与失败重置，杜绝永久假死。
 */
export async function recognizeImage(
  image: string | Blob | HTMLCanvasElement,
  onProgress?: (progress: number, status: string) => void,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (typeof onProgress === 'function') setOcrProgress(onProgress)
  try {
    const worker = await _getWorker()
    let input: string | Blob | HTMLCanvasElement = image
    // dataURL / Blob → 主线程缩图成 canvas（关键修复）
    if (typeof image === 'string' || image instanceof Blob) {
      const url = typeof image === 'string' ? image : URL.createObjectURL(image)
      try {
        const img = await loadImageElement(url)
        input = scaleToCanvas(img, 2400)
      } finally {
        if (typeof image !== 'string') URL.revokeObjectURL(url)
      }
    }
    const { data } = await withTimeout(worker.recognize(input), OCR_TIMEOUT_MS, '识别')
    return { ok: true, text: data?.text ?? '' }
  } catch (e) {
    // worker 创建/识别失败 → 清空缓存，下次重建（避免一次失败永久坏）
    _workerPromise = null
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  } finally {
    setOcrProgress(null)
  }
}

/** 释放 worker（退出导入流程时调用，回收内存） */
export async function disposeOcr(): Promise<void> {
  if (!_workerPromise) return
  try {
    const w = await _workerPromise
    await w.terminate()
  } catch { /* ignore */ }
  _workerPromise = null
}

// ─── 文本 → 持仓候选 ────────────────────────────────────────

export interface ParsedHolding {
  /** 6 位基金代码（识别到才有） */
  code: string | null
  /** 基金名称候选（去掉数字/符号后的中文串） */
  name: string | null
  /** 份额 */
  shares: number | null
  /** 金额（¥/元 后面的数） */
  amount: number | null
  /** 收益率 % */
  pct: number | null
  /** 原始行（便于用户核对） */
  raw: string
}

// 基金名称常见关键词（用于判断这一行像不像"基金"）
const FUND_KW = /(混合|指数|联接|ETF|LOF|FOF|QDII|债券|纯债|货币|股票|基金|成长|价值|消费|医药|科技|新能源|军工|白酒|半导体|芯片|沪深|中证|上证|深证|创业板|国债|增强|稳健|优选|精选|灵活配置|量化|红利|蓝筹|黄金|纳指|标普|恒生|港股|海外|卫星|因子|行业|主题|制造|信息|汽车|电力|银行|证券|保险|地产|基建|农业|食品|饮料|家电|传媒|通信|计算机|电子|机械|化工|有色|煤炭|石油|钢铁|建材|环保|旅游|教育|医疗|生物|创新|高端|先进|智能|数字|互联|大数据|碳中和|ESG|养老|退休|平衡|配置|回报|增长|优势|龙头|领先|前沿|未来|新兴|战略|产业|经济|全球|国际|美国|欧洲|日本|亚洲|国企|央企|改革|转型|升级|低波|质量|动量|估值|回报|竞争力)/

// 明显不是基金名的词
const NON_FUND_KW = /(持仓|收益|金额|明细|总资产|昨日|今日|累计|市值|成本|份额|净值|涨跌|日期|时间|合计|小计|操作|详情|更多|全部|加载|暂无|我的|账户|设置|首页|买入|卖出|赎回|确认|取消|备注|说明|提示|风险|免责|广告|客服|版本|登录|注册|排行|榜单|热门|推荐|自选|关注|搜索)/

/**
 * 判断一行「像不像基金名称」——含 ≥4 个连续中文，且不含明显非基金词。
 * 比「只认 6 位代码或基金关键词」更宽：OCR 把名称认错字（如「混合」→「混台」）
 * 仍能进候选；若最终匹配不到库里基金，只显示「未匹配」，不会误导入（安全）。
 */
function looksLikeFundName(line: string): boolean {
  if (NON_FUND_KW.test(line)) return false
  return /[\u4e00-\u9fa5]{4,}/.test(line)
}

/**
 * 从 OCR 文本里抽「持仓候选」。逐行处理：
 *  - 含 6 位数字 → 视为基金代码
 *  - 含基金关键词的中文串 → 视为基金名称候选
 *  - `¥123.45` / `123.45元` → 金额；`+1.23%` → 收益率；`123.45份` → 份额
 */
export function parseHoldingsFromText(text: string): ParsedHolding[] {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const out: ParsedHolding[] = []
  const seen = new Set<string>()

  const num = (s?: string | null): number | null => {
    if (s == null) return null
    const n = parseFloat(String(s).replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  const grabCode = (l: string) => l.match(/(?<!\d)(\d{6})(?!\d)/)?.[1] ?? null
  // 份额：`818.33份/股` 或 `持有份额 818.33`
  // **先匹配带标签的「份额 346.16」**，再退到「346.16份」；
  //   否则「008888 份额 346.16」里 `\s*(?:份|股)` 会吃掉中间空格，把**基金代码**当成份额。
  const grabShares = (l: string) =>
    num(l.match(/(?:持有份额|份额|持仓份额|可用份额)\s*[:：]?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/)?.[1])
    ?? num(l.match(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:份|股)(?!额)/)?.[1])
  // 兼容 OCR 把小数点读成逗号（如「+10,00%」/「454,23」）——只认「.」会匹配不到正确 pct
  //   （掉成 0 或 null）→ 收益口径退化。故小数分隔符 [,.] 都认。
  const grabPct = (l: string) => {
    const m = l.match(/([+-]?\d+(?:[.,]\d+)?)\s*%/)
    return m ? num(m[1].replace(/,/g, '.')) : null
  }
  // 表格行兜底：持仓列表截图常把「净值 / 持有金额 / 持仓收益 / 收益率 / 日涨幅」并排成一行，
  //   数字**没有文字标签** → 上面关键词式的 grabAmount 抓不到（识别结果可能全为 null，
  //   连唯一「已匹配」的基金也因「没识别到份额也没识别到金额」被跳过）。
  //   依据恒等式「收益率% = 持仓收益 ÷ (持有金额 − 持仓收益) × 100」在行内数字中找**唯一自洽**的
  //   (金额, 收益) 对 → 返回金额。多解或无解一律返回 null（**不猜**）。
  const grabAmountByPct = (l: string, pctVal: number | null): number | null => {
    if (pctVal == null || Math.abs(pctVal) < 0.01) return null
    const nums = (l.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g) || [])
      .map(s => parseFloat(s.replace(/,/g, '')))
      .filter(n => Number.isFinite(n) && n !== 0)
    if (nums.length < 2) return null
    const hits = new Set<number>()
    for (const m of nums) {
      for (const p of nums) {
        if (m === p) continue
        const base = m - p
        if (base <= 0) continue
        if (Math.abs((p / base) * 100 - pctVal) < 0.05) hits.add(m)
      }
    }
    return hits.size === 1 ? [...hits][0] : null
  }
  // 金额：`¥1,234.56` 或 `持有金额 1000.00` / 市值 / 成本；都抓不到时走「收益率自洽」兜底
  const grabAmount = (l: string) =>
    num(l.match(/[¥￥]\s*(\d+(?:,\d{3})*(?:\.\d+)?)/)?.[1])
    ?? num(l.match(/(?:持有金额|金额|持仓金额|市值|持有市值|持仓市值|成本)\s*[:：]?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/)?.[1])
    ?? grabAmountByPct(l, grabPct(l))

  // ⚠️ 截图里「基金名+代码」与「份额/金额/收益」常分列在多行 →
  //    按**块**聚合：遇到基金行开新块，后续非基金行把份额/金额/收益并进来。
  let cur: ParsedHolding | null = null
  const flush = () => {
    if (cur && (cur.code || cur.name)) {
      const k = (cur.code || '') + '|' + (cur.name || '')
      if (!seen.has(k)) { seen.add(k); out.push(cur) }
    }
    cur = null
  }

  for (const line of lines) {
    const code = grabCode(line)
    const hasKw = FUND_KW.test(line)
    // 开块条件放宽 —— 含 6 位代码 / 含基金关键词 / 「像基金名」（≥4 连续中文且非噪声词）
    const nameLike = looksLikeFundName(line)
    // 合并「名称行 + 数据行」—— 截图里基金名与「代码 / 份额 / 金额」常分两行（支付宝即如此），
    //   原逻辑会把它们拆成两块 → 同一只基金出两条（一条靠名称匹配、一条靠代码匹配），既乱又可能重复导入。
    //   规则：当前块已有名称但还没代码，而本行只有代码/数字（没有新名称）→ 并入当前块，不新开。
    if (cur && cur.name && !cur.code && code && !hasKw && !nameLike) {
      cur.code = code
      cur.shares = cur.shares ?? grabShares(line)
      cur.amount = cur.amount ?? grabAmount(line)
      cur.pct = cur.pct ?? grabPct(line)
      cur.raw = cur.raw + ' | ' + line
      continue
    }
    if (code || hasKw || nameLike) {
      flush()   // 收上一块，开新块
      const nameCand = line
        // 引号 / 书名号等 OCR 噪声也一并去掉（名称可能被识别成「华夏国证半导体芯片 ”」→ 匹配失败）
        .replace(/[¥￥%+\-.,:：/()（）[\]【】"“”'‘’`《》〈〉<>「」『』]/g, ' ')
        .replace(/\d+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      cur = {
        code,
        name: (hasKw || nameLike) && nameCand.length >= 2 ? nameCand.slice(0, 30) : null,
        shares: grabShares(line),
        amount: grabAmount(line),
        pct: grabPct(line),
        raw: line,
      }
    } else if (cur) {
      // 续行：把份额/金额/收益并进当前块（已有则不覆盖）
      cur.shares = cur.shares ?? grabShares(line)
      cur.amount = cur.amount ?? grabAmount(line)
      cur.pct = cur.pct ?? grabPct(line)
      cur.raw = cur.raw + ' | ' + line
    }
  }
  flush()
  return out
}
