import { adjacentPairs } from './legSync'
import { tripDayKeys, filterDayStops } from './days'
import { formatLocalTime, localDateKey } from './tz'
import { totalEstimatedCost } from './cost'
import { legDurationText } from './legStatus'

/** exportRows 屬 domain 層，輸入型別自帶最小欄位（不 import app 層的 TripView/legUi）。 */
export type ExportTrip = { start_date: string; end_date: string }
export type ExportStop = {
  id: string
  name: string
  timezone: string
  starts_at: string
  ends_at: string
  estimated_cost: number | null
  notes: string | null
}
export type ExportLegMode = 'transit' | 'walking' | 'driving' | 'flight' | 'custom'
export type ExportLeg = {
  id: string
  from_stop_id: string
  to_stop_id: string
  mode: ExportLegMode
  duration_minutes: number | null
  detail: unknown
  source: 'auto' | 'manual'
  estimated_cost: number | null
}

/** xlsx 行別模型：discriminated union，逐列對應 exceljs worksheet 的一列。 */
export type ItineraryRow =
  | { kind: 'day'; label: string }
  | { kind: 'stop'; time: string; name: string; stayMinutes: number; cost: number | null; notes: string | null }
  | { kind: 'leg'; modeLabel: string; durationText: string; cost: number | null; crossDay: string | null; detached: boolean }
  | { kind: 'total'; cost: number }

const MODE_LABEL: Record<ExportLegMode, string> = {
  transit: '大眾運輸', walking: '步行', driving: '開車', flight: '航班', custom: '自訂',
}

/** 純函式：把 trip/stops/legs 轉成 xlsx 匯出用的行別陣列。
 *  Day 分組與 leg 歸屬規則沿 TripView M-4：leg 掛在 from 停留點之後，歸屬 from 所屬日；
 *  Day 編號採 tripDayKeys 的全域位置（與 Timeline 的 D-tab 一致），沒有停留點的日整段略過不輸出。
 *  脫離配對的 leg（Task 1 detachAuto 轉存後仍存在）列在該日所有正常列之後，標 detached: true。 */
export function buildItineraryRows(trip: ExportTrip, stops: ExportStop[], legs: ExportLeg[]): ItineraryRow[] {
  const rows: ItineraryRow[] = []
  const stopById = new Map(stops.map(s => [s.id, s]))
  const nextByStopId = new Map(
    adjacentPairs(stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime() })))
      .map(([f, t]) => [f.id, t.id]),
  )
  const legByPair = new Map(legs.map(l => [`${l.from_stop_id}→${l.to_stop_id}`, l]))
  const dayOf = (s: ExportStop) => localDateKey(new Date(s.starts_at).getTime(), s.timezone)

  const legRow = (leg: ExportLeg, day: string, detached: boolean): ItineraryRow => {
    const to = stopById.get(leg.to_stop_id)
    const crossDay = to && dayOf(to) !== day ? `→ ${dayOf(to).slice(5)} ${to.name}` : null
    return {
      kind: 'leg', modeLabel: MODE_LABEL[leg.mode], durationText: legDurationText(leg),
      cost: leg.estimated_cost, crossDay, detached,
    }
  }

  const dayKeys = tripDayKeys(trip.start_date, trip.end_date)
  for (let i = 0; i < dayKeys.length; i++) {
    const day = dayKeys[i]
    const dayStops = filterDayStops(stops, day)
    if (dayStops.length === 0) continue // 沒有停留點的日整段略過（空行程只剩 total）

    rows.push({ kind: 'day', label: `Day ${i + 1}・${day}` })
    for (const stop of dayStops) {
      rows.push({
        kind: 'stop',
        time: `${formatLocalTime(new Date(stop.starts_at).getTime(), stop.timezone)}–${formatLocalTime(new Date(stop.ends_at).getTime(), stop.timezone)}`,
        name: stop.name,
        stayMinutes: Math.round((new Date(stop.ends_at).getTime() - new Date(stop.starts_at).getTime()) / 60_000),
        cost: stop.estimated_cost,
        notes: stop.notes,
      })
      const nextId = nextByStopId.get(stop.id)
      const leg = nextId ? legByPair.get(`${stop.id}→${nextId}`) : undefined
      if (leg) rows.push(legRow(leg, day, false))
    }

    // Important-2 根治的匯出對應：配對脫離的 leg 不會出現在上面的正常插入位置（legByPair 命中不到，
    // 因為 to_stop_id 不是 from_stop_id 的 nextByStopId），歸屬 from 停留點所屬日，列在該日末尾。
    const detached = legs.filter(l => {
      const from = stopById.get(l.from_stop_id)
      return from !== undefined && dayOf(from) === day && nextByStopId.get(l.from_stop_id) !== l.to_stop_id
    })
    for (const leg of detached) rows.push(legRow(leg, day, true))
  }

  const total = totalEstimatedCost([
    ...stops.map(s => ({ estimatedCost: s.estimated_cost })),
    ...legs.map(l => ({ estimatedCost: l.estimated_cost })),
  ])
  rows.push({ kind: 'total', cost: total })
  return rows
}
