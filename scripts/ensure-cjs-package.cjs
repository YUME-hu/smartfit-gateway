#!/usr/bin/env node
/**
 * 在 tsc 产物目录写一个 {"type":"commonjs"} 的 package.json。
 *
 * 为什么需要：
 *   根目录与 web/ 的 package.json 都是 "type": "module"，而 build:test 用的
 *   tsconfig 是 "module": "CommonJS" —— tsc 输出的是 exports.* / require，
 *   但产物 .js 会被就近的 package.json 判成 ESM。于是 Node 22 走 require(ESM)
 *   路径直接 ReferenceError: exports is not defined（Node 20 是 ERR_REQUIRE_ESM）。
 *
 * 为什么不是改 tsconfig / 改测试：
 *   产物本身没错（CJS 是对的），出错的是"这段产物该按什么解析"。在产物目录放一个
 *   最小的 package.json 精确回答这个问题：测试与 src 一行都不用动，也不用换框架。
 *
 * 产物目录从 tsconfig 的 compilerOptions.outDir 读（extends 链交给 TypeScript
 * 自己解析），不硬编码路径 —— 以后改 outDir 这里会自动跟着走。
 *
 * 用法：
 *   根目录：node scripts/ensure-cjs-package.cjs tsconfig.build.json
 *   web/：  node ../scripts/ensure-cjs-package.cjs tsconfig.test.json
 */

const fs = require('node:fs')
const path = require('node:path')

const tsconfigArg = process.argv[2]
if (!tsconfigArg) {
  console.error('[ensure-cjs] 用法：node scripts/ensure-cjs-package.cjs <tsconfig.json>')
  process.exit(1)
}

let ts
try {
  // 从"调用方所在的 package"解析 typescript，而不是按脚本自身位置解析。
  // 原因：根 job 与 web job 各自只装自己的依赖（两次 npm ci），web job 里仓库根
  // 根本没有 node_modules —— 按脚本位置 require('typescript') 在 CI 会直接失败，
  // 而本地因为根 node_modules 存在恰好能过（这就是第一次 CI 只红 web job 的原因）。
  ts = require(require.resolve('typescript', { paths: [process.cwd(), __dirname] }))
} catch {
  console.error('[ensure-cjs] 找不到 typescript，请先在该目录 npm install')
  process.exit(1)
}

const tsconfigPath = path.resolve(process.cwd(), tsconfigArg)
const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (read.error) {
  const msg = ts.flattenDiagnosticMessageText(read.error.messageText, '\n')
  console.error(`[ensure-cjs] 读取 ${tsconfigArg} 失败：${msg}`)
  process.exit(1)
}

// 交给 TS 解析 extends 链：这里拿到的 outDir 已经是绝对路径
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(tsconfigPath))
const outDir = parsed.options.outDir
if (!outDir) {
  console.error(`[ensure-cjs] ${tsconfigArg} 里没有 compilerOptions.outDir，无法定位产物目录`)
  process.exit(1)
}

const marker = path.join(outDir, 'package.json')
const content = JSON.stringify({ type: 'commonjs' }, null, 2) + '\n'

fs.mkdirSync(outDir, { recursive: true })

// 内容一致就不重写，避免每次 build 都抖动 mtime
const prev = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null
if (prev !== content) fs.writeFileSync(marker, content)

console.log(`[ensure-cjs] ${path.relative(process.cwd(), marker)} ← {"type":"commonjs"}`)
