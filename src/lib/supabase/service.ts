import 'server-only'
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

/** server-only：service role 客戶端，僅供 route_cache 等伺服器資料表使用。
 *  絕不可 import 進 client component（金鑰不落 client 是本層存在的理由）。
 *  未設定時回傳 null，呼叫端降級（跳過快取），不擋主流程。 */
export function createServiceClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createSupabaseClient<Database>(url, key, { auth: { persistSession: false } })
}
