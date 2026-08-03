/** 登入後 `next` 回跳目標的白名單判準。login 頁（email/password 與 Google OAuth 兩條路徑）與
 *  `/auth/callback` route 共用同一份判準，任何一端收到不合白名單的值一律退回 null，呼叫端自行
 *  fallback 到預設頁面。
 *
 *  **不做前綴字串比對，交給 URL 解析器判定**（2026-08-04 安全審查，初版 `startsWith('/') &&
 *  !startsWith('//')` 有五條實測可繞過的路徑）：WHATWG URL 解析對反斜線與 ASCII 控制字元有特殊
 *  處理——`/` 後接 `\` 會進入 special-authority-ignore-slashes state 把後續當 host 解析；tab/LF/CR
 *  在解析「之前」就被整串移除。實測 `/\evil.com`、`/\/evil.com`、`/%09/evil.com`、`/%0A/…`、
 *  `/%0D/…` 五者都通過舊判準，而 `new URL(next, origin)` 全部解析成 `https://evil.com/`。
 *  可達鏈已逐行確認：URLSearchParams 會解百分比編碼 → login 的 router.push(next) →
 *  Next 的 app-router-instance 用 `new URL(addBasePath(href), location.href)` 解析 → origin 不同
 *  判為 isExternalURL → navigate-reducer 走 completeHardNavigation → 整頁導向攻擊者網站。
 *  使用者看到的是真網域的真登入頁，輸入帳密後才被送走，是教科書等級的釣魚跳板。
 *
 *  **回傳正規化後的 pathname+search+hash，不回傳原始字串**：只驗不正規化的話，日後有人改動
 *  這裡的實作細節就可能讓原始的畸形字串重新流到呼叫端。
 *
 *  **輸出必須再驗一次**（審查修法本身的殘留洞，實測補上）：`/..//evil.com` 解析時 origin 仍是
 *  sentinel（通過第一關），但正規化後的 pathname 是 `//evil.com`——呼叫端 `router.push` 再解析
 *  一次就變成 `https://evil.com/`。單靠「輸入解析結果同源」不足，必須確認**輸出字串**自己重新
 *  解析時也還在同源，才是真正的不動點。實測受影響的還有 `/./..//evil.com`、`/a/../..//evil.com`。 */
const SENTINEL_ORIGIN = 'https://safe-next.invalid'
const OUTPUT_PROBE_ORIGIN = 'https://safe-next-probe.invalid'

export function safeNextPath(next: string | null): string | null {
  // 仍要求輸入以 `/` 開頭：URL 解析會把裸相對路徑（`trips`）正規化成 `/trips`，雖然同源不危險，
  // 但那不是這個參數的契約（呼叫端傳的一律是絕對路徑），收窄輸入面沒有成本
  if (!next || !next.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(next, SENTINEL_ORIGIN)
  } catch {
    return null
  }
  // 任何解析結果落在 sentinel 以外的 origin，都代表這個值有能力把使用者帶離本站
  if (url.origin !== SENTINEL_ORIGIN) return null
  const path = url.pathname + url.search + url.hash
  // 二次驗證：輸出字串本身在另一個 origin 下重新解析，仍必須是站內相對路徑
  try {
    if (new URL(path, OUTPUT_PROBE_ORIGIN).origin !== OUTPUT_PROBE_ORIGIN) return null
  } catch {
    return null
  }
  return path
}
