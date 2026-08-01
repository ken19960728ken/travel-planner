import type { Leg } from './TripView'

export const MODE_ICON: Record<Leg['mode'], string> = {
  transit: '🚇', walking: '🚶', driving: '🚗', flight: '✈️', custom: '✏️',
}
export const MODE_LABEL: Record<Leg['mode'], string> = {
  transit: '大眾運輸', walking: '步行', driving: '開車', flight: '航班', custom: '自訂',
}
/** sync 寫入的查無路線標記（spec §6：查無路線 → 引導手動填寫） */
export function isNoRoute(leg: Leg): boolean {
  return typeof leg.detail === 'object' && leg.detail !== null && (leg.detail as { no_route?: boolean }).no_route === true
}
/** sync 寫入的日本大眾運輸 fallback 標記：Google 不支援此地區的大眾運輸或無合適路線（見 routes.ts 註解） */
export function isNoTransitData(leg: Leg): boolean {
  return typeof leg.detail === 'object' && leg.detail !== null &&
    (leg.detail as { no_transit_data?: boolean }).no_transit_data === true
}
/** 連接條/側欄的時長文案 */
export function legDurationText(leg: Leg): string {
  if (leg.duration_minutes !== null) return `${leg.duration_minutes} 分`
  if (isNoTransitData(leg)) return '無大眾運輸資料'
  return isNoRoute(leg) ? '查無路線' : '待計算'
}
