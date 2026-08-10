import { decodePolyline, greatCirclePoints, type LatLng } from './polyline'

/** `legs.custom_path` 的點數上限，與 migration 20260810000000 的 check constraint 同值。
 *  橫跨九州的鐵路線用不到 40 點；100 給足餘裕，同時讓分享頁 payload 有上界
 *  （100 點約 2KB，與 polyline 的 4000 字元上限同量級）。 */
export const MAX_CUSTOM_PATH_POINTS = 100

/** resolveRoutePath 需要的最小欄位。**刻意不 import app 層的 `Leg` 型別**——domain 層自帶最小輸入
 *  型別，沿 snapshot.ts / exportRows.ts 的既有慣例。`custom_path` 宣告為 unknown 是刻意的：
 *  資料來自 DB／分享 RPC，形狀不可信，強迫必須先過 parseCustomPath。 */
export type RoutePathLeg = {
  custom_path: unknown
  polyline: string | null
  mode: string
}

function isValidPoint(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [lat, lng] = value
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  )
}

/** 把 DB 讀到的未知形狀轉成乾淨的 LatLng[]。
 *
 *  **個別丟棄壞元素而非整批放棄**：局部損壞時仍能畫出大部分路徑，比整條消失好。
 *  這層防禦是刻意的——Realtime 的 presence payload 曾因信任遠端資料形狀（缺欄位）
 *  導致所有成員頁面在 render 期崩潰（spec §8 C-1），本欄位從一開始就驗。
 *
 *  截斷而非拒絕：DB 已有 check constraint 擋 100 點以上，這裡的截斷是對「約束建立前寫入的
 *  舊資料」與「約束被繞過」的第二道防線，不該因此讓整條路徑消失。 */
export function parseCustomPath(raw: unknown): LatLng[] {
  if (!Array.isArray(raw)) return []
  const out: LatLng[] = []
  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_PATH_POINTS) break
    if (!isValidPoint(item)) continue
    out.push({ lat: item[0], lng: item[1] })
  }
  return out
}

/** 手繪路徑只存中間轉折點，頭尾在渲染時接上停留點「目前」的位置——停留點被拖到別處時，
 *  路徑自動重新接上，不會出現線與圖釘對不齊。 */
export function withEndpoints(waypoints: readonly LatLng[], from: LatLng, to: LatLng): LatLng[] {
  return [from, ...waypoints, to]
}

/** 交通段要畫的路徑，單一優先序來源——地圖靜態路線、播放漸進紅線、播放頭取位、分段取景
 *  四處共用這一份，避免各寫一份而語義漂移。
 *
 *  優先序：
 *  1. `custom_path`（使用者手繪）— 接上頭尾停留點
 *  2. `polyline`（Google 衍生）— 本身已含端點，不再接
 *  3. flight 且兩者皆無 — 大圓弧（Google 不提供航線幾何）
 *  4. 其餘 — null，呼叫端自行退回兩點直線內插
 */
export function resolveRoutePath(leg: RoutePathLeg, from: LatLng, to: LatLng): LatLng[] | null {
  const waypoints = parseCustomPath(leg.custom_path)
  if (waypoints.length > 0) return withEndpoints(waypoints, from, to)
  if (leg.polyline) return decodePolyline(leg.polyline)
  if (leg.mode === 'flight') return greatCirclePoints(from, to)
  return null
}
