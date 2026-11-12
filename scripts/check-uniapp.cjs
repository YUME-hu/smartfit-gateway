/**
 * uni-app 工程文件静态检查（HBuilderX 编译前能抓到的那类错误）
 *
 * 为什么需要：HBuilderX 只有真正点「运行」时才报错，而且报错信息往往指不到
 * 问题行。这个脚本把最容易错的三件事提前查掉：
 *   1. pages.json / manifest.json 是否是合法 JSON，路径是否指向真实文件
 *   2. 页面里所有相对 import 能否解析到真实文件（.ts / .js / .vue / index）
 *   3. manifest 里蓝牙与网络权限是否声明齐全
 *
 * 用法：node scripts/check-uniapp.cjs
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
let failed = 0

function ok(msg) {
  console.log('OK    ' + msg)
}
function fail(msg) {
  failed++
  console.log('FAIL  ' + msg)
}

function readJson(rel) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) {
    fail(`${rel} 不存在`)
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    fail(`${rel} 不是合法 JSON: ${e.message}`)
    return null
  }
}

// ---------------------------------------------------------------- pages.json
const pagesJson = readJson('pages.json')
if (pagesJson) {
  ok('pages.json 解析通过')
  const pages = pagesJson.pages || []
  if (pages.length === 0) fail('pages.json 里没有 pages')

  for (const p of pages) {
    const file = path.join(ROOT, p.path + '.vue')
    if (fs.existsSync(file)) {
      ok(`页面 ${p.path} → ${p.path}.vue`)
    } else {
      fail(`页面 ${p.path} 找不到对应文件 ${p.path}.vue`)
    }
  }

  const home = pages[0]
  if (home && home.style && home.style.navigationStyle === 'custom') {
    ok('首页 navigationStyle=custom（已去掉默认导航栏）')
  } else {
    fail('首页没有设置 navigationStyle: "custom"')
  }
}

// ---------------------------------------------------------------- manifest.json
const manifest = readJson('manifest.json')
if (manifest) {
  ok('manifest.json 解析通过')
  if (manifest.name) ok(`App 名称: ${manifest.name}`)
  else fail('manifest.json 缺少 name')

  if (manifest.appid) ok(`AppID: ${manifest.appid}`)
  else fail('manifest.json 缺少 appid')

  if (manifest.vueVersion === '3') ok('vueVersion = 3')
  else fail(`vueVersion 应为 "3"，实际 ${manifest.vueVersion}`)

  const perms =
    (manifest['app-plus'] &&
      manifest['app-plus'].distribute &&
      manifest['app-plus'].distribute.android &&
      manifest['app-plus'].distribute.android.permissions) ||
    []

  const required = [
    'android.permission.BLUETOOTH"',
    'android.permission.BLUETOOTH_ADMIN',
    'android.permission.BLUETOOTH_SCAN',
    'android.permission.BLUETOOTH_CONNECT',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
  ]

  const joined = perms.join('\n')
  const missing = required.filter((r) => !joined.includes(r))
  if (missing.length === 0) {
    ok(`Android 权限齐全（${perms.length} 条）`)
  } else {
    fail('缺少权限: ' + missing.join(', '))
  }
}

// ---------------------------------------------------------------- 入口文件
for (const f of ['App.vue', 'main.js']) {
  if (!fs.existsSync(path.join(ROOT, f))) fail(`缺少入口文件 ${f}`)
}
const appVue = fs.existsSync(path.join(ROOT, 'App.vue'))
  ? fs.readFileSync(path.join(ROOT, 'App.vue'), 'utf8')
  : ''
if (appVue) {
  // 先去掉注释，否则文档里写的 "<template>" 字样会被误判成真模板块
  const appClean = appVue
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  if (/<template[\s>]/.test(appClean)) {
    fail('App.vue 不能包含 <template>（uni-app 根组件不允许）')
  } else {
    ok('App.vue 无 <template>（符合 uni-app 要求）')
  }
}
const mainJs = fs.existsSync(path.join(ROOT, 'main.js'))
  ? fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  : ''
if (mainJs) {
  if (/export\s+function\s+createApp/.test(mainJs) && /createSSRApp/.test(mainJs)) {
    ok('main.js 导出 createApp + createSSRApp（uni-app Vue3 写法）')
  } else {
    fail('main.js 不是 uni-app Vue3 入口（应导出 createApp 并使用 createSSRApp）')
  }
}

// ---------------------------------------------------------------- 相对 import 解析
const SCAN_DIRS = ['pages', 'components', 'src']
const EXTS = ['', '.ts', '.js', '.vue']

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return true // 裸模块名交给打包器
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const ext of EXTS) {
    if (fs.existsSync(base + ext)) return true
  }
  for (const ext of EXTS) {
    if (fs.existsSync(path.join(base, 'index' + ext))) return true
  }
  return false
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(vue|ts|js)$/.test(entry.name)) out.push(full)
  }
}

const files = []
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files)

let importCount = 0
let brokenCount = 0
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const re = /(?:from\s+|import\s+)['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) {
    importCount++
    if (!resolveImport(file, m[1])) {
      brokenCount++
      fail(`${path.relative(ROOT, file)} → 无法解析 '${m[1]}'`)
    }
  }
}
if (brokenCount === 0) {
  ok(`相对 import 全部可解析（${importCount} 条，覆盖 ${files.length} 个文件）`)
}

console.log(failed === 0 ? '\nUNIAPP CHECK: PASS' : `\nUNIAPP CHECK: FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
