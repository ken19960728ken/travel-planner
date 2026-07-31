import type { StopSchedule } from './types'

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
