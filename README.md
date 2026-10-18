# fund-app · 基金沙盒（Android）

以「账户」为主轴的基金投资组合管理工具（安卓端）。
**纯前端架构**：Capacitor + React 18 + TypeScript + @capacitor-community/sqlite。
零后端依赖 —— 所有计算与数据落库都在客户端完成。

## 定位

两套**互相隔离**的系统：

1. **真实持仓系统** —— OCR 导入真实持仓截图 → 实时估值 / 实时涨跌 / 当日收益 / 持仓收益。
2. **交易系统** —— 本金自设的虚拟持仓，下单 / 撤单 / 定投 / 费率 / 到账时序与真实市场一致。

核心能力：**估值洼地 + 趋势向上** 双维度筛选（四轨覆盖全市场基金池）。

## 技术栈

| 层 | 选型 |
|---|---|
| 容器 | Capacitor 6（Android WebView） |
| UI | React 18 + Tailwind 3 + ECharts（按需引入） |
| 状态 | Zustand |
| 本地库 | @capacitor-community/sqlite |
| 网络 | CapacitorHttp / 原生 NativeHttp 插件（绕过 WebView CORS 限制） |
| OCR | tesseract.js（本机离线识别，语言包/核心随包，无需下载） |

## 项目结构

```
fund-app/
├── android/                  # Capacitor Android 原生工程
├── dist/                     # Vite 构建产物（git 忽略，cap copy 时生成）
├── public/
│   └── tesseract/            # 离线 OCR 资源（tesseract.js 核心 + 中文语言包）
├── scripts/
│   ├── check-lots-source.mjs # 构建前机检：lots 查询必须显式声明 source
│   └── sql_audit.py          # SQL 列名 vs 建表 schema 自审
├── src/
│   ├── core/                 # 核心业务 TS（与 UI 解耦，可独立跑验证）
│   │   ├── ledger.ts         # FIFO 批次账本（成交/市值/浮盈，单位净值口径）
│   │   ├── fees.ts           # 申购/赎回费（外扣法；罚期门槛唯一来源）
│   │   ├── budget.ts         # 现金账本 + 预算快照
│   │   ├── orders.ts         # 下单 / 确认 / 到账时序（T+1、QDII T+2）
│   │   ├── calendar.ts       # 交易日历（内置 A 股 2026 表）
│   │   ├── status.ts         # 申购 / 赎回状态门控（四态）
│   │   ├── screen_rules.ts / screener.ts / analysis.ts   # 估值洼地四轨筛选
│   │   ├── alerts.ts         # 涨跌 / 净值预警提醒
│   │   ├── risk.ts / rebalance.ts / goal.ts              # 风险 / 再平衡 / 目标规划
│   │   ├── dividend.ts       # 分红跟踪
│   │   └── news.ts / rss_news.ts / intel_collector.ts    # 资讯与情报事件
│   ├── data/                 # 数据层
│   │   ├── init_app.ts       # 启动序列（种子 → 本地读 → 分层抓取）
│   │   ├── sqlite_schema.ts  # 建表（幂等，可重复执行）
│   │   ├── sqlite_adapter.ts # 真机 SQLite → LedgerDb 适配
│   │   ├── sqlite_fetcher.ts # 抓取（天天基金 / 腾讯 / 东财）
│   │   └── seed_funds.ts     # 预置种子基金（首装即可用）
│   └── react/                # React 前端
│       ├── App.jsx           # 入口 + Tab 路由 + 预警评估钩子
│       ├── MobileLayout.jsx  # 底部 4 Tab 导航 Shell
│       ├── views/            # 4 个 Tab 页：持仓 / 交易 / 分析 / 我的
│       ├── components/       # 业务组件（详情弹窗 / 对比 / 风险 / 目标 / 预警 …）
│       ├── hooks/            # useData（全局数据层 + 跨 Tab 导航）
│       ├── lib/              # dataAdapter.js（core↔UI 桥）、nav、scheduler、format …
│       ├── store/            # Zustand store
│       └── styles/           # tokens.css + app.css
├── capacitor.config.json
├── vite.config.js
├── tsconfig.json             # 类型检查配置（tsc --noEmit）
├── eslint.config.js          # ESLint 扁平配置
└── package.json
```

## 数据来源（真实源，非模拟）

| 用途 | 源 |
|---|---|
| 基金列表 / 净值 / 申赎状态 | 天天基金（主源 + `f10/lsjz` 备源） |
| 基金深度（能力评分 / 规模 / 资产配置 / 持有人） | 天天基金 `pingzhongdata/{code}.js` |
| 盘中实时估值 | 腾讯 `qt.gtimg.cn` |
| 指数日 K 线 | 腾讯 `fqkline`（备源：东财 `push2his`） |
| 板块资金流 | 东财 `push2` / `push2delay`（双源） |
| 资讯 | 东方财富 |

**抓取风控原则**：请求间隔 200–500ms / 失败指数退避 / 连续失败熔断 / 单只失败即跳过；
**抓不到就标「数据缺失」，绝不造假**。

## 开发

```bash
npm install
npm run typecheck   # TypeScript 类型检查（应 0 错误）
npm run lint        # ESLint（0 error；warning 为未使用变量提示）
npm run build       # Vite 构建（含 lots source 机检）
npx cap copy android
```

### 构建 APK

```bash
cd android
./gradlew assembleDebug     # 开发者版（含调试信息）
./gradlew assembleRelease   # 发布版（混淆 + 资源压缩）
```

### 安装到设备

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 环境要求

- Node.js 18+
- JDK 21
- Android SDK（版本见 `android/variables.gradle`）
- Android 设备（已开启 USB 调试）

## 数据口径约定（改代码前必读）

- 成交 / 市值 / 浮盈 → **单位净值 `nav`**；收益率 / 趋势 / 分位 / 回撤 → **累计净值 `acc_nav`**
- 申购费 **外扣法**（渠道折扣率已折后，勿二次打折）
- **FIFO 批次**，不可简化为平均成本；持有天数按**自然日**
- 15:00 截单；确认 T+1 / QDII T+2；到账：货币 T+1 / 债 T+2 / QDII·海外 T+5
- 交易门控看「申购 / 赎回状态」，**不推算日历**
- 管理费 / 托管费已含在净值中，**绝不重复计**
- 数据缺失 → 返回空并标「数据缺失」，**不造假数据**

## AI 配置

AI 功能采用「自带密钥」模式：在「设置 → AI 配置」填入任意 OpenAI 兼容服务的
base_url / model / api_key（默认指向智谱公开接口），密钥只存本机 SQLite，
不随包分发、不上传任何服务端。未配置时 AI 功能给出本地兜底回复。

## 许可

MIT
