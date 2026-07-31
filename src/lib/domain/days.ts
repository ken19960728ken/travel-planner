import { localDateKey } from './tz'

/** 行程起訖（yyyy-MM-dd）展開為連續日期鍵；用 UTC 正午避開時區日界問題 */
export function tripDayKeys(startDate: string, endDate: string): string[] {
  const keys: string[] = []
  const cur = new Date(`${startDate}T12:00:00Z`)
  const end = new Date(`${endDate}T12:00:00Z`)
  while (cur.getTime() <= end.getTime()) {
    keys.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return keys
}

type FilterStop = { starts_at: string; timezone: string }

/** 過濾某日（依各停留點自身時區的當地日期）的停留點並按開始時間排序。
 *  已知限制：跨午夜停留點只歸屬「開始日」，結束日不顯示延續（記於 spec §8）。 */
export function filterDayStops<T extends FilterStop>(stops: T[], day: string): T[] {
  return [...stops]
    .filter(s => localDateKey(new Date(s.starts_at).getTime(), s.timezone) === day)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
}
