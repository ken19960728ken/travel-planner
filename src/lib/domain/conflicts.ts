import type { StopSchedule, LegDuration, ScheduleWarning } from './types'

const MINUTE_MS = 60 * 1000

/**
 * 對按時間排序後的停留點檢查：
 * - 重疊：每個停留點向後掃描所有在它結束前就開始的停留點（涵蓋 3+ 連環/巢狀重疊），
 *   遇到第一個不重疊者即停（陣列已按 startsAt 排序，其後必不重疊）
 * - 趕不上：相鄰且無重疊的停留點之間，空檔小於交通所需時間；重疊時不另報，避免雙重警示
 */
export function detectConflicts(
  stops: StopSchedule[],
  legs: LegDuration[],
): ScheduleWarning[] {
  const sorted = [...stops].sort((a, b) => a.startsAt - b.startsAt)
  const warnings: ScheduleWarning[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startsAt >= cur.endsAt) break
      warnings.push({ type: 'overlap', stopIds: [cur.id, sorted[j].id] })
    }
    const next = sorted[i + 1]
    if (next.startsAt >= cur.endsAt) {
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
  }
  return warnings
}
