export type SyncStop = { id: string; lat: number; lng: number; startsAt: number; endsAt: number }
export type SyncLeg = {
  id: string
  fromStopId: string
  toStopId: string
  source: 'auto' | 'manual'
  durationMinutes: number | null
  departsAtMs: number | null
  computedAtMs: number | null
  stale: boolean
}
export type LegSyncPlan = {
  create: Array<{ fromStopId: string; toStopId: string }>
  removeAuto: string[]
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

/** 比對「應有的相鄰配對」與「現有 legs」，產出同步計畫。純函式，不碰 DB。
 *  規則（spec §4/§6）：manual 段絕不覆蓋/刪除，最多標 stale；auto 段「從未計算、基準偏移、逾 TTL」
 *  三者之一才重算。判準刻意用 computed_at 而非 duration——no_route 段 duration 恆為 null，
 *  若以 duration 判會每次 sync 重打 Google，擊穿成本護欄（審查 M-2）；no_route 靠 TTL 與停留點變動重試。 */
export function planLegSync(stops: SyncStop[], legs: SyncLeg[], nowMs: number): LegSyncPlan {
  const key = (f: string, t: string) => `${f}→${t}`
  const wanted = new Map(adjacentPairs(stops).map(([f, t]) => [key(f.id, t.id), { from: f, to: t }]))
  const plan: LegSyncPlan = { create: [], removeAuto: [], markStale: [], recompute: [] }
  const covered = new Set<string>()

  for (const leg of legs) {
    const pair = wanted.get(key(leg.fromStopId, leg.toStopId))
    if (!pair) {
      if (leg.source === 'auto') plan.removeAuto.push(leg.id)
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
