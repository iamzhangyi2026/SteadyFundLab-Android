/**
 * 「关于」页
 * ------------------------------------------------------------
 * 真实内容，不占位：应用信息 / 版本 / 数据来源 / 数据边界 / 免责声明。
 * 版本号与 build 读 Capacitor App.getInfo()（官方 API，无联网）。
 */

import { useEffect, useState } from 'react'
import { App } from '@capacitor/app'
import { isNative } from '../lib/platform.js'

const APP_VERSION = '2.17'

export default function About({ onBack }) {
  const [info, setInfo] = useState({ version: APP_VERSION, build: 0 })

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await App.getInfo()
        if (alive) {
          setInfo({
            version: r?.version || APP_VERSION,
            build: Number(r?.build) || 0,
          })
        }
      } catch {
        // 浏览器环境读不到，保留兜底值
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /* ⚠️ 这里刻意不套 .app-shell / .app-header / .app-body ——
     关于页是在 App 的 .app-body 里渲染的，再套一层就变成双标题栏 +
     嵌套滚动容器（页面滚不动，见 app.css 顶部注释）。这里只给内容。 */
  return (
    <>
      <div className="section-title">应用</div>
        <div className="card plain card-list">
          <Row k="名称" v="基金沙盒" />
          <Row k="版本" v={`${info.version}（build ${info.build || '—'}）`} />
          <Row k="包名" v="com.fundapp" />
          <Row k="运行环境" v={isNative() ? 'Android App' : '浏览器'} />
          <Row k="最低系统" v="Android 7.0" />
          <Row k="授权" v="开源，代码公开可查" />
        </div>

        <div className="section-title">这是什么</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            一个纯本地的基金分析工具，两套账本：
            ① 真实持仓 —— 记录你实际持有的基金，看估值、收益、深度分析；
            ② 练手池 —— 用虚拟资金模拟买卖，练筛选与决策。
            另有全市场估值洼地筛选、组合风险、目标规划、定投计划等工具。
          </p>
        </div>

        <div className="section-title">数据来源</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            净值、估值、排行、行业配置等来自天天基金 / 东方财富的公开接口；
            指数与 K 线来自腾讯行情。均为公开数据，只读请求，不携带你的持仓。
            数据抓不到时如实显示「暂不可用」，不编造。
          </p>
        </div>

        <div className="section-title">数据与隐私</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            不设账号、不上传数据、不做统计上报。持仓与自选只存在本机，
            卸载即清除。AI 分析需要你自己填 API 密钥，请求只发往你填的地址。
          </p>
        </div>

        <div className="section-title">免责声明</div>
        <div className="card">
          <p className="card-note" style={{ lineHeight: 1.8 }}>
            本 App 只做数据整理与分析展示，不构成投资建议。
            基金有风险，投资需谨慎；据此操作，盈亏自负。
          </p>
        </div>

      {onBack ? (
        <button className="btn btn-block" onClick={onBack}>
          返回
        </button>
      ) : null}
    </>
  )
}

function Row({ k, v }) {
  return (
    <div className="fund-row fund-row-static">
      <div className="fund-main">
        <div className="fund-name fund-name-normal">{k}</div>
      </div>
      <div className="fund-meta fund-meta-end">{v}</div>
    </div>
  )
}
