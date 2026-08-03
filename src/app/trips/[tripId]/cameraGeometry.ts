// 播放鏡頭邊緣閘門（M-7 安全網）的純幾何邏輯，從 TripView.tsx 的 PlaybackCamera 抽出來單獨測試
// （TripView.tsx 是 client component，混雜大量 React/Google Maps 副作用，不適合直接單元測試）。

export type LatLng = { lat: number; lng: number }
export type Viewport = { ne: LatLng; sw: LatLng }

/** 把「東向角距離」正規化到 [0, 360)，讓跨 180 度經線（換日線）的視窗不需要另外分支處理。 */
function normalizeEastwardOffset(deg: number): number {
  const wrapped = deg % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/**
 * 點是否落在視窗「中央 70%」區域內（上下左右各留 padRatio=15% padding）。
 *
 * 經度改用「離視窗西南角的東向角距離」正規化到 [0, 360) 判斷（不是直接比較數值大小），
 * 天然涵蓋跨換日線的視窗（此時 sw.lng > ne.lng，例如 sw=170、ne=-170）——不需要為此另開分支
 * （M-1 根治：原本直接用 `ne.lng() - sw.lng()` 算出負的 padLng，判斷式恆為 false，閘門形同失效）。
 *
 * 零面積視窗（如單點日 fitBounds 之後 ne===sw）一律回傳 false（視為在邊緣），安全退化成每次都追。
 */
export function isInsideCenter(point: LatLng, viewport: Viewport, padRatio = 0.15): boolean {
  const { ne, sw } = viewport
  const latSpan = ne.lat - sw.lat
  if (latSpan <= 0) return false
  const padLat = latSpan * padRatio
  const latInside = point.lat > sw.lat + padLat && point.lat < ne.lat - padLat

  const lngSpan = normalizeEastwardOffset(ne.lng - sw.lng)
  if (lngSpan <= 0) return false
  const padLng = lngSpan * padRatio
  const pointOffset = normalizeEastwardOffset(point.lng - sw.lng)
  const lngInside = pointOffset > padLng && pointOffset < lngSpan - padLng

  return latInside && lngInside
}

/** 是否該把鏡頭 panTo 過去。拿不到目前視窗（如地圖尚未 idle、getBounds() 回傳 undefined）時，
 *  沒有閘門可用，保守地一律追過去——安全但退化，等同閘門加入前的行為。 */
export function shouldPanCamera(point: LatLng, viewport: Viewport | null, padRatio = 0.15): boolean {
  if (!viewport) return true
  return !isInsideCenter(point, viewport, padRatio)
}
