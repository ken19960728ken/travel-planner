import type { Stop, Leg } from './TripView'
import { adjacentPairs } from '@/lib/domain/legSync'
import { detectConflicts } from '@/lib/domain/conflicts'
import type { ScheduleWarning } from '@/lib/domain/types'

export type DayView = {
  dayLegs: Array<{ from: Stop; to: Stop; leg: Leg }>
  warnings: ScheduleWarning[]
  conflictIds: Set<string>
  tightPairs: Set<string>
}

/** 當日 leg 配對 + 衝突/趕不上警示的單一計算來源（審查 M-4 根治：Timeline 的連接條渲染與側欄
 *  警示都讀這裡的 dayLegs/warnings，避免各自組裝出現不一致）。邏輯照搬自原 Timeline.tsx 內部計算，
 *  零改動——dayStops 需已按當日過濾（filterDayStops）；stops/legs 為全行程資料，
 *  跨夜段的相鄰配對需要全行程順序才能判定（M-4：跨夜段顯示在出發日末尾）。 */
export function buildDayView(dayStops: Stop[], stops: Stop[], legs: Leg[]): DayView {
  const nextByStopId = new Map(
    adjacentPairs(stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime() })))
      .map(([f, t]) => [f.id, t.id]),
  )
  const stopById = new Map(stops.map(s => [s.id, s]))
  const legByPair = new Map(legs.map(l => [`${l.from_stop_id}→${l.to_stop_id}`, l]))
  const dayLegs = dayStops
    .map(s => {
      const next = stopById.get(nextByStopId.get(s.id) ?? '')
      const leg = next ? legByPair.get(`${s.id}→${next.id}`) : undefined
      return next && leg ? { from: s, to: next, leg } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const warnings = detectConflicts(
    dayStops.map(s => ({
      id: s.id,
      startsAt: new Date(s.starts_at).getTime(),
      endsAt: new Date(s.ends_at).getTime(),
      locked: s.locked,
    })),
    dayLegs
      .filter(x => x.leg.duration_minutes !== null)
      .map(x => ({ fromStopId: x.from.id, toStopId: x.to.id, durationMinutes: x.leg.duration_minutes! })),
  )
  const conflictIds = new Set(
    warnings.flatMap(w => (w.type === 'overlap' ? w.stopIds : [w.fromStopId, w.toStopId])),
  )
  const tightPairs = new Set(
    warnings.filter(w => w.type === 'transit_too_tight').map(w => `${w.fromStopId}→${w.toStopId}`),
  )

  return { dayLegs, warnings, conflictIds, tightPairs }
}
