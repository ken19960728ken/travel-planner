import { createHash } from 'crypto'
import { NextResponse } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 由 token 導出的非機密識別子：單向雜湊，122-bit 隨機值不可逆推。
 *  用途是讓每條分享連結有各自的 cookie 格與各自的 /share/view?k=… 網址——
 *  URL 仍不含憑證，但同一個瀏覽器開多條連結不會互相蓋台（審查 M-1）。 */
export function shareKeyOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

// C-1 修復（邊界換票）：這支路由不再直接渲染行程，只做「格式檢查 → 種 HttpOnly cookie → 轉址」。
// 審查實測：Google Maps JS 會把 window.location.href 整串塞進自己的請求 body（POST GetViewportInfo），
// referrer:'no-referrer' 只管 Referer header，管不到請求 body；唯一根治手段是 URL 本身從頭就不帶 token。
// 舊連結 /share/<token>（MembersPanel 產生、使用者已經發出去的）維持可用，只是變成這支換票入口——
// 真正渲染搬到 /share/view，那裡的 URL 永遠不含 token。
//
// cookie 內容就是 token 本身、不簽章：HttpOnly 讓任何 JS（含第三方腳本，例如 Maps JS）讀不到，也
// 不再出現在 location.href；伺服器端仍是同一支 get_shared_trip RPC 做真正驗證，沒有新增信任面——
// 使用者自己竄改 cookie 成任意 UUID，等價於直接開 /share/<那個 UUID>，猜中機率不變。
//
// route.ts 不能與 page.tsx 共存於同一路由層級（Next.js 檔案慣例），這是這個 token 段落改成 Route
// Handler 的直接原因：Server Component render 期間呼叫 cookies().set() 會丟出例外
// （官方文件：只能在 Server Function 或 Route Handler 內修改 cookie）。
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  // token 非 UUID 格式：不種 cookie，直接導去無 k 參數的 view（那裡會顯示連結無效）
  if (!UUID_RE.test(token)) {
    return NextResponse.redirect(new URL('/share/view', request.url))
  }

  const k = shareKeyOf(token)
  const response = NextResponse.redirect(new URL(`/share/view?k=${k}`, request.url))
  response.cookies.set(`share_tk_${k}`, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/share',
    // 30 天：這個 cookie 只是憑證的載體，不是額外的安全邊界（底層 share_token 本身無到期機制，
    // 原始連結永久有效、重開一次就換到新 cookie）。設太短只會製造「連結明明還好卻說已失效」的
    // 偽陰性，進而誘使 owner 按「重新產生」，把其他旅伴手上活著的連結一起殺掉（審查 M-2）。
    maxAge: 60 * 60 * 24 * 30,
  })
  return response
}
