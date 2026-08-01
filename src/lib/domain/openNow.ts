/** 一週營業時段（皆為地點當地時區）：day 0=週日...6=週六，minutes 為當日分鐘數 [0, 1440)。
 *  close 為 null 代表 Google 回傳的該時段沒有打烊時間——官方定義為「當天 24 小時營業」。 */
export type OpeningPeriod = {
  openDay: number
  openMinutes: number
  closeDay: number | null
  closeMinutes: number | null
}

const DAY_MINUTES = 24 * 60
const WEEK_MINUTES = 7 * DAY_MINUTES

/** 判斷「現在」（週幾＋當日分鐘數，須與 periods 同一時區）是否落在任一營業時段內。
 *  跨夜／跨週日邊界（例如週六 22:00 開到週日 02:00）用平移前一週/當週/下一週三份區間涵蓋，
 *  避免邊界附近誤判。 */
export function isOpenNow(periods: readonly OpeningPeriod[], nowDay: number, nowMinutes: number): boolean {
  const nowTotal = nowDay * DAY_MINUTES + nowMinutes
  return periods.some(period => {
    if (period.closeDay === null || period.closeMinutes === null) return true // 24 小時營業
    const openTotal = period.openDay * DAY_MINUTES + period.openMinutes
    let closeTotal = period.closeDay * DAY_MINUTES + period.closeMinutes
    if (closeTotal <= openTotal) closeTotal += WEEK_MINUTES // 跨夜/跨週：打烊點往後平移一週長度
    return [-WEEK_MINUTES, 0, WEEK_MINUTES].some(shift => nowTotal >= openTotal + shift && nowTotal < closeTotal + shift)
  })
}
