import { categorize, type StopCategory } from './placeCategory'

/** 評分白名單改由 placeCategory.ts 的六值分類推導，不再自維護一份 type 字串清單：命中
 *  food/sight/lodging/shopping 任一即代表「值得多打一次 Enterprise 批次」抓 rating/userRatingCount/
 *  priceLevel/regularOpeningHours（每月免費額度 1,000 次）。transport/other 一律不主動抓，改由使用者
 *  按「查看評分」延遲觸發，見 PlacePreviewCard。
 *  行為變化：白名單涵蓋面從舊版硬編碼的 15 個 type 擴大到 categorize() 對照表 food/sight/lodging/shopping
 *  四桶合計約 320 個 type（逐 Table A/B section 核對後的實際數字，含日本行程常見的拉麵店等 Food and
 *  Drink 細分類，舊版漏掉，見 Plan D2）。
 *  成本量化（明確接受）：只在預覽卡掛載時觸發、一次搜尋最多打一次，`placeDetailCache` 同分頁去重，
 *  單次規劃 session 實際只會發生數十次 Enterprise 呼叫，遠低於每月免費額度 1,000 次。 */
const RATABLE_CATEGORIES = new Set<StopCategory>(['food', 'sight', 'lodging', 'shopping'])

export function isRatableCategory(types: readonly string[], primaryType: string | null | undefined): boolean {
  return RATABLE_CATEGORIES.has(categorize(types, primaryType))
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
