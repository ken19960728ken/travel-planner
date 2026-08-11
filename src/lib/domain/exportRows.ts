import { nextIdsByStop } from './legSync'
import { tripDayKeys, filterDayStops } from './days'
import { formatLocalTime, localDateKey } from './tz'
import { totalEstimatedCost, costByCategory, costByParticipant } from './cost'
import { parseRoster, resolveStopParticipants, legParticipants, type Participant } from './participants'
import { legDurationText } from './legStatus'
import { CATEGORY_ORDER, CATEGORY_LABEL, normalizeCategory, type StopCategory } from './placeCategory'

/** exportRows 屬 domain 層，輸入型別自帶最小欄位（不 import app 層的 TripView/legUi）。 */
export type ExportTrip = {
  start_date: string
  end_date: string
  /** 參與人名冊。形狀不可信，builder 內用 parseRoster 清洗。 */
  participants: unknown
}
export type ExportStop = {
  id: string
  name: string
  timezone: string
  starts_at: string
  ends_at: string
  estimated_cost: number | null
  notes: string | null
  category: StopCategory
  /** 誰會去。形狀不可信（來自 DB），一律經 resolveStopParticipants 解讀。 */
  participant_ids: unknown
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
  | { kind: 'stop'; time: string; name: string; category: string; stayMinutes: number; cost: number | null; notes: string | null; participants: string }
  | { kind: 'leg'; modeLabel: string; durationText: string; cost: number | null; crossDay: string | null; detached: boolean; participants: string }
  | { kind: 'categoryTotal'; label: string; cost: number }
  | { kind: 'total'; cost: number }
  /** 每人應付（分頭行動的分帳）。排在 total 之後；不變量：sum(participantTotal) === total */
  | { kind: 'participantTotal'; name: string; cost: number }

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
  const roster: Participant[] = parseRoster(trip.participants)
  const rosterIds = roster.map(p => p.id)
  const whoOf = (s: ExportStop) => resolveStopParticipants(s.participant_ids, rosterIds)
  /** 「全員」不列出所有名字——共同行程是常態，逐格重複整份名單會把表塞爆而零資訊。 */
  const nameList = (ids: readonly string[]): string => {
    if (rosterIds.length === 0) return ''
    if (ids.length === rosterIds.length) return '全員'
    return ids.map(id => roster.find(p => p.id === id)?.name ?? '?').join('、')
  }
  /** 交通段專用：交集為空時標示「全員（無交集）」而非留白，與分帳側的處理一致。 */
  const legNameList = (ids: readonly string[]): string => {
    if (rosterIds.length === 0) return ''
    if (ids.length === 0) return '全員（無交集）'
    return nameList(ids)
  }
  // participantPairs（非 adjacentPairs）：決定「哪個交通段接在哪個停留點之後」。
  // 分頭時單軌配對會把甲的停留點接到乙的停留點上，匯出的表會多一列沒有人走過的交通、
  // 少一列真正走過的（與地圖幻影段是同一個 bug 的匯出版本）。
  // 多值 Map：分頭時一個停留點有多條出邊（甲往 B、乙往 C），單值 Map 會讓第二條靜默蓋掉第一條
  const nextIds = nextIdsByStop(
    stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime(), participantIds: s.participant_ids })),
    rosterIds,
  )
  const legByPair = new Map(legs.map(l => [`${l.from_stop_id}→${l.to_stop_id}`, l]))
  const dayOf = (s: ExportStop) => localDateKey(new Date(s.starts_at).getTime(), s.timezone)

  const legRow = (leg: ExportLeg, day: string, detached: boolean): ItineraryRow => {
    const to = stopById.get(leg.to_stop_id)
    const crossDay = to && dayOf(to) !== day ? `→ ${dayOf(to).slice(5)} ${to.name}` : null
    const from = stopById.get(leg.from_stop_id)
    return {
      kind: 'leg', modeLabel: MODE_LABEL[leg.mode], durationText: legDurationText(leg),
      cost: leg.estimated_cost, crossDay, detached,
      // 交通段的參與人＝前後兩個停留點的交集（設計文件 §2：不獨立儲存，結構上不可能矛盾）。
      // 交集為空只可能出現在「已脫離順序」的段落（起點只有甲、終點只有乙）。此時分帳側是
      // 算給全員的（維持加總不變量，見 cost.ts），欄位若留白就會變成「沒有人參與、卻每個人
      // 都付錢」——兩欄必須講同一個故事（審查 m-4）。
      participants: from && to ? legNameList(legParticipants(whoOf(from), whoOf(to))) : '',
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
        // 匯出用繁中純文字標籤，不用 emoji——Excel 跨平台字型風險
        category: CATEGORY_LABEL[normalizeCategory(stop.category)],
        stayMinutes: Math.round((new Date(stop.ends_at).getTime() - new Date(stop.starts_at).getTime()) / 60_000),
        cost: stop.estimated_cost,
        notes: stop.notes,
        participants: nameList(whoOf(stop)),
      })
      // 分頭時同一個停留點會有多條出邊，逐條輸出（不是只輸出第一條）
      for (const nextId of nextIds.get(stop.id) ?? []) {
        const leg = legByPair.get(`${stop.id}→${nextId}`)
        if (leg) rows.push(legRow(leg, day, false))
      }
    }

    // Important-2 根治的匯出對應：配對脫離的 leg 不會出現在上面的正常插入位置（legByPair 命中不到，
    // 因為 to_stop_id 不是 from_stop_id 的 nextByStopId），歸屬 from 停留點所屬日，列在該日末尾。
    const detached = legs.filter(l => {
      const from = stopById.get(l.from_stop_id)
      return from !== undefined && dayOf(from) === day && !(nextIds.get(l.from_stop_id) ?? []).includes(l.to_stop_id)
    })
    for (const leg of detached) rows.push(legRow(leg, day, true))
  }

  // 分類小計（Plan 7 Task 9）：排在總計之前，金額為 0 的桶不出列。
  // 不變量（exportRows.test.ts 鎖住）：所有 categoryTotal 的 cost 總和 === total 列的 cost。
  const buckets = costByCategory(
    stops.map(s => ({ category: normalizeCategory(s.category), estimatedCost: s.estimated_cost })),
    legs.map(l => ({ estimatedCost: l.estimated_cost })),
  )
  for (const c of CATEGORY_ORDER) {
    if (buckets.byCategory[c] > 0) rows.push({ kind: 'categoryTotal', label: CATEGORY_LABEL[c], cost: buckets.byCategory[c] })
  }
  if (buckets.legs > 0) rows.push({ kind: 'categoryTotal', label: '交通段', cost: buckets.legs })

  const total = totalEstimatedCost([
    ...stops.map(s => ({ estimatedCost: s.estimated_cost })),
    ...legs.map(l => ({ estimatedCost: l.estimated_cost })),
  ])
  rows.push({ kind: 'total', cost: total })

  // 每人應付：每筆花費只分攤給該項目的參與人（交通段取前後停留點的交集）。
  // 不變量（exportRows.test.ts 鎖住）：sum(participantTotal) === **totalForSplit**，
  // 在最小單位上嚴格成立。⚠️ 不是 total 列的 cost——後者是原始浮點加總，有小數金額時
  // 兩者可能差幾分（審查 M-4：舊註解宣稱等於 total，實測 total 100.5 而每人加總 101）。
  if (roster.length > 0) {
    const splitItems = [
      ...stops.map(s => ({ estimatedCost: s.estimated_cost, participantIds: s.participant_ids })),
      ...legs.map(l => {
        const from = stopById.get(l.from_stop_id)
        const to = stopById.get(l.to_stop_id)
        return {
          estimatedCost: l.estimated_cost,
          participantIds: from && to ? legParticipants(whoOf(from), whoOf(to)) : null,
        }
      }),
    ]
    const perParticipant = costByParticipant(splitItems, rosterIds)
    for (const p of roster) rows.push({ kind: 'participantTotal', name: p.name, cost: perParticipant[p.id] ?? 0 })
  }
  return rows
}
