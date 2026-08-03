import { NextResponse } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// C-1 修復（邊界換票）：這支路由不再直接渲染行程，只做「格式檢查 → 種 HttpOnly cookie → 轉址」。
// 審查實測：Google Maps JS 會把 window.location.href 整串塞進自己的請求 body（POST GetViewportInfo），
// referrer:'no-referrer' 只管 Referer header，管不到請求 body；唯一根治手段是 URL 本身從頭就不帶 token。
// 舊連結 /share/<token>（MembersPanel 產生、使用者已經發出去的）維持可用，只是變成這支換票入口——
// 真正渲染搬到 /share/view，那裡的 URL 永遠不含 token。
// cookie 內容就是 token 本身、不簽章：HttpOnly 讓任何 JS（含第三方腳本，例如 Maps JS）讀不到，也
// 不再出現在 location.href；伺服器端仍是同一支 get_shared_trip RPC 做真正驗證（見 /share/view/page.tsx），
// 沒有新增信任面——只是把既有的 122-bit 隨機憑證換了個不會外洩到第三方請求的載體。
// route.js 不能與 page.js 共存於同一路由層級（Next.js 檔案慣例），這是這個 token 段落改成 Route
// Handler、不再是 page.tsx 的直接原因：Server Component render 期間呼叫 cookies().set() 會丟出例外
// （官方文件：只能在 Server Function 或 Route Handler 內修改 cookie），無法照原始構想直接寫在 page.tsx。
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const response = NextResponse.redirect(new URL('/share/view', request.url))

  // token 非 UUID 格式：不種 cookie，並清掉可能殘留的舊 cookie——避免使用者點到壞連結，卻因瀏覽器
  // 上一次換票留下的 cookie 還沒過期，被導去 /share/view 後誤看到另一個行程
  if (!UUID_RE.test(token)) {
    response.cookies.delete({ name: 'share_token', path: '/share' })
    return response
  }

  response.cookies.set('share_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/share',
    maxAge: 60 * 60, // 短效 1 小時：換票後的憑證載體，到期需重新開啟原始連結
  })
  return response
}
