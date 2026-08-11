/** 定稿快照 / JSON 匯出的純函式 builder（spec §4/§7、審查 C-1：不可裁）。
 *  同一份回傳值既落 trip_snapshots.snapshot 又是 JSON 匯出檔內容本身（一魚兩吃）。
 *  屬 domain 層，輸入型別自帶最小欄位（不 import app 層的 TripView 型別，沿 exportRows.ts 慣例）。
 *
 *  ToS 分層鐵律（spec §4，含 M-8 名稱決策——地點名稱納入快照，理由見 spec §4/§8）：
 *  - stops：地點座標屬 Google 30 天快取類別，非 is_custom 地點不收錄 lat/lng（快照以 place_id 代表）；
 *    is_custom 地點的座標是使用者自己輸入的資料，照存。
 *  - legs：auto 段只存 mode/source/estimated_cost（時長由前後停留點時間隱含，推導性質，不落地）；
 *    manual 段是使用者全文輸入，額外存 duration_minutes/departs_at/arrives_at。
 *  - 兩者一律不含 polyline/detail/distance_meters/computed_at 等 Google 衍生欄位——
 *    輸入型別本身就不收這些鍵，結構上不可能外洩（比對照全欄位再逐一排除更安全）。
 *  - **custom_path 是例外，而且是刻意收錄的**（2026-08-10 手繪路徑）：它不是 Google 衍生資料，
 *    是使用者自己在地圖上點出來的路線，性質同 is_custom 停留點的座標。不受 30 天 TTL 限制，
 *    永久保存正是它的目的——使用者為日本電車段畫的路線不該在快照裡消失。
 *    這條例外不鬆動上面那句：Google 衍生欄位仍然一個都不收。
 *  - stops 額外帶 id：不是 Google 衍生資料，且 legs 的 from_stop_id/to_stop_id 需要它才能對應
 *    回具體停留點（否則匯出的 JSON 會有指不到任何紀錄的孤兒外鍵，回憶專案無法重建行程圖）。
 */

import { parseCustomPath } from './routePath'
import { parseRoster, resolveStopParticipants } from './participants'

export type SnapshotTrip = {
  title: string
  start_date: string
  end_date: string
  currency: string
  /** 參與人名冊。宣告為 unknown 是刻意的——來源是 DB／分享 RPC（兩者形狀不同，
   *  後者少了 user_id），builder 內用 parseRoster 清洗後才落進快照。 */
  participants: unknown
}

export type SnapshotStop = {
  id: string
  name: string
  lat: number
  lng: number
  place_id: string | null
  is_custom: boolean
  timezone: string
  starts_at: string
  ends_at: string
  locked: boolean
  notes: string | null
  estimated_cost: number | null
  /** 誰會去。同上，宣告為 unknown，經 resolveStopParticipants 清洗。 */
  participant_ids: unknown
}

export type SnapshotLegMode = 'transit' | 'walking' | 'driving' | 'flight' | 'custom'
export type SnapshotLeg = {
  from_stop_id: string
  to_stop_id: string
  mode: SnapshotLegMode
  source: 'auto' | 'manual'
  estimated_cost: number | null
  duration_minutes: number | null
  departs_at: string | null
  arrives_at: string | null
  /** 使用者手繪路徑。宣告為 unknown 是刻意的——來源是 DB，形狀不可信，builder 內用
   *  parseCustomPath 清洗後才落進快照，不讓畸形資料進入永久保存的凍結副本。 */
  custom_path: unknown
}

/** 快照裡的參與人：**不含 user_id**。下游（回憶專案、匯出檔）沒有任何消費端需要它，
 *  而它是 auth.users 的 UUID——不收錄就少一個外洩面。 */
export type SnapshotParticipant = { id: string; name: string; color: string }

export type SnapshotStopOut = {
  id: string
  name: string
  place_id: string | null
  is_custom: boolean
  timezone: string
  starts_at: string
  ends_at: string
  locked: boolean
  notes: string | null
  estimated_cost: number | null
  lat?: number
  lng?: number
  /** 誰會去。全員（或沒有名冊）時不帶這個鍵，與其他 optional 同慣例。 */
  participant_ids?: string[]
}

export type SnapshotLegOut = {
  from_stop_id: string
  to_stop_id: string
  mode: SnapshotLegMode
  source: 'auto' | 'manual'
  estimated_cost: number | null
  duration_minutes?: number | null
  departs_at?: string | null
  arrives_at?: string | null
  /** 已清洗的手繪路徑 `[[lat,lng],...]`；沒畫過的段落不帶這個鍵（與上面三個 optional 同慣例） */
  custom_path?: [number, number][]
}

export type TripSnapshotTripOut = {
  title: string
  start_date: string
  end_date: string
  currency: string
  participants: SnapshotParticipant[]
}

export type TripSnapshot = {
  snapshot_version: 1
  trip: TripSnapshotTripOut
  stops: SnapshotStopOut[]
  legs: SnapshotLegOut[]
}

/** 純函式：把 trip/stops/legs 凍結成快照/JSON 匯出用的結構。 */
export function buildTripSnapshot(trip: SnapshotTrip, stops: SnapshotStop[], legs: SnapshotLeg[]): TripSnapshot {
  // 參與人是使用者資料（非 Google 衍生），與 custom_path 同屬上面那條例外——永久收錄。
  // 少了它，快照裡的 participant_ids 會變成一堆指不到任何人的 uuid。
  const roster = parseRoster(trip.participants)
  const rosterIds = roster.map(p => p.id)
  return {
    snapshot_version: 1,
    trip: {
      title: trip.title,
      start_date: trip.start_date,
      end_date: trip.end_date,
      currency: trip.currency,
      participants: roster.map(p => ({ id: p.id, name: p.name, color: p.color })),
    },
    stops: stops.map(s => ({
      id: s.id,
      name: s.name,
      place_id: s.place_id,
      is_custom: s.is_custom,
      timezone: s.timezone,
      starts_at: s.starts_at,
      ends_at: s.ends_at,
      locked: s.locked,
      notes: s.notes,
      estimated_cost: s.estimated_cost,
      ...(s.is_custom ? { lat: s.lat, lng: s.lng } : {}),
      // 全員（含沒有名冊）時不帶鍵——那是預設值，逐格寫進去只是把檔案撐大
      ...(() => {
        const who = resolveStopParticipants(s.participant_ids, rosterIds)
        return who.length > 0 && who.length < rosterIds.length ? { participant_ids: who } : {}
      })(),
    })),
    legs: legs.map(l => {
      // 清洗後才落進快照——快照是永久保存的凍結副本，不讓畸形資料進去
      const waypoints = parseCustomPath(l.custom_path)
      return {
        from_stop_id: l.from_stop_id,
        to_stop_id: l.to_stop_id,
        mode: l.mode,
        source: l.source,
        estimated_cost: l.estimated_cost,
        ...(l.source === 'manual'
          ? { duration_minutes: l.duration_minutes, departs_at: l.departs_at, arrives_at: l.arrives_at }
          : {}),
        // 與 source 無關：auto 段也可以有手繪路徑（畫路徑不改變 auto/manual 狀態）
        ...(waypoints.length > 0
          ? { custom_path: waypoints.map(p => [p.lat, p.lng] as [number, number]) }
          : {}),
      }
    }),
  }
}
