import { fromZonedTime, toZonedTime, format } from 'date-fns-tz'

/** 停留點當地牆面時間（datetime-local 值）→ UTC epoch ms */
export function wallInputToUtcMs(input: string, timeZone: string): number {
  return fromZonedTime(input, timeZone).getTime()
}

/** UTC epoch ms → 停留點當地牆面時間（datetime-local 值 yyyy-MM-ddTHH:mm） */
export function utcMsToWallInput(ms: number, timeZone: string): string {
  return format(toZonedTime(ms, timeZone), "yyyy-MM-dd'T'HH:mm", { timeZone })
}

/** UTC epoch ms → 當地 HH:mm（清單/時間軸顯示用） */
export function formatLocalTime(ms: number, timeZone: string): string {
  return format(toZonedTime(ms, timeZone), 'HH:mm', { timeZone })
}

/** UTC epoch ms → 當地日期鍵 yyyy-MM-dd（Day 分組用） */
export function localDateKey(ms: number, timeZone: string): string {
  return format(toZonedTime(ms, timeZone), 'yyyy-MM-dd', { timeZone })
}
