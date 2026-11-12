/**
 * 深蹲记录写入 Supabase
 *
 * 一次动作写一行。用 `client_key` 唯一约束做幂等：
 *   - 首次写入 → ok
 *   - 网络重试导致重复 → 23505 → 视为 duplicate（不报错）
 *
 * 注意这里**不用** PostgREST 的 `Prefer: resolution=...`：
 * 实测它会被翻译成 ON CONFLICT DO UPDATE，要求 UPDATE 策略，
 * 而 RLS 只给了 INSERT（详见仓库 README「坑 1」）。
 * 单行 INSERT + 唯一约束 + 把 23505 当成功，是最省事且安全的做法。
 */

import { createClient } from '@supabase/supabase-js'

export type SaveOutcome = 'ok' | 'duplicate' | 'error'

export interface RepRowInput {
  clientKey: string
  sessionId: string
  repIndex: number
  /** epoch ms */
  finishedAt: number
  /** 本次最深膝角（度） */
  minAngle: number
  durationMs: number
}

export interface SaveResult {
  outcome: SaveOutcome
  message?: string
}

export function createRepsWriter(supabaseUrl: string, supabaseAnonKey: string, table = 'reps') {
  const client = createClient(supabaseUrl, supabaseAnonKey)

  return {
    async save(input: RepRowInput): Promise<SaveResult> {
      const { error } = await client.from(table).insert({
        client_key: input.clientKey,
        session_id: input.sessionId,
        source: 'vision',
        rep_index: input.repIndex,
        recorded_at: new Date(input.finishedAt).toISOString(),
        min_angle: Number(input.minAngle.toFixed(1)),
        duration_ms: Math.round(input.durationMs),
      })

      if (!error) return { outcome: 'ok' }
      // 23505 = unique_violation，说明这条已经写过了，不是失败
      if (error.code === '23505') return { outcome: 'duplicate' }
      return { outcome: 'error', message: error.message }
    },
  }
}
