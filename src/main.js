import App from './App.vue'
import { createSSRApp } from 'vue'

/**
 * uni-app Vue3 的固定入口写法
 *
 * 必须导出 createApp 函数并返回 { app }，不是直接 createApp(App).mount()
 * —— 挂载由 uni-app 运行时接管（App / 小程序 / H5 三端统一）。
 */
export function createApp() {
  const app = createSSRApp(App)
  return { app }
}
