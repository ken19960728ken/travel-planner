/** epoch ms → datetime-local input 值（瀏覽器時區）。Plan 3 引入停留點時區顯示後再精算。 */
export function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local input 值 → epoch ms（瀏覽器時區解讀） */
export function fromDatetimeLocalValue(value: string): number {
  return new Date(value).getTime()
}
