// src/core/shim/node-url.ts
// 为 Vite WebView 打包提供的 node:url 空 stub：
// rules.ts / ledger.ts 的 _selfTest 路径会用到 pathToFileURL；
// 但生产 bundle 不需要，置空即可
export function pathToFileURL(_p: string): { href: string } {
  return { href: '' }
}
export function fileURLToPath(_u: string): string {
  return ''
}