/** 登入後 `next` 回跳目標的白名單判準：只允許 `/` 開頭且非 `//` 開頭的站內相對路徑——後者是
 *  protocol-relative URL，會被瀏覽器解讀成外站絕對網址，構成 open redirect。login 頁（email/password
 *  與 Google OAuth 兩條路徑）與 `/auth/callback` route 共用同一份判準，任何一端收到不合白名單的值
 *  一律退回 null，呼叫端自行 fallback 到預設頁面。 */
export function safeNextPath(next: string | null): string | null {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next
  return null
}
