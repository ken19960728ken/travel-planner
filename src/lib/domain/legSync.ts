import { resolveStopParticipants } from './participants'

export type SyncStop = {
  id: string; lat: number; lng: number; startsAt: number; endsAt: number
  /** 誰會去。形狀不可信（來自 DB），一律經 resolveStopParticipants 解讀。 */
  participantIds: unknown
}
export type SyncLeg = {
  id: string
  fromStopId: string
  toStopId: string
  source: 'auto' | 'manual'
  durationMinutes: number | null
  departsAtMs: number | null
  computedAtMs: number | null
  stale: boolean
  estimatedCost: number | null
}
export type LegSyncPlan = {
  create: Array<{ fromStopId: string; toStopId: string }>
  removeAuto: string[]
  detachAuto: string[]
  markStale: string[]
  recompute: string[]
}

/** auto 段（Google 衍生資料）的 30 天 TTL（spec §4 ToS 分層） */
export const AUTO_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 全行程按 startsAt 排序的連續配對（同刻以 id 決勝求穩定）；跨日配對包含在內（flight 需要） */
export function adjacentPairs<T extends { id: string; startsAt: number }>(stops: T[]): Array<[T, T]> {
  const sorted = [...stops].sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))
  const pairs: Array<[T, T]> = []
  for (let i = 0; i < sorted.length - 1; i++) pairs.push([sorted[i], sorted[i + 1]])
  return pairs
}

/** 每個參與人各自的相鄰配對，聯集去重（設計文件 2026-08-11-participants §4.1）。
 *
 *  adjacentPairs 假設整趟行程只有一條時間軸。分頭行動時那個假設會生出「沒有人走過」的
 *  幻影交通段——A(9-10)、B(11-12,甲)、C(11-12,乙) 按時間排序後相鄰配對是 A→B、**B→C**，
 *  而真正存在的 A→C 永遠不會被建立。本函式對每個人各自取鏈，聯集後去重。
 *
 *  名冊為空時直接退回 adjacentPairs——這不是特例分支，是「零個參與人＝單一虛擬參與人」的
 *  自然結果，但顯式寫出來讓退化路徑一眼可見（測試逐項鎖住兩者相等）。 */
export function participantPairs<T extends { id: string; startsAt: number; participantIds: unknown }>(
  stops: T[],
  roster: readonly string[],
): Array<[T, T]> {
  if (roster.length === 0) return adjacentPairs(stops)
  // 先算一次：否則內層 filter 會對每個「參與人 × 停留點」重跑解讀，上限 20 × 500
  const resolved = new Map(stops.map(s => [s.id, resolveStopParticipants(s.participantIds, roster)]))
  const seen = new Set<string>()
  const out: Array<[T, T]> = []
  for (const p of roster) {
    const mine = stops.filter(s => resolved.get(s.id)!.includes(p))
    for (const pair of adjacentPairs(mine)) {
      const k = `${pair[0].id}→${pair[1].id}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(pair)
    }
  }
  return out
}

/** 比對「應有的相鄰配對」與「現有 legs」，產出同步計畫。純函式，不碰 DB。
 *  規則（spec §4/§6）：manual 段絕不覆蓋/刪除，最多標 stale；auto 段「從未計算、基準偏移、逾 TTL」
 *  三者之一才重算。判準刻意用 computed_at 而非 duration——no_route 段 duration 恆為 null，
 *  若以 duration 判會每次 sync 重打 Google，擊穿成本護欄（審查 M-2）；no_route 靠 TTL 與停留點變動重試。 */
export function planLegSync(
  stops: SyncStop[],
  legs: SyncLeg[],
  nowMs: number,
  roster: readonly string[] = [],
): LegSyncPlan {
  const key = (f: string, t: string) => `${f}→${t}`
  const wanted = new Map(participantPairs(stops, roster).map(([f, t]) => [key(f.id, t.id), { from: f, to: t }]))
  const plan: LegSyncPlan = { create: [], removeAuto: [], detachAuto: [], markStale: [], recompute: [] }
  const covered = new Set<string>()

  for (const leg of legs) {
    const pair = wanted.get(key(leg.fromStopId, leg.toStopId))
    if (!pair) {
      // Important-1 根治：帶花費的 auto 段脫離配對時不能無聲刪除（花費是使用者資料）——
      // 轉存 manual（detachAuto，實際 UPDATE 在 sync route 執行），無花費才走原本的 removeAuto
      if (leg.source === 'auto' && leg.estimatedCost !== null) plan.detachAuto.push(leg.id)
      else if (leg.source === 'auto') plan.removeAuto.push(leg.id)
      else if (!leg.stale) plan.markStale.push(leg.id)
      continue
    }
    covered.add(key(leg.fromStopId, leg.toStopId))
    if (leg.source === 'auto') {
      const neverComputed = leg.computedAtMs === null
      const expired = leg.computedAtMs !== null && nowMs - leg.computedAtMs > AUTO_TTL_MS
      const moved = leg.departsAtMs !== pair.from.endsAt
      if (neverComputed || expired || moved) plan.recompute.push(leg.id)
    }
  }
  for (const [k, pair] of wanted) {
    if (!covered.has(k)) plan.create.push({ fromStopId: pair.from.id, toStopId: pair.to.id })
  }
  return plan
}

/** from → 該停留點的所有後繼（分頭時一條出邊不夠：甲往 B、乙往 C）。
 *
 *  取代各處手寫的 `new Map(pairs.map(([f,t]) => [f.id, t.id]))`——那種單值 Map 會讓
 *  同一個 from 的第二條邊靜默蓋掉第一條，於是側欄／匯出各少一列交通、多一列不存在的交通。
 *  值一律是陣列（即使只有一個），呼叫端用 includes/迴圈處理，不再有「只有一個後繼」的假設。 */
export function nextIdsByStop<T extends { id: string; startsAt: number; participantIds: unknown }>(
  stops: T[],
  roster: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [f, t] of participantPairs(stops, roster)) {
    const list = out.get(f.id)
    if (list) list.push(t.id)
    else out.set(f.id, [t.id])
  }
  return out
}
