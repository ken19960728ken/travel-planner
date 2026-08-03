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
 *  一次就變成 `https://evil.com/`。單靠「輸入解析結果同源」不足。實測受影響的還有
 *  `/./..//evil.com`、`/a/../..//evil.com`。
 *
 *  **輸出端用形狀檢查而非再解析一次**（複審再修）：曾用「把輸出丟進另一個 probe origin 重新解析、
 *  要求仍同源」，但那是自我指涉的——輸出若正規化成 `//safe-next-probe.invalid/x`，在 probe 下解析
 *  出來的 origin 正好就是 probe，檢查通過卻仍會在真實站點外流（50 萬樣本模糊測試找到 196 個）。
 *  改為檢查正規化後的字串是否以 `//` 開頭。這與初版「對原始輸入做前綴比對」不是同一類判斷：
 *  `url.pathname` 是解析器的產物，原始反斜線已轉成 `/`、TAB/LF/CR 已被移除（實測 `/a\b` → `/a/b`、
 *  `/a<TAB>b` → `/ab`），所以能讓呼叫端逃逸的形狀只剩前導 `//`（含 `///`，同樣被涵蓋）。
 *  gate 1 的 origin 檢查不能當獨立防線——攻擊者猜中 sentinel 主機名就能滿足它。 */
const SENTINEL_ORIGIN = 'https://safe-next.invalid'

export function safeNextPath(next: string | null): string | null {
  // 輸入面收窄（縱深防禦，不是唯一防線）：
  // - 要求 `/` 開頭：URL 解析會把裸相對路徑（`trips`）正規化成 `/trips`，雖然同源不危險，
  //   但那不是這個參數的契約（呼叫端傳的一律是絕對路徑）
  // - 明確拒絕 `//` 開頭：這種輸入是 protocol-relative，合法的站內路徑永遠不長這樣。不擋的話，
  //   攻擊者猜中下面 sentinel 的主機名（public repo 讀得到）就能讓 `//safe-next.invalid/x`
  //   通過 origin 檢查並被靜默改寫成 `/x`——輸出雖同源不外流，但「拒絕 protocol-relative」的
  //   契約沒有成立，且把安全性繫在一個常數上
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null
  let url: URL
  try {
    url = new URL(next, SENTINEL_ORIGIN)
  } catch {
    return null
  }
  // 任何解析結果落在 sentinel 以外的 origin，都代表這個值有能力把使用者帶離本站
  if (url.origin !== SENTINEL_ORIGIN) return null
  const path = url.pathname + url.search + url.hash
  // 二次驗證：正規化後的字串不得是 protocol-relative（`//host` / `///host`），否則呼叫端再解析
  // 一次就會外流。此處前綴比對可靠的前提見檔頭——pathname 不可能含原始反斜線或控制字元
  if (path.startsWith('//')) return null
  return path
}
