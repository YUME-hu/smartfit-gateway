/**
 * GitHub Actions workflow 语法检查
 *
 * 为什么需要：workflow 写错在本地不会报错，只有推上去跑 CI 才知道，
 * 而且失败信息往往指向 YAML 之外的地方。这里用 js-yaml 解析一遍，
 * 顺便检查必需的结构（jobs、steps 的 run/uses）。
 *
 * 用法：node scripts/check-workflow.cjs
 */

const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, '.github/workflows/build-apk.yml')

let failed = 0
function fail(msg) {
  failed++
  console.log('FAIL  ' + msg)
}

let doc
try {
  doc = yaml.load(fs.readFileSync(FILE, 'utf8'))
  console.log('OK    YAML 解析通过')
} catch (e) {
  console.log('FAIL  YAML 解析失败: ' + e.message)
  process.exit(1)
}

if (!doc.name) fail('缺少 name')
if (!doc.on) fail('缺少 on 触发器')
if (!doc.jobs || Object.keys(doc.jobs).length === 0) fail('缺少 jobs')

for (const [name, job] of Object.entries(doc.jobs || {})) {
  if (!job['runs-on']) fail(`${name}: 缺少 runs-on`)
  const steps = job.steps || []
  if (steps.length === 0) fail(`${name}: 没有 steps`)
  for (const [i, s] of steps.entries()) {
    if (!s.run && !s.uses) fail(`${name}.steps[${i}]: 既没有 run 也没有 uses`)
    if (s.uses && !/^[\w-]+\/[\w-]+(@|$)/.test(s.uses)) {
      fail(`${name}.steps[${i}]: uses 格式可疑 -> ${s.uses}`)
    }
  }
  console.log(`OK    job "${name}"  ${steps.length} steps`)
}

console.log(failed === 0 ? '\nWORKFLOW CHECK: PASS' : `\nWORKFLOW CHECK: FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
