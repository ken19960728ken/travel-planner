import type { StopSchedule, LegDuration, ScheduleWarning } from './types'
import { resolveStopParticipants } from './participants'

const MINUTE_MS = 60 * 1000

/**
 * 單一時間軸內的衝突檢查（分軌後由 detectConflicts 對每個參與人各呼叫一次）：
 * - 重疊：每個停留點向後掃描所有在它結束前就開始的停留點（涵蓋 3+ 連環/巢狀重疊），
 *   遇到第一個不重疊者即停（陣列已按 startsAt 排序，其後必不重疊）
 * - 趕不上：相鄰且無重疊的停留點之間，空檔小於交通所需時間；重疊時不另報，避免雙重警示
 */
function detectInTrack(
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

/** 衝突偵測專用的停留點視圖。
 *  **刻意不把 participantIds 加進 StopSchedule 本身**——slot.ts 與 schedule.ts 共用那個型別
 *  但與參與人完全無關，加上去會讓兩個無關模組被迫填一個永遠是 null 的欄位。 */
export type ConflictStop = StopSchedule & { participantIds: unknown }

/** 分軌後的衝突偵測（設計文件 2026-08-11-participants §4.3）。
 *
 *  **同一個人**時間重疊才是真衝突；**不同人**時間重疊是分頭行動，不該報警——分頭時段必然
 *  重疊，不分軌的話那幾個小時會整片紅，而那正是使用者刻意安排的。
 *
 *  roster 省略或為空時逐項等同分軌前的行為（測試鎖住），既有行程零變化。 */
export function detectConflicts(
  stops: ConflictStop[],
  legs: LegDuration[],
  roster: readonly string[] = [],
): ScheduleWarning[] {
  if (roster.length === 0) return detectInTrack(stops, legs)
  const resolved = new Map(stops.map(s => [s.id, resolveStopParticipants(s.participantIds, roster)]))
  const seen = new Set<string>()
  const out: ScheduleWarning[] = []
  for (const p of roster) {
    for (const w of detectInTrack(stops.filter(s => resolved.get(s.id)!.includes(p)), legs)) {
      // 同一組衝突會被「同時參與的每個人」各自偵測到，以內容去重
      const k = w.type === 'overlap'
        ? `overlap:${[...w.stopIds].sort().join('|')}`
        : `tight:${w.fromStopId}→${w.toStopId}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(w)
    }
  }
  return out
}
