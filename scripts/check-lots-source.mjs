#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════
// 结构隔离机检
//
// 规则：任何 `FROM lots` 查询都必须显式声明 source 条件，否则"真实持仓"
//       与"交易盘虚拟持仓"会被混算 —— 风控止损会建立在假组合上。
//
// 允许的写法：
//   ... AND l.source = 'real'          // 真钱止损 / 真实组合统计
//   ... AND l.source = 'trade'         // 交易盘账本
//   ... AND l.source IN ('real','trade')  // 需要并集时（须注明理由）
//
// 用法：node scripts/check-lots-source.mjs   （退出码 0=通过 / 1=发现裸查）
// ══════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

const ROOT = 'src'
const EXTS = new Set(['.ts', '.js', '.jsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'android'])
const WINDOW = 9 // 一条 SQL 语句通常跨行，向后看 9 行判定 source 条件

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (EXTS.has(extname(p))) out.push(p)
  }
  return out
}

const violations = []
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 跳过注释行（说明文字里的 "FROM lots" 不是查询）
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    if (!/from\s+lots\b/i.test(line)) continue
    const block = lines.slice(i, i + WINDOW).join(' ')
    // 通过判据 1：语句块里显式出现 source 条件
    if (/source\s*(=|<>|!=|IS|IN)/i.test(block)) continue
    // 通过判据 2：本次查询就是「取 source 列本身」（如分红再投跟随原持仓 source）
    if (/select\s+source\s+from\s+lots/i.test(block)) continue
    violations.push(relative('.', file) + ':' + (i + 1) + '  ' + line.trim())
  }
}

if (violations.length) {
  console.error('')
  console.error('✗ 结构隔离机检失败：以下 FROM lots 查询未显式声明 source 条件')
  console.error('')
  for (const v of violations) console.error('  ' + v)
  console.error('')
  console.error('  共 ' + violations.length + ' 处裸查。')
  console.error("  规则：真钱风控/真实组合统计 → source='real'；交易盘账本 → source='trade'；")
  console.error("        确需并集 → source IN ('real','trade') 并在代码里注明理由。")
  console.error('')
  process.exit(1)
}

console.log('✓ 结构隔离机检通过：所有 FROM lots 查询均显式声明 source 条件')
