/**
 * .vue 单文件组件语法/编译检查
 *
 * 项目里没有用 vue-tsc（uni-app 的全局类型要整套 SDK 才能对齐），
 * 但至少可以用 Vue 自带的 compiler-sfc 验证：
 *   模板语法、<script setup lang="ts"> 能否编译成 render/setup 函数。
 * 这能挡住 90% 的手误（标签没闭合、表达式写错、setup 语法错）。
 *
 * 用法：node scripts/check-sfc.cjs
 */

const fs = require('node:fs')
const path = require('node:path')
const sfc = require('@vue/compiler-sfc')

const ROOT = path.resolve(__dirname, '..')
const FILES = ['pages/gateway/index.vue', 'components/MiniChart.vue']

let failed = 0

for (const rel of FILES) {
  const file = path.join(ROOT, rel)
  const src = fs.readFileSync(file, 'utf8')

  const { descriptor, errors } = sfc.parse(src, { filename: file })
  if (errors.length) {
    failed++
    console.log(`FAIL  ${rel}`)
    for (const e of errors) console.log(`      parse: ${e.message || e}`)
    continue
  }

  const tpl = descriptor.template
    ? sfc.compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id: rel,
      })
    : { code: '', errors: [] }

  if (tpl.errors && tpl.errors.length) {
    failed++
    console.log(`FAIL  ${rel}`)
    for (const e of tpl.errors) console.log(`      template: ${e.message || e}`)
    continue
  }

  let scriptLen = 0
  try {
    const script = sfc.compileScript(descriptor, { id: rel })
    scriptLen = script.content.length
  } catch (e) {
    failed++
    console.log(`FAIL  ${rel}`)
    console.log(`      script: ${e.message}`)
    continue
  }

  console.log(`OK    ${rel}  (template ${tpl.code.length} chars, script ${scriptLen} chars)`)
}

console.log(failed === 0 ? '\nSFC CHECK: PASS' : `\nSFC CHECK: FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
