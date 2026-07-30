import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { requireSupabaseEnv } from '@/lib/supabase/env'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  // 環境變數缺漏時放行請求而非全站 500：各頁面的 server client 會丟出可讀錯誤，/login 等靜態頁不受牽連
  let env: { url: string; anonKey: string }
  try {
    env = requireSupabaseEnv()
  } catch {
    return supabaseResponse
  }

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        )
      },
    },
  })

  try {
    await supabase.auth.getUser() // 觸發過期 token 刷新
  } catch {
    // 刷新失敗不能讓全站 500：放行，由各頁的 getUser() 自行判定未登入
  }
  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
