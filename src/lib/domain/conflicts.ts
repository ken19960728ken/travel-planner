import type { StopSchedule, LegDuration, ScheduleWarning } from './types'

const MINUTE_MS = 60 * 1000

/** 對按時間排序後的相鄰停留點檢查：重疊、空檔小於交通所需時間。 */
export function detectConflicts(
  stops: StopSchedule[],
  legs: LegDuration[],
): ScheduleWarning[] {
  const sorted = [...stops].sort((a, b) => a.startsAt - b.startsAt)
  const warnings: ScheduleWarning[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]
    const next = sorted[i + 1]
    if (next.startsAt < cur.endsAt) {
      warnings.push({ type: 'overlap', stopIds: [cur.id, next.id] })
    }
    const leg = legs.find(l => l.fromStopId === cur.id && l.toStopId === next.id)
    if (leg) {
      const gapMinutes = (next.startsAt - cur.endsAt) / MINUTE_MS
      if (gapMinutes < leg.durationMinutes) {
        warnings.push({
          type: 'transit_too_tight',
          fromStopId: cur.id,
          toStopId: next.id,
          gapMinutes,
          requiredMinutes: leg.durationMinutes,
        })
      }
    }
  }
  return warnings
}
