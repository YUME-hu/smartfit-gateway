/**
 * 环境变量读取
 *
 * uni-app（Vue3/Vite）只会把 `VITE_` 前缀的变量注入到客户端代码，
 * 所以这里统一走 import.meta.env，变量名也统一带前缀。
 *
 * 注意：所有 VITE_ 变量都会被打包进 APK，**不能放任何服务端密钥**。
 *       Supabase 只能用 anon key（它是公开的，安全性靠 RLS 保证）。
 */

interface ImportMetaEnvLike {
  readonly [key: string]: string | boolean | undefined
}

export function readEnv(name: string): string | undefined {
  const env = (import.meta as unknown as { env?: ImportMetaEnvLike }).env
  const value = env?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
