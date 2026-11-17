<script>
/**
 * uni-app 应用入口组件
 *
 * 注意：App.vue 只能包含 <script> 和 <style>，**不能有 <template>**
 * —— uni-app 的根组件由框架自己渲染页面，不需要模板。
 */
import { getDeviceToken, setDeviceToken } from './gateway/tokenStore'

/**
 * 构建时注入的设备令牌作为"种子"。
 *
 * 为什么需要：APK 里没有输入令牌的界面，而 ingest/看板都要求令牌。
 * `VITE_DEVICE_TOKEN` 只在**本地还没有令牌**时写入一次；之后有人手动
 * setDeviceToken / clearDeviceToken 时，以本地值为准。
 * 没配置这个环境变量时，这一步什么也不做（不影响开发）。
 */
function seedDeviceToken() {
  const seed = import.meta.env.VITE_DEVICE_TOKEN
  if (typeof seed !== 'string' || seed.trim().length === 0) return
  try {
    if (getDeviceToken() === null) {
      setDeviceToken(seed.trim())
      console.log('[SmartFit] 已写入构建时注入的设备令牌')
    }
  } catch (e) {
    // 种子失败不该让 App 起不来：页面会提示"未配置设备令牌"
    console.warn('[SmartFit] 写入设备令牌种子失败', e)
  }
}

export default {
  onLaunch() {
    console.log('[SmartFit] App Launch')
    seedDeviceToken()
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
