/**
 * .vue 单文件组件的类型声明
 * 让 tsc / vue-tsc 能接受 `import MiniChart from '.../MiniChart.vue'`
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
