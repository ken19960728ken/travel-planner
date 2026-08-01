import type { StopSchedule } from './types'
import { localDateKey, wallInputToUtcMs } from './tz'

const HOUR_MS = 60 * 60 * 1000
const GAP_MS = 30 * 60 * 1000

/** 新停留點的預設時段：接在最晚結束的停留點後 30 分鐘、停留 1 小時；空行程從 fallback 開始。 */
export function nextDefaultSlot(
  stops: StopSchedule[],
  fallbackStartMs: number,
): { startsAt: number; endsAt: number } {
  if (stops.length === 0) {
    return { startsAt: fallbackStartMs, endsAt: fallbackStartMs + HOUR_MS }
  }
  const lastEnd = Math.max(...stops.map(s => s.endsAt))
  return { startsAt: lastEnd + GAP_MS, endsAt: lastEnd + GAP_MS + HOUR_MS }
}

type DaySlotStop = { starts_at: string; ends_at: string; locked: boolean; timezone: string }

/** 某日新停留點的預設時段（day-aware）：只用當日既有停留點排定時段，避開多日預設時段疊加。
 *  參考時區依序 fallback：當日最後一個停留點時區 → 全行程最後一個停留點時區 → browserTimezone；
 *  空日從該時區當地 09:00 起算。pending 僅在 pending.day 等於 targetDay 時以 1ms 區間墊底，
 *  避免 router.refresh() 落地前連續加入算出相同時段（跨日不墊底，避免污染）。 */
export function defaultSlotForDay(
  stops: readonly DaySlotStop[],
  targetDay: string,
  pending: { day: string; endsAt: number } | null,
  browserTimezone: string,
): { startsAt: number; endsAt: number } {
  const dayStops = stops.filter(s => localDateKey(new Date(s.starts_at).getTime(), s.timezone) === targetDay)
  const refTz = dayStops[dayStops.length - 1]?.timezone ?? stops[stops.length - 1]?.timezone ?? browserTimezone
  const fallback = wallInputToUtcMs(`${targetDay}T09:00`, refTz)
  const daySchedule: StopSchedule[] = [
    ...dayStops.map(s => ({
      id: '',
      startsAt: new Date(s.starts_at).getTime(),
      endsAt: new Date(s.ends_at).getTime(),
      locked: s.locked,
    })),
    ...(pending && pending.day === targetDay
      ? [{ id: '__pending__', startsAt: pending.endsAt - 1, endsAt: pending.endsAt, locked: false }]
      : []),
  ]
  return nextDefaultSlot(daySchedule, fallback)
}
