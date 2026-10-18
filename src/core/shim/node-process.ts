// src/core/shim/node-process.ts
// 为 Vite WebView 打包提供的 node:process 空 stub：
// 一些自检代码 (ledger.ts:573 / rules.ts 底部) 会 typeof process !== 'undefined'，
// 在浏览器环境 process 不存在；置空对象即可避免 vite externalize 报错
export const process: { argv?: string[]; env?: Record<string, string> } = {}
export default process