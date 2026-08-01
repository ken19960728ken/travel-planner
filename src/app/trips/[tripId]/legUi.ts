import type { Leg } from './TripView'
// N-1：isNoRoute/isNoTransitData/legDurationText 下沉到 domain 層單一來源（legStatus.ts），
// legUi.ts 只 re-export 供既有呼叫點沿用，避免與 exportRows.ts 的文案各自維護、逐漸漂移。
import { isNoRoute, isNoTransitData, legDurationText } from '@/lib/domain/legStatus'

export const MODE_ICON: Record<Leg['mode'], string> = {
  transit: '🚇', walking: '🚶', driving: '🚗', flight: '✈️', custom: '✏️',
}
export const MODE_LABEL: Record<Leg['mode'], string> = {
  transit: '大眾運輸', walking: '步行', driving: '開車', flight: '航班', custom: '自訂',
}
export { isNoRoute, isNoTransitData, legDurationText }

/** Timeline 連接條專用短標籤（空間有限，容器另補 text-ellipsis 截斷）：no_transit_data 顯示
 *  「步行約N分」，其餘與 legDurationText 一致。側欄（TripView）與 Excel 匯出一律用完整版
 *  legDurationText，只有連接條這種窄空間才需要縮短（M-1）。 */
export function legDurationShortText(leg: Leg): string {
  if (leg.duration_minutes !== null) {
    return isNoTransitData(leg) ? `步行約${leg.duration_minutes}分` : `${leg.duration_minutes} 分`
  }
  return isNoTransitData(leg) ? '無班次資料' : isNoRoute(leg) ? '查無路線' : '待計算'
}
