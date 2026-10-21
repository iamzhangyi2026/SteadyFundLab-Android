# 基金沙盒 (Fund Sandbox)

纯客户端的基金分析与原型推演移动端应用。所有数据均保存在本机，不涉及真实资金、不向任何服务器上报个人持仓。

## 技术栈

- [Capacitor 8](https://capacitorjs.com/) + React 19 + Vite
- [tesseract.js](https://github.com/naptha/tesseract.js) 本地 OCR，用于识别截图中的基金数据
- 内置种子数据（`src/lib/seed.json`）：首次启动不等网络即可渲染发现页与详情页

## 功能

- 四个主页面：**自选 / 发现 / 持仓 / 我的**，外加基金详情、对比、筛选、行情、模拟持仓等二级页
- 本地持仓与模拟持仓：按当前单位净值折算份额，纯推演，不动真钱
- 涨跌预警、红点提醒、本地通知、基金公告
- 隐私门 + 通知权限门：同意隐私政策前不发起任何网络请求、不开任何上报

## 隐私

- 用户数据从生成到存储全程在手机上，不上云
- 配置自有大模型后，AI 分析对话会把当前基金/持仓数据发往你填写的接口——这是数据离开本机的唯一通道
- 详见应用内「隐私政策」页

## 构建

```bash
npm install
npm run build                # vite 构建前端
npx cap sync android         # 同步到安卓原生工程
cd android && ./gradlew assembleRelease   # 打 release 包（复用 AGP 默认 debug 签名，可直接安装）
```

## 许可

MIT
