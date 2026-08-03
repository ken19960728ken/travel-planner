import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/domain/safeNext'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // Step 4：next 由 login 頁附加在 redirectTo 上、隨 OAuth 往返轉發回這裡；不信任跨請求傳遞的值，
  // 用同一份白名單再驗一次（safeNextPath），不合規一律退回 /trips
  const next = safeNextPath(searchParams.get('next')) ?? '/trips'
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=oauth_failed`)
  }
  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=oauth_failed`)
  }
  return NextResponse.redirect(`${origin}${next}`)
}
