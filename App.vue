<script>
/**
 * uni-app 应用入口组件
 *
 * 注意：App.vue 只能包含 <script> 和 <style>，**不能有 <template>**
 * —— uni-app 的根组件由框架自己渲染页面，不需要模板。
 */
export default {
  onLaunch() {
    console.log('[SmartFit] App Launch')
  },
  onShow() {
    console.log('[SmartFit] App Show')
  },
  onHide() {
    console.log('[SmartFit] App Hide')
  },
}
</script>

<style>
/* 全局样式：与 App 页面保持同一套深色底 */
page {
  background-color: #0f1115;
  color: #e8ecf3;
}
</style>
