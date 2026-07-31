import { createBrowserClient } from '@supabase/ssr'
import type { Database } from './database.types'
import { requireSupabaseEnv } from './env'

export function createClient() {
  const { url, anonKey } = requireSupabaseEnv()
  return createBrowserClient<Database>(url, anonKey)
}
