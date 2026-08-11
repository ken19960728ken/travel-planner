import type { Stop, Leg } from './TripView'
import { nextIdsByStop } from '@/lib/domain/legSync'
import { detectConflicts } from '@/lib/domain/conflicts'
import { assignLanes, type LaneLayout } from '@/lib/domain/lanes'
import type { ScheduleWarning } from '@/lib/domain/types'

export type DayView = {
  dayLegs: Array<{ from: Stop; to: Stop; leg: Leg }>
  warnings: ScheduleWarning[]
  conflictIds: Set<string>
  tightPairs: Set<string>
  /** Timeline 的分軌版面（審查 M-8）：時間重疊的停留點分到不同水平軌道。
   *  無重疊時 laneCount 恆為 1，Timeline 的高度與版面與改版前完全相同。 */
  lanes: LaneLayout
}

/** 當日 leg 配對 + 衝突/趕不上警示的單一計算來源（審查 M-4 根治：Timeline 的連接條渲染與側欄
 *  警示都讀這裡的 dayLegs/warnings，避免各自組裝出現不一致）。邏輯照搬自原 Timeline.tsx 內部計算——
 *  dayStops 需已按當日過濾（filterDayStops）；stops/legs 為全行程資料，
 *  跨夜段的相鄰配對需要全行程順序才能判定（M-4：跨夜段顯示在出發日末尾）。
 *
 *  roster（2026-08-11 參與人）：**顯示配對與衝突偵測都必須分軌**。這裡的 nextByStopId 決定
 *  「哪個交通段顯示在哪個停留點之後」，用單軌的 adjacentPairs 會在分頭時把甲的停留點接到乙的
 *  停留點上——側欄與 Timeline 會畫出一條沒有人走過的連接條，與 sync 產生幻影段是同一個 bug
 *  的顯示層版本。省略 roster 時退回單軌行為。 */
export function buildDayView(dayStops: Stop[], stops: Stop[], legs: Leg[], roster: readonly string[] = []): DayView {
  // 多值 Map：分頭時一個停留點有多條出邊，單值 Map 會讓第二條靜默蓋掉第一條
  const nextIds = nextIdsByStop(
    stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime(), participantIds: s.participant_ids })),
    roster,
  )
  const stopById = new Map(stops.map(s => [s.id, s]))
  const legByPair = new Map(legs.map(l => [`${l.from_stop_id}→${l.to_stop_id}`, l]))
  const dayLegs = dayStops
    .flatMap(s => (nextIds.get(s.id) ?? []).map(nextId => {
      const next = stopById.get(nextId)
      const leg = next ? legByPair.get(`${s.id}→${next.id}`) : undefined
      return next && leg ? { from: s, to: next, leg } : null
    }))
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const warnings = detectConflicts(
    dayStops.map(s => ({
      id: s.id,
      startsAt: new Date(s.starts_at).getTime(),
      endsAt: new Date(s.ends_at).getTime(),
      locked: s.locked,
      participantIds: s.participant_ids,
    })),
    dayLegs
      .filter(x => x.leg.duration_minutes !== null)
      .map(x => ({ fromStopId: x.from.id, toStopId: x.to.id, durationMinutes: x.leg.duration_minutes! })),
    roster,
  )
  const conflictIds = new Set(
    warnings.flatMap(w => (w.type === 'overlap' ? w.stopIds : [w.fromStopId, w.toStopId])),
  )
  const tightPairs = new Set(
    warnings.filter(w => w.type === 'transit_too_tight').map(w => `${w.fromStopId}→${w.toStopId}`),
  )

  // 分軌只看**時間**不看參與人：真正要解決的是「兩個色塊疊在同一個矩形上，下層看不到也點不到」，
  // 而那與誰去無關。依參與人分軌反而會在「同一個人的兩段行程重疊」（真衝突）時只給一條 lane，
  // 把最該看見的那種重疊藏起來。
  const lanes = assignLanes(dayStops.map(s => ({
    id: s.id,
    startsAt: new Date(s.starts_at).getTime(),
    endsAt: new Date(s.ends_at).getTime(),
  })))

  return { dayLegs, warnings, conflictIds, tightPairs, lanes }
}
