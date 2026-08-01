/** 評分白名單分類（Places API (New) type 字串，經官方 Table A/B 核對）：命中任一即代表「值得多打一次
 *  Enterprise 批次」抓 rating/userRatingCount/priceLevel/regularOpeningHours（每月免費額度 1,000 次）。
 *  車站/機場/加油站/ATM 等未列入者一律不主動抓，改由使用者按「查看評分」延遲觸發，見 PlacePreviewCard。 */
const RATABLE_TYPES = new Set([
  'restaurant',
  'cafe',
  'bar',
  'bakery',
  'food',
  'meal_takeaway',
  'tourist_attraction',
  'museum',
  'park',
  'lodging',
  'shopping_mall',
  'store',
  'art_gallery',
  'zoo',
  'amusement_park',
])

export function isRatableCategory(types: readonly string[], primaryType: string | null | undefined): boolean {
  if (primaryType && RATABLE_TYPES.has(primaryType)) return true
  return types.some(t => RATABLE_TYPES.has(t))
}

const PRICE_LEVEL_LABELS: Record<string, string> = {
  FREE: '免費',
  INEXPENSIVE: '¥',
  MODERATE: '¥¥',
  EXPENSIVE: '¥¥¥',
  VERY_EXPENSIVE: '¥¥¥¥',
}

export function priceLevelLabel(level: string | null | undefined): string | null {
  if (!level) return null
  return PRICE_LEVEL_LABELS[level] ?? null
}

/** 以 place_id 組「在 Google Maps 開啟」連結，不額外呼叫 fetchFields 抓 googleMapsURI——
 *  比對 Enterprise 批次成本更低（零 API 呼叫），符合「擇低成本者」的要求。
 *  官方文件的 Search action 格式：query 為必填的文字備援，query_place_id 才是實際定位依據。 */
export function googleMapsSearchUrl(placeId: string, name: string): string {
  const params = new URLSearchParams({ api: '1', query: name, query_place_id: placeId })
  return `https://www.google.com/maps/search/?${params.toString()}`
}
