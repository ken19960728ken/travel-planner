export type RouteQuery = {
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  mode: 'transit' | 'walking' | 'driving'
  departureMs: number
}

const BUCKET_MS = 30 * 60 * 1000
const COORD_DECIMALS = 4

/** route_cache 的主鍵：座標(4位小數) + 交通方式 + 出發時間(30分桶)。 */
export function buildRouteCacheKey(q: RouteQuery): string {
  const r = (n: number) => n.toFixed(COORD_DECIMALS)
  const bucket = Math.floor(q.departureMs / BUCKET_MS) * BUCKET_MS
  return [r(q.fromLat), r(q.fromLng), r(q.toLat), r(q.toLng), q.mode, bucket].join('|')
}
