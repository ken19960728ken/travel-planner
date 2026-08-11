/** 參與人的名冊解析與指派解讀（設計文件 docs/superpowers/specs/2026-08-11-participants-design.md §3.4）。
 *
 *  【為何是唯一入口】「null = 全員 / 未知 id 忽略 / 全部無效視同全員」這三條規則有五個消費端
 *  （sync、衝突偵測、播放、花費、匯出）。讓每個消費端各寫一次就是五份會各自漂移的邏輯——
 *  比照手繪路徑的 parseCustomPath（routePath.ts），全部收斂到這裡。
 *
 *  屬 domain 層，輸入型別自帶最小欄位、不 import app 層型別（沿 snapshot.ts / exportRows.ts 慣例）。 */

export const MAX_PARTICIPANTS = 20

export type Participant = {
  id: string
  /** 對應 trip_members.user_id；無帳號同行者為 null */
  user_id: string | null
  name: string
  color: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** 從 DB/RPC 讀到的未知形狀 → 乾淨的名冊。畸形元素個別丟棄，不整批放棄。 */
export function parseRoster(raw: unknown): Participant[] {
  if (!Array.isArray(raw)) return []
  const out: Participant[] = []
  const seen = new Set<string>()
  for (const e of raw) {
    if (out.length >= MAX_PARTICIPANTS) break
    if (typeof e !== 'object' || e === null) continue
    // 逐鍵用 hasOwn 取值：解構會沿原型鏈找，Object.create({ id: … }) 這種物件會被誤當成合法資料
    const id = Object.hasOwn(e, 'id') ? (e as Record<string, unknown>).id : undefined
    const userId = Object.hasOwn(e, 'user_id') ? (e as Record<string, unknown>).user_id : null
    const name = Object.hasOwn(e, 'name') ? (e as Record<string, unknown>).name : undefined
    const color = Object.hasOwn(e, 'color') ? (e as Record<string, unknown>).color : undefined
    if (!isNonEmptyString(id) || !isNonEmptyString(name) || !isNonEmptyString(color)) continue
    if (userId !== null && userId !== undefined && typeof userId !== 'string') continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, user_id: typeof userId === 'string' ? userId : null, name, color })
  }
  return out
}

/** 解讀停留點的參與人。回傳一定是 roster 的子集、順序沿 roster；roster 為空時回空陣列。
 *  一律回傳新陣列，不把 roster 本身交出去（呼叫端 mutate 不會污染名冊）。
 *
 *  「全部無效 → 全員」這條不是防禦性冗餘：若某停留點的 id 全部指向已移除的參與人而不套用這條，
 *  它不會出現在任何人的鏈上，於是前後的交通段全部消失，而畫面上看不出原因。 */
export function resolveStopParticipants(participantIds: unknown, roster: readonly string[]): string[] {
  if (roster.length === 0) return []
  if (!Array.isArray(participantIds)) return [...roster]
  const wanted = new Set(participantIds.filter(isNonEmptyString))
  const hit = roster.filter(id => wanted.has(id))
  return hit.length > 0 ? hit : [...roster]
}

/** 交通段的參與人＝前後兩個停留點的交集（設計文件 §2：不獨立儲存，結構上不可能矛盾）。 */
export function legParticipants(fromIds: readonly string[], toIds: readonly string[]): string[] {
  const to = new Set(toIds)
  return fromIds.filter(id => to.has(id))
}
