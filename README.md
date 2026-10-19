# 基金沙盒 · 移动端

以「账户」为主轴的基金投资组合管理工具（安卓端）。**纯客户端架构**：Capacitor + React 19 + Vite，零后端依赖，所有计算与数据存储都在手机上完成。

## 两套互相隔离的系统

- **真实持仓**：OCR 导入持仓截图（tesseract.js 本机离线识别，不联网）→ 实时估值 / 实时涨跌 / 当日收益 / 持仓收益
- **模拟持仓（练手）**：本金自设的虚拟持仓，买入 / 撤单 / 定投 / 费率 / 到账时序与真实市场一致

两套系统账本互相隔离，风控与纪律线只对真实持仓生效。

## 主要功能

- **持仓**：真实持仓总览、OCR 导入、手动记账、收益统计
- **自选 / 发现**：候选池、估值分位（历史位置）、趋势筛选
- **基金详情**：净值 / 费率 / 持仓 / 档案 / 资讯 / 深度分析（指标 + 回撤 + 分位）
- **对比 / 筛选 / 行情**：多基金同屏对比、条件筛选、大盘指数与板块热力图
- **定投计划 / 目标规划 / 分红跟踪**
- **预警中心**：涨跌预警 / 净值预警 / 估值洼地 / 再平衡提醒
- **AI 面板**：基金解读与问答，OpenAI 兼容接口，Key 由用户自填、只存本机
- **隐私门控**：首次进入需同意隐私政策；通知权限由用户主动开启
- **深色模式**：design tokens 全局变量化，跟随系统或手动切换

## 数据来源

天天基金 / 腾讯财经 / 东方财富公开接口（真实源，非模拟）。请求限速、失败退避；抓不到就标「数据缺失」，绝不造假。

## 技术栈

- Capacitor 8 + React 19 + Vite 8（纯前端，无数据库依赖，localStorage 本地存储）
- tesseract.js 离线 OCR（中文语言包随包）
- @capgo/capacitor-updater 热更新框架（默认关闭，见 src/lib/config.js）
- 原生插件：APK 自更新安装（android/app/src/main/java/com/fundapp/）

## 构建与运行

环境要求：Node 20+ / JDK 21 / Android SDK（compileSdk 36，minSdk 24）

```bash
npm install
npm run build          # vite 构建 → dist/
npx cap sync android   # 同步进安卓工程
cd android
./gradlew assembleDebug    # 调试包
./gradlew assembleRelease  # 发布包（复用 AGP 默认 debug keystore 签名，可直接侧载安装）
```

产物：`android/app/build/outputs/apk/`

当前版本：versionCode 23 / versionName 2.2，包名 com.fundapp。

## 远端能力配置（默认全关）

热更新清单、安装包清单、统计上报三个地址统一在 `src/lib/config.js`，默认均为空串 = 不发起任何远端请求。接入自己的分发端点后填对应 URL 即可启用；统计上报仅在用户同意隐私政策后开启。

## 数据与隐私

全部数据存本机，不上传任何服务端。AI Key、持仓、交易记录只存在于本机存储。

## License

MIT，见 [LICENSE](LICENSE)。
