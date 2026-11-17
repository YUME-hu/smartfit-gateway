import { defineConfig } from 'vite'
import uniModule from '@dcloudio/vite-plugin-uni'

/**
 * uni-app CLI 构建配置
 *
 * 工程已从 HBuilderX 布局迁到 CLI 布局：
 *   src/pages.json、src/manifest.json、src/App.vue、src/main.js、src/pages/**、src/components/**
 * 插件默认读 src/，所以这里不需要配 input。
 *
 * 打包：npm run build:app（= uni build -p app，产物 dist/build/app）
 *
 * 关于下面这行 `.default`：`@dcloudio/vite-plugin-uni` 是 CJS 包，导出形如
 * `module.exports = { default: fn, runDev, runBuild, ... }`；Node 的 ESM 互操作下
 * `import uniModule from` 拿到的是整个 exports 对象而不是函数，直接 `uniModule()`
 * 会报 "uni is not a function"。所以显式取 .default。
 */
const uni = (uniModule as unknown as { default?: unknown }).default ?? uniModule

export default defineConfig({
  plugins: [(uni as () => unknown)()],
})
