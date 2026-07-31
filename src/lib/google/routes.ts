import type { RouteQuery } from '@/lib/domain/cacheKey'

// 官方 v2 文件（2026-07-31 查證）：
// - POST /directions/v2:computeRoutes；金鑰放 X-Goog-Api-Key header
// - X-Goog-FieldMask 必填；不建議萬用字元（延遲）
// - departureTime 僅 TRANSIT 允許過去時間（-7 天 ~ +100 天）；DRIVE/WALK 不帶（帶過去時間會被拒）
// - top-level routingPreference 僅 DRIVE/TWO_WHEELER 可帶，其餘模式帶了直接失敗——一律不帶
// - WALK 為 beta，官方要求對使用者顯示警語（README 收尾補）
const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const FIELD_MASK = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
const TRAVEL_MODE: Record<RouteQuery['mode'], string> = {
  transit: 'TRANSIT',
  walking: 'WALK',
  driving: 'DRIVE',
}
const DAY_MS = 24 * 60 * 60 * 1000

/** TRANSIT 的 departureTime 夾限到官方允許區間（各留 1 天餘裕避開邊界）。
 *  呼叫端以夾限後的值同時組請求與 cache key，兩者永遠一致。 */
export function clampTransitDeparture(departureMs: number, nowMs: number): number {
  return Math.min(Math.max(departureMs, nowMs - 6 * DAY_MS), nowMs + 99 * DAY_MS)
}

export type ComputeRoutesRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 組 computeRoutes 請求（純函式；departureMs 需已夾限）。 */
export function buildComputeRoutesRequest(q: RouteQuery, apiKey: string): ComputeRoutesRequest {
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: q.fromLat, longitude: q.fromLng } } },
    destination: { location: { latLng: { latitude: q.toLat, longitude: q.toLng } } },
    travelMode: TRAVEL_MODE[q.mode],
  }
  if (q.mode === 'transit') body.departureTime = new Date(q.departureMs).toISOString()
  return {
    url: ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body,
  }
}

export type ComputedRoute =
  | { ok: true; durationMinutes: number; distanceMeters: number | null; polyline: string | null }
  | { ok: false; reason: 'no_route' | 'bad_response' }

/** 解析 computeRoutes 回應（純函式）。routes 為空 = 查無路線（官方行為，非 404）。 */
export function parseComputeRoutesResponse(json: unknown): ComputedRoute {
  if (typeof json !== 'object' || json === null) return { ok: false, reason: 'bad_response' }
  const routes = (json as { routes?: unknown }).routes
  if (!Array.isArray(routes) || routes.length === 0) return { ok: false, reason: 'no_route' }
  const route = routes[0] as { duration?: unknown; distanceMeters?: unknown; polyline?: { encodedPolyline?: unknown } }
  const m = typeof route.duration === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(route.duration) : null
  if (!m) return { ok: false, reason: 'bad_response' }
  return {
    ok: true,
    durationMinutes: Math.max(1, Math.round(Number(m[1]) / 60)),
    distanceMeters: typeof route.distanceMeters === 'number' ? route.distanceMeters : null,
    polyline: typeof route.polyline?.encodedPolyline === 'string' ? route.polyline.encodedPolyline : null,
  }
}
