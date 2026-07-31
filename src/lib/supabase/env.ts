/** 啟動即驗證必要環境變數：缺漏時丟出可讀錯誤，而非在 Supabase SDK 深處炸開 */
export function requireSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      '缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY，請檢查 .env.local（本地）或部署平台的環境變數設定',
    )
  }
  return { url, anonKey }
}
