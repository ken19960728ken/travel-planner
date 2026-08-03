type PosStop = { id: string; startsAt: number; endsAt: number; lat: number; lng: number }

export type PlaybackSegment =
  | { kind: 'stay'; stopId: string }
  | { kind: 'travel'; fromStopId: string; toStopId: string; progress: number }

/** 播放頭時刻的分段判定：停留中 stay（重疊取開始最早者）；空檔 travel（前後點 + 進度比例）；
 *  界外取端點 stay。與 interpolatePosition 同一份分支邏輯——後者已改為由本函式導出位置，
 *  不會再有兩份平行實作漂移。 */
export function segmentAt(
  stops: { id: string; startsAt: number; endsAt: number }[],
  tMs: number,
): PlaybackSegment | null {
  if (stops.length === 0) return null

  const covering = stops.filter(s => tMs >= s.startsAt && tMs <= s.endsAt)
  if (covering.length > 0) {
    const current = covering.reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
    return { kind: 'stay', stopId: current.id }
  }

  const earliest = stops.reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
  if (tMs <= earliest.startsAt) return { kind: 'stay', stopId: earliest.id }

  const latest = stops.reduce((a, b) => (b.endsAt > a.endsAt ? b : a))
  if (tMs >= latest.endsAt) return { kind: 'stay', stopId: latest.id }

  const before = stops.filter(s => s.endsAt <= tMs).reduce((a, b) => (b.endsAt > a.endsAt ? b : a))
  const after = stops.filter(s => s.startsAt >= tMs).reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
  return {
    kind: 'travel',
    fromStopId: before.id,
    toStopId: after.id,
    progress: (tMs - before.endsAt) / (after.startsAt - before.endsAt),
  }
}

/** 播放頭時刻的「我」位置（直線內插版；有 polyline 的段落由呼叫端改用 pathPosition 沿路線取位）。
 *  原檔頭註解的語義（不假設排序、重疊取開始最早）由 segmentAt 承接。 */
export function interpolatePosition(stops: PosStop[], tMs: number): { lat: number; lng: number } | null {
  const seg = segmentAt(stops, tMs)
  if (!seg) return null
  const byId = new Map(stops.map(s => [s.id, s]))
  if (seg.kind === 'stay') {
    const s = byId.get(seg.stopId)!
    return { lat: s.lat, lng: s.lng }
  }
  const from = byId.get(seg.fromStopId)!
  const to = byId.get(seg.toStopId)!
  return {
    lat: from.lat + (to.lat - from.lat) * seg.progress,
    lng: from.lng + (to.lng - from.lng) * seg.progress,
  }
}
