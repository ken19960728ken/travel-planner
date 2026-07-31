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
 *  - stops 額外帶 id：不是 Google 衍生資料，且 legs 的 from_stop_id/to_stop_id 需要它才能對應
 *    回具體停留點（否則匯出的 JSON 會有指不到任何紀錄的孤兒外鍵，回憶專案無法重建行程圖）。
 */

export type SnapshotTrip = {
  title: string
  start_date: string
  end_date: string
  currency: string
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
}

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
}

export type TripSnapshot = {
  snapshot_version: 1
  trip: SnapshotTrip
  stops: SnapshotStopOut[]
  legs: SnapshotLegOut[]
}

/** 純函式：把 trip/stops/legs 凍結成快照/JSON 匯出用的結構。 */
export function buildTripSnapshot(trip: SnapshotTrip, stops: SnapshotStop[], legs: SnapshotLeg[]): TripSnapshot {
  return {
    snapshot_version: 1,
    trip: {
      title: trip.title,
      start_date: trip.start_date,
      end_date: trip.end_date,
      currency: trip.currency,
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
    })),
    legs: legs.map(l => ({
      from_stop_id: l.from_stop_id,
      to_stop_id: l.to_stop_id,
      mode: l.mode,
      source: l.source,
      estimated_cost: l.estimated_cost,
      ...(l.source === 'manual'
        ? { duration_minutes: l.duration_minutes, departs_at: l.departs_at, arrives_at: l.arrives_at }
        : {}),
    })),
  }
}
