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
// C-1：ComputedRoute 的語意變更（no_transit_data 新增/改形）版本前綴——舊快取列（用舊語意寫入）必須
// 全面 miss，否則會把「部署前誤判成正常大眾運輸的純步行時長」繼續當快取命中吐回使用者。舊列由既有
// CACHE_TTL_MS（30 天）清理自然淘汰，不需另外刪除；配合 supabase/migrations/20260803000002_transit_recompute.sql
// 強制既有 legs 列重算。
const CACHE_KEY_VERSION = 'v2'

/** route_cache 的主鍵：版本前綴 + 座標(4位小數) + 交通方式 + 出發時間(30分桶)。 */
export function buildRouteCacheKey(q: RouteQuery): string {
  const r = (n: number) => n.toFixed(COORD_DECIMALS)
  const bucket = Math.floor(q.departureMs / BUCKET_MS) * BUCKET_MS
  return [CACHE_KEY_VERSION, r(q.fromLat), r(q.fromLng), r(q.toLat), r(q.toLng), q.mode, bucket].join('|')
}
