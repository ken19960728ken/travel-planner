/** leg 狀態判斷與時長文案的單一來源（N-1：legUi.ts 與 exportRows.ts 皆從此處取用，避免三處文案漂移）。
 *  結構型別（不 import app 層的 Leg，也不 import exportRows 的 ExportLeg）：兩者的 duration_minutes/
 *  detail 欄位形狀相同，交給 TS 結構化型別自然相容——domain 層不依賴 app 層型別（沿既有分層邊界）。 */
export type LegStatusInput = {
  duration_minutes: number | null
  detail: unknown
}

/** sync 寫入的查無路線標記（spec §6：查無路線 → 引導手動填寫） */
export function isNoRoute(leg: LegStatusInput): boolean {
  return typeof leg.detail === 'object' && leg.detail !== null && (leg.detail as { no_route?: boolean }).no_route === true
}

/** sync 寫入的日本大眾運輸 fallback 標記：Google 對此路段未提供大眾運輸班次資料（不支援地區或無合適
 *  路線）。I-2 方案 (a)：duration_minutes 在此情境下是步行估算（sync 保留 Google 回傳的純步行時長），
 *  不是大眾運輸班次時間——衝突偵測仍可使用，但顯示文案需明確標註。 */
export function isNoTransitData(leg: LegStatusInput): boolean {
  return typeof leg.detail === 'object' && leg.detail !== null &&
    (leg.detail as { no_transit_data?: boolean }).no_transit_data === true
}

/** 連接條/側欄/Excel 的完整時長文案。優先序（M-3：detail 同時髒污含 no_route 與 no_transit_data 的
 *  邊界情境）——duration_minutes 是否有值才是主要判準：有值代表拿得到實際時間（no_transit_data 的
 *  正常型態即屬此類，額外標註為步行估算）；null 時才退回 no_route／待計算，此時 no_route 優先於
 *  no_transit_data（no_route 代表整條路線都算不出來，語意更強，正常流程也不會出現 duration 為 null
 *  的 no_transit_data）。 */
export function legDurationText(leg: LegStatusInput): string {
  if (leg.duration_minutes !== null) {
    return isNoTransitData(leg) ? `無大眾運輸資料（步行約 ${leg.duration_minutes} 分）` : `${leg.duration_minutes} 分`
  }
  return isNoRoute(leg) ? '查無路線' : '待計算'
}
