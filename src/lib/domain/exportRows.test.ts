import { describe, it, expect } from 'vitest'
import { buildItineraryRows, type ExportTrip, type ExportStop, type ExportLeg } from './exportRows'

const TZ = 'Asia/Tokyo' // UTC+9 無夏令，結果與執行機器時區無關
const trip = (over: Partial<ExportTrip> = {}): ExportTrip => ({
  start_date: '2026-08-01', end_date: '2026-08-03', ...over,
})
const mkStop = (over: Partial<ExportStop> & { id: string; startsAt: number; endsAt: number }): ExportStop => ({
  name: over.id, timezone: TZ, estimated_cost: null, notes: null,
  starts_at: new Date(over.startsAt).toISOString(), ends_at: new Date(over.endsAt).toISOString(),
  ...over,
})
const mkLeg = (over: Partial<ExportLeg> & { id: string; from_stop_id: string; to_stop_id: string }): ExportLeg => ({
  mode: 'transit', duration_minutes: 20, detail: null, source: 'auto', estimated_cost: null,
  ...over,
})

describe('buildItineraryRows', () => {
  it('空行程回傳只有 total 0', () => {
    expect(buildItineraryRows(trip(), [], [])).toEqual([{ kind: 'total', cost: 0 }])
  })

  it('Day 分組依停留點自身時區，略過無停留點的日（Day 編號對齊全域日期序，與 Timeline D-tab 一致）', () => {
    const x = mkStop({ id: 'X', startsAt: Date.UTC(2026, 7, 1, 0, 0), endsAt: Date.UTC(2026, 7, 1, 1, 0) }) // 8/1 JST
    const z = mkStop({ id: 'Z', startsAt: Date.UTC(2026, 7, 2, 20, 0), endsAt: Date.UTC(2026, 7, 2, 21, 0) }) // 8/3 05:00 JST
    const rows = buildItineraryRows(trip(), [x, z], [])
    const dayLabels = rows.filter(r => r.kind === 'day').map(r => (r as { label: string }).label)
    expect(dayLabels).toEqual(['Day 1・2026-08-01', 'Day 3・2026-08-03'])
  })

  it('停留點行含當地 HH:mm–HH:mm 與停留分鐘', () => {
    const a = mkStop({ id: 'A', startsAt: Date.UTC(2026, 7, 1, 0, 0), endsAt: Date.UTC(2026, 7, 1, 1, 30) }) // 09:00–10:30 JST
    const rows = buildItineraryRows(trip(), [a], [])
    const stopRow = rows.find(r => r.kind === 'stop')
    expect(stopRow).toMatchObject({ kind: 'stop', time: '09:00–10:30', name: 'A', stayMinutes: 90, cost: null, notes: null })
  })

  it('leg 行插在 from 停留點之後，同日 crossDay 為 null', () => {
    const a = mkStop({ id: 'A', startsAt: Date.UTC(2026, 7, 1, 0, 0), endsAt: Date.UTC(2026, 7, 1, 1, 0) })
    const b = mkStop({ id: 'B', startsAt: Date.UTC(2026, 7, 1, 3, 0), endsAt: Date.UTC(2026, 7, 1, 4, 0) })
    const leg = mkLeg({ id: 'L', from_stop_id: 'A', to_stop_id: 'B', mode: 'walking', duration_minutes: 15 })
    const rows = buildItineraryRows(trip(), [a, b], [leg])
    const kinds = rows.map(r => r.kind)
    expect(kinds).toEqual(['day', 'stop', 'leg', 'stop', 'total'])
    expect(rows[2]).toMatchObject({ kind: 'leg', modeLabel: '步行', durationText: '15 分', crossDay: null, detached: false })
  })

  it('跨夜 leg 標「→ MM-DD 名稱」', () => {
    const a = mkStop({ id: 'A', startsAt: Date.UTC(2026, 7, 1, 13, 0), endsAt: Date.UTC(2026, 7, 1, 14, 0) }) // 8/1 22:00–23:00 JST
    const b = mkStop({ id: 'B', startsAt: Date.UTC(2026, 7, 1, 15, 30), endsAt: Date.UTC(2026, 7, 1, 16, 0) }) // 8/2 00:30 JST
    const leg = mkLeg({ id: 'L', from_stop_id: 'A', to_stop_id: 'B' })
    const rows = buildItineraryRows(trip(), [a, b], [leg])
    const legRow = rows.find(r => r.kind === 'leg')
    expect(legRow).toMatchObject({ crossDay: '→ 08-02 B' })
  })

  it('duration_minutes null 且非 no_route 時顯示「待計算」', () => {
    const a = mkStop({ id: 'A', startsAt: Date.UTC(2026, 7, 1, 0, 0), endsAt: Date.UTC(2026, 7, 1, 1, 0) })
    const b = mkStop({ id: 'B', startsAt: Date.UTC(2026, 7, 1, 3, 0), endsAt: Date.UTC(2026, 7, 1, 4, 0) })
    const leg = mkLeg({ id: 'L', from_stop_id: 'A', to_stop_id: 'B', duration_minutes: null, detail: null })
    const rows = buildItineraryRows(trip(), [a, b], [leg])
    expect(rows.find(r => r.kind === 'leg')).toMatchObject({ durationText: '待計算' })
  })

  it('duration_minutes null 且 detail.no_route 時顯示「查無路線」', () => {
    const a = mkStop({ id: 'A', startsAt: Date.UTC(2026, 7, 1, 0, 0), endsAt: Date.UTC(2026, 7, 1, 1, 0) })
    const b = mkStop({ id: 'B', startsAt: Date.UTC(2026, 7, 1, 3, 0), endsAt: Date.UTC(2026, 7, 1, 4, 0) })
    const leg = mkLeg({ id: 'L', from_stop_id: 'A', to_stop_id: 'B', duration_minutes: null, detail: { no_route: true } })
    const rows = buildItineraryRows(trip(), [a, b], [leg])
    expect(rows.find(r => r.kind === 'leg')).toMatchObject({ durationText: '查無路線' })
  })

  it('detail.no_transit_data 時顯示「無大眾運輸資料（步行約 N 分）」（I-2 方案 a：保留步行時長）', () => {
    const a = mkStop({ id: 'A', startsAt: Date.UTC(2026, 7, 1, 0, 0), endsAt: Date.UTC(2026, 7, 1, 1, 0) })
    const b = mkStop({ id: 'B', startsAt: Date.UTC(2026, 7, 1, 3, 0), endsAt: Date.UTC(2026, 7, 1, 4, 0) })
    const leg = mkLeg({ id: 'L', from_stop_id: 'A', to_stop_id: 'B', duration_minutes: 35, detail: { no_transit_data: true } })
    const rows = buildItineraryRows(trip(), [a, b], [leg])
    expect(rows.find(r => r.kind === 'leg')).toMatchObject({ durationText: '無大眾運輸資料（步行約 35 分）' })
  })

  it('脫離配對的 leg 列在該日末尾標 detached: true（Task 1 轉存後仍存在）', () => {
    const a = mkStop({ id: 'A', startsAt: Date.UTC(2026, 7, 1, 0, 0), endsAt: Date.UTC(2026, 7, 1, 1, 0) })
    const b = mkStop({ id: 'B', startsAt: Date.UTC(2026, 7, 1, 2, 0), endsAt: Date.UTC(2026, 7, 1, 3, 0) })
    const c = mkStop({ id: 'C', startsAt: Date.UTC(2026, 7, 1, 4, 0), endsAt: Date.UTC(2026, 7, 1, 5, 0) })
    // 插入 B 後 A→C 不再相鄰，轉存 manual 帶花費（Task 1 detachAuto）
    const detachedLeg = mkLeg({ id: 'L1', from_stop_id: 'A', to_stop_id: 'C', source: 'manual', estimated_cost: 500 })
    const normalLeg = mkLeg({ id: 'L2', from_stop_id: 'B', to_stop_id: 'C' })
    const rows = buildItineraryRows(trip(), [a, b, c], [detachedLeg, normalLeg])
    const kinds = rows.map(r => r.kind)
    // day, A, B, leg(B→C), C, leg(A→C detached), total
    expect(kinds).toEqual(['day', 'stop', 'stop', 'leg', 'stop', 'leg', 'total'])
    expect(rows[5]).toMatchObject({ kind: 'leg', detached: true, cost: 500 })
    expect(rows[3]).toMatchObject({ kind: 'leg', detached: false })
  })

  it('花費 null 略過不計入、總計列加總停留點與交通段花費', () => {
    const a = mkStop({ id: 'A', startsAt: Date.UTC(2026, 7, 1, 0, 0), endsAt: Date.UTC(2026, 7, 1, 1, 0), estimated_cost: 1000 })
    const b = mkStop({ id: 'B', startsAt: Date.UTC(2026, 7, 1, 3, 0), endsAt: Date.UTC(2026, 7, 1, 4, 0), estimated_cost: null })
    const leg = mkLeg({ id: 'L', from_stop_id: 'A', to_stop_id: 'B', estimated_cost: 200 })
    const rows = buildItineraryRows(trip(), [a, b], [leg])
    expect(rows.at(-1)).toEqual({ kind: 'total', cost: 1200 })
  })
})
