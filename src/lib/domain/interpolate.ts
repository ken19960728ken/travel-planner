type PosStop = { id: string; startsAt: number; endsAt: number; lat: number; lng: number }

/** 播放頭時刻的「我」位置：停留中在該點（重疊時取開始最早者）；空檔在前後點間線性內插；界外取端點。
 *  不依賴輸入順序（不假設已排序），因為 spec §5 允許停留點重疊，「陣列最後一筆」不保證是結束最晚的那筆。 */
export function interpolatePosition(
  stops: PosStop[],
  tMs: number,
): { lat: number; lng: number } | null {
  if (stops.length === 0) return null

  const covering = stops.filter(s => tMs >= s.startsAt && tMs <= s.endsAt)
  if (covering.length > 0) {
    const current = covering.reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
    return { lat: current.lat, lng: current.lng }
  }

  const earliest = stops.reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
  if (tMs <= earliest.startsAt) return { lat: earliest.lat, lng: earliest.lng }

  const latest = stops.reduce((a, b) => (b.endsAt > a.endsAt ? b : a))
  if (tMs >= latest.endsAt) return { lat: latest.lat, lng: latest.lng }

  // 空檔（沒有停留點涵蓋 tMs）：取結束最晚且早於 tMs 的一筆，與開始最早且晚於 tMs 的一筆做線性內插
  const before = stops.filter(s => s.endsAt <= tMs).reduce((a, b) => (b.endsAt > a.endsAt ? b : a))
  const after = stops.filter(s => s.startsAt >= tMs).reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
  const r = (tMs - before.endsAt) / (after.startsAt - before.endsAt)
  return { lat: before.lat + (after.lat - before.lat) * r, lng: before.lng + (after.lng - before.lng) * r }
}
