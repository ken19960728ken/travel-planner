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
