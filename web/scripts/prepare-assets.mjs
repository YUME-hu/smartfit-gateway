/**
 * 准备本地静态资源（模型 + WASM）
 *
 * 为什么需要这一步：
 *   MediaPipe 官方示例从 storage.googleapis.com / cdn.jsdelivr.net 拉 wasm 和模型，
 *   国内这两个域名大概率不通。所以这里把 wasm 从 node_modules 复制到 public/，
 *   模型文件则直接随仓库提供 —— 运行期**完全不碰外网**。
 *
 * 为什么 wasm 不进 git：
 *   两个 wasm 各约 14MB，而它们完全由 @mediapipe/tasks-vision 这个依赖决定，
 *   `npm install` 就能 100% 复现。放进 git 只会让仓库变胖 28MB 且每次都传。
 *   模型（5.5MB）不同：它不是 npm 依赖，没法靠 install 复现，所以入库。
 */

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pkg = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision')

if (!fs.existsSync(pkg)) {
  console.error('[assets] 找不到 @mediapipe/tasks-vision，请先 npm install')
  process.exit(1)
}

// 1) wasm
const wasmSrc = path.join(pkg, 'wasm')
const wasmDst = path.join(root, 'public', 'wasm')
if (!fs.existsSync(wasmSrc)) {
  console.error('[assets] 依赖里没有 wasm 目录: ' + wasmSrc)
  process.exit(1)
}
fs.mkdirSync(wasmDst, { recursive: true })

let copied = 0
for (const name of fs.readdirSync(wasmSrc)) {
  const from = path.join(wasmSrc, name)
  const to = path.join(wasmDst, name)
  const needCopy =
    !fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size
  if (needCopy) {
    fs.copyFileSync(from, to)
    copied++
  }
}
console.log(`[assets] wasm 就绪（${fs.readdirSync(wasmDst).length} 个文件，本次复制 ${copied} 个）`)

// 2) 模型
const model = path.join(root, 'public', 'models', 'pose_landmarker_lite.task')
if (!fs.existsSync(model)) {
  console.error('[assets] 缺少模型文件: public/models/pose_landmarker_lite.task')
  console.error('[assets] 请从 https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task 下载后放入该路径')
  process.exit(1)
}
const mb = (fs.statSync(model).size / 1024 / 1024).toFixed(2)
console.log(`[assets] 模型就绪：pose_landmarker_lite.task (${mb} MB)`)
