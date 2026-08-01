import type { RouteQuery } from '@/lib/domain/cacheKey'

// 官方 v2 文件（2026-07-31 查證）：
// - POST /directions/v2:computeRoutes；金鑰放 X-Goog-Api-Key header
// - X-Goog-FieldMask 必填；不建議萬用字元（延遲）
// - departureTime 僅 TRANSIT 允許過去時間（-7 天 ~ +100 天）；DRIVE/WALK 不帶（帶過去時間會被拒）
// - top-level routingPreference 僅 DRIVE/TWO_WHEELER 可帶，其餘模式帶了直接失敗——一律不帶
// - WALK 為 beta，官方要求對使用者顯示警語（README 收尾補）
const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const FIELD_MASK = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
// 日本大眾運輸 fallback（2026-08-01）：官方 FAQ 明載 Routes API 不支援日本（與印度鐵路）的大眾運輸，
// TRANSIT 請求有時會回傳一條「純步行」路線，其 duration 與 WALK 模式無異——需要 step 層級的
// travelMode 才能分辨「真的有大眾運輸路線」與「Google 退化成純步行」。欄位路徑查證（2026-08-01）：
// https://developers.google.com/maps/documentation/routes/transit-route（範例 field mask 含
// routes.legs.steps.transitDetails/travelMode）與 RPC 參考
// https://developers.google.com/maps/documentation/routes/reference/rpc/google.maps.routing.v2
// （RouteLegStep.travel_mode 為 RouteTravelMode enum，含 TRANSIT/WALK/DRIVE 等值）。
// 計費驗證（2026-08-01，https://developers.google.com/maps/billing-and-pricing/sku-details）：
// Routes API 的 SKU 分級（Essentials/Pro/Enterprise）只由請求端特徵觸發——Pro：11+ 中繼 waypoint、
// optimizeWaypointOrder、TRAFFIC_AWARE(_OPTIMAL)、位置修飾符；Enterprise：雙輪路徑、過路費計算
// （travelAdvisory.tollInfo）、polyline 路況資訊。routes.legs.steps.travelMode 是結構性欄位，與
// 過路費/路況無關，不在任何升級觸發清單內——只擴充此欄位不會讓 computeRoutes 升級計費 SKU。
// 只有 transit 請求才擴充（DRIVE/WALK 的回應本就全是同一種 travelMode，不需要偵測）。
const TRANSIT_FIELD_MASK = `${FIELD_MASK},routes.legs.steps.travelMode`
const TRAVEL_MODE: Record<RouteQuery['mode'], string> = {
  transit: 'TRANSIT',
  walking: 'WALK',
  driving: 'DRIVE',
}
const DAY_MS = 24 * 60 * 60 * 1000
// 30 天份鐘數（R-2）：正常交通時長不可能這麼長，超過視為 Google 回應格式異常（防禦畸形/惡意資料寫進 duration_minutes）
const MAX_DURATION_MINUTES = 30 * 24 * 60

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
      'X-Goog-FieldMask': q.mode === 'transit' ? TRANSIT_FIELD_MASK : FIELD_MASK,
    },
    body,
  }
}

export type ComputedRoute =
  | { ok: true; durationMinutes: number; distanceMeters: number | null; polyline: string | null }
  | { ok: false; reason: 'no_route' | 'bad_response' | 'no_transit_data' }

/** routes[0] 的 steps 是否含至少一個 TRANSIT step（日本大眾運輸 fallback 偵測，見 TRANSIT_FIELD_MASK 註解）。
 *  legs/steps 缺失（欄位未如預期回傳）視為「無法證明有大眾運輸路線」，同樣判 false——寧可保守也不誤把
 *  純步行時長掛上大眾運輸標籤。 */
function hasTransitStep(route: { legs?: unknown }): boolean {
  const legs = Array.isArray(route.legs) ? route.legs : []
  return legs.some(leg =>
    typeof leg === 'object' && leg !== null && Array.isArray((leg as { steps?: unknown }).steps) &&
    (leg as { steps: unknown[] }).steps.some(step =>
      typeof step === 'object' && step !== null && (step as { travelMode?: unknown }).travelMode === 'TRANSIT'))
}

/** 解析 computeRoutes 回應（純函式）。routes 為空 = 查無路線（官方行為，非 404）。
 *  mode 只用來決定是否做 transit steps 偵測——DRIVE/WALK 的回應全是同一種 travelMode，不判斷。 */
export function parseComputeRoutesResponse(json: unknown, mode: RouteQuery['mode']): ComputedRoute {
  if (typeof json !== 'object' || json === null) return { ok: false, reason: 'bad_response' }
  const routes = (json as { routes?: unknown }).routes
  if (!Array.isArray(routes) || routes.length === 0) return { ok: false, reason: 'no_route' }
  const route = routes[0] as {
    duration?: unknown
    distanceMeters?: unknown
    polyline?: { encodedPolyline?: unknown }
    legs?: unknown
  }
  const m = typeof route.duration === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(route.duration) : null
  if (!m) return { ok: false, reason: 'bad_response' }
  const durationMinutes = Math.max(1, Math.round(Number(m[1]) / 60))
  // M-4：改回 no_route（穩定結論可快取）——bad_response 在 sync 端點被視為暫時性異常不進 route_cache，
  // 會讓這種畸形回應每次 sync 都重打 Google；異常值本身是穩定的（同一段路線不會忽大忽小），值得快取
  if (durationMinutes > MAX_DURATION_MINUTES) return { ok: false, reason: 'no_route' }
  // 日本大眾運輸 fallback：transit 請求但 routes[0] 沒有任何 TRANSIT step，代表 Google 退化成純步行
  // 路線（或該地區不支援）——duration 誠實不寫入 duration_minutes，避免掛著「大眾運輸」標籤誤導使用者
  if (mode === 'transit' && !hasTransitStep(route)) return { ok: false, reason: 'no_transit_data' }
  return {
    ok: true,
    durationMinutes,
    distanceMeters: typeof route.distanceMeters === 'number' ? route.distanceMeters : null,
    polyline: typeof route.polyline?.encodedPolyline === 'string' ? route.polyline.encodedPolyline : null,
  }
}
