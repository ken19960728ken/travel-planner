import { normalizeCategory, type StopCategory } from './placeCategory'
import type { StopSchedule } from './types'
import { localDateKey, wallInputToUtcMs } from './tz'

const HOUR_MS = 60 * 60 * 1000
const GAP_MS = 30 * 60 * 1000

/** 分類驅動的預設停留時長（Plan 7 Task 11）。
 *
 *  **住宿刻意維持 60 分鐘、不做「過夜」**：一個 12 小時的住宿區塊會讓 `dayWindow`
 *  （Timeline.tsx 取當日 min(starts)-1h ~ max(ends)+1h）把當日視窗撐到 14 小時，其餘停留點被
 *  壓成不可點擊的細條；同時 `detectConflicts` 會把飯店與隔天所有行程判為時間衝突（整片紅）。
 *  正確做法是給住宿一套獨立的渲染處理，屬另一個 Plan——在那之前，維持 60 分鐘是「零行為變化」
 *  而不是「還沒做」。只有 transport（換乘/取票）與 sight（逛景點）兩桶偏離預設值。 */
const CATEGORY_STAY_MINUTES: Record<StopCategory, number> = {
  transport: 15,
  sight: 90,
  food: 60,
  lodging: 60,
  shopping: 60,
  other: 60,
}

export function stayMsForCategory(category: StopCategory): number {
  return CATEGORY_STAY_MINUTES[normalizeCategory(category)] * 60 * 1000
}

/** 新停留點的預設時段：接在最晚結束的停留點後 30 分鐘；停留時長預設 1 小時。
 *  `stayMs` 為可選——既有呼叫端不傳即維持原行為，不需要一次改完所有地方。 */
export function nextDefaultSlot(
  stops: StopSchedule[],
  fallbackStartMs: number,
  stayMs: number = HOUR_MS,
): { startsAt: number; endsAt: number } {
  if (stops.length === 0) {
    return { startsAt: fallbackStartMs, endsAt: fallbackStartMs + stayMs }
  }
  const lastEnd = Math.max(...stops.map(s => s.endsAt))
  return { startsAt: lastEnd + GAP_MS, endsAt: lastEnd + GAP_MS + stayMs }
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
  /** 停留時長；可選，不傳即 1 小時（既有呼叫端行為不變）。用 stayMsForCategory() 取分類對應值 */
  stayMs: number = HOUR_MS,
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
    // endsAt > 0 是內化的不變式（原本在 TripView 是 `lastInsertedEndRef.current > 0`）：
    // 若接線端傳進 endsAt=0，空日的 daySchedule 會變成非空，nextDefaultSlot 改以 lastEnd=0 起算，
    // 算出 1970-01-01T00:30Z 而非當地 09:00。守衛留在呼叫端會在接線時流失，故收進函式內。
    ...(pending && pending.endsAt > 0 && pending.day === targetDay
      ? [{ id: '__pending__', startsAt: pending.endsAt - 1, endsAt: pending.endsAt, locked: false }]
      : []),
  ]
  return nextDefaultSlot(daySchedule, fallback, stayMs)
}
