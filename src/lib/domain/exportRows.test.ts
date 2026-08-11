import { describe, it, expect } from 'vitest'
import { buildItineraryRows, type ExportTrip, type ExportStop, type ExportLeg } from './exportRows'
import { totalForSplit } from './cost'

const TZ = 'Asia/Tokyo' // UTC+9 無夏令，結果與執行機器時區無關
const trip = (over: Partial<ExportTrip> = {}): ExportTrip => ({
  start_date: '2026-08-01', end_date: '2026-08-03', participants: null, ...over,
})
const mkStop = (over: Partial<ExportStop> & { id: string; startsAt: number; endsAt: number }): ExportStop => ({
  name: over.id, timezone: TZ, estimated_cost: null, notes: null, category: 'other', participant_ids: null,
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
    // day, A, B, leg(B→C), C, leg(A→C detached), 交通段小計, total
    // （categoryTotal 由 Plan 7 Task 9 新增：脫離段帶 500 花費，故「交通段」桶非 0 而出列）
    expect(kinds).toEqual(['day', 'stop', 'stop', 'leg', 'stop', 'leg', 'categoryTotal', 'total'])
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

describe('分類欄與分類小計（Plan 7 Task 9）', () => {
  const t = trip()
  const day1 = Date.UTC(2026, 7, 1, 0, 0) // 09:00 JST

  it('stop 列帶繁中分類標籤（不用 emoji，避免 Excel 跨平台字型問題）', () => {
    const rows = buildItineraryRows(
      t,
      [mkStop({ id: 'a', startsAt: day1, endsAt: day1 + 3_600_000, category: 'food' })],
      [],
    )
    const stop = rows.find(r => r.kind === 'stop')
    expect(stop).toMatchObject({ category: '餐飲' })
    expect(JSON.stringify(rows)).not.toMatch(/🍜|🚉|🗼|🏨|🛒|📍/)
  })

  it('不變量：所有 categoryTotal 的 cost 總和 === total 列的 cost', () => {
    const rows = buildItineraryRows(
      t,
      [
        mkStop({ id: 'a', startsAt: day1, endsAt: day1 + 3_600_000, category: 'food', estimated_cost: 800 }),
        mkStop({ id: 'b', startsAt: day1 + 7_200_000, endsAt: day1 + 10_800_000, category: 'sight', estimated_cost: 1200 }),
        mkStop({ id: 'c', startsAt: day1 + 14_400_000, endsAt: day1 + 18_000_000, category: 'food', estimated_cost: 200 }),
      ],
      [mkLeg({ id: 'l1', from_stop_id: 'a', to_stop_id: 'b', estimated_cost: 340 })],
    )
    const subtotals = rows.filter(r => r.kind === 'categoryTotal')
    const total = rows.find(r => r.kind === 'total')
    expect(subtotals.length).toBeGreaterThan(0)
    expect(subtotals.reduce((s, r) => s + (r.kind === 'categoryTotal' ? r.cost : 0), 0))
      .toBe(total?.kind === 'total' ? total.cost : -1)
  })

  it('小計排在總計之前', () => {
    const rows = buildItineraryRows(
      t, [mkStop({ id: 'a', startsAt: day1, endsAt: day1 + 3_600_000, category: 'food', estimated_cost: 500 })], [],
    )
    expect(rows.findIndex(r => r.kind === 'categoryTotal')).toBeLessThan(rows.findIndex(r => r.kind === 'total'))
  })

  it('全部花費為 null 時不產生任何 categoryTotal 列', () => {
    const rows = buildItineraryRows(t, [mkStop({ id: 'a', startsAt: day1, endsAt: day1 + 3_600_000 })], [])
    expect(rows.filter(r => r.kind === 'categoryTotal')).toEqual([])
  })

  it('legs 自成「交通段」桶，不併進交通站', () => {
    const rows = buildItineraryRows(
      t,
      [
        mkStop({ id: 'a', startsAt: day1, endsAt: day1 + 3_600_000, category: 'transport', estimated_cost: 50 }),
        mkStop({ id: 'b', startsAt: day1 + 7_200_000, endsAt: day1 + 10_800_000, category: 'transport' }),
      ],
      [mkLeg({ id: 'l1', from_stop_id: 'a', to_stop_id: 'b', estimated_cost: 1200 })],
    )
    const labels = rows.filter(r => r.kind === 'categoryTotal').map(r => (r.kind === 'categoryTotal' ? `${r.label}:${r.cost}` : ''))
    expect(labels).toContain('交通站:50')
    expect(labels).toContain('交通段:1200')
  })
})

describe('buildItineraryRows 參與人', () => {
  const H = 3_600_000
  const D = Date.UTC(2026, 7, 1)
  const P = [
    { id: 'p1', user_id: null, name: '甲野', color: '#84cc16' },
    { id: 'p2', user_id: null, name: '乙川', color: '#22c55e' },
  ]

  it('名冊為空時不加參與人欄內容、也不出每人小計（既有行程零變化）', () => {
    const rows = buildItineraryRows(
      trip({ start_date: '2026-08-01', end_date: '2026-08-01' }),
      [mkStop({ id: 'a', startsAt: D + H, endsAt: D + 2 * H, estimated_cost: 900 })],
      [],
    )
    expect(rows.filter(r => r.kind === 'participantTotal')).toHaveLength(0)
    const stopRow = rows.find(r => r.kind === 'stop')!
    expect(stopRow).toMatchObject({ participants: '' })
  })

  it('全員的停留點顯示「全員」，不逐一列名（共同行程是常態，列名只會塞爆表格）', () => {
    const rows = buildItineraryRows(
      trip({ start_date: '2026-08-01', end_date: '2026-08-01', participants: P }),
      [mkStop({ id: 'a', startsAt: D + H, endsAt: D + 2 * H })],
      [],
    )
    expect(rows.find(r => r.kind === 'stop')).toMatchObject({ participants: '全員' })
  })

  it('分頭的停留點列出實際參與者', () => {
    const rows = buildItineraryRows(
      trip({ start_date: '2026-08-01', end_date: '2026-08-01', participants: P }),
      [mkStop({ id: 'a', startsAt: D + H, endsAt: D + 2 * H, participant_ids: ['p1'] })],
      [],
    )
    expect(rows.find(r => r.kind === 'stop')).toMatchObject({ participants: '甲野' })
  })

  it('交通段的參與人取前後停留點的交集', () => {
    const rows = buildItineraryRows(
      trip({ start_date: '2026-08-01', end_date: '2026-08-01', participants: P }),
      [
        mkStop({ id: 'a', startsAt: D + H, endsAt: D + 2 * H }),
        mkStop({ id: 'b', startsAt: D + 4 * H, endsAt: D + 5 * H, participant_ids: ['p2'] }),
      ],
      [mkLeg({ id: 'L', from_stop_id: 'a', to_stop_id: 'b' })],
    )
    expect(rows.find(r => r.kind === 'leg')).toMatchObject({ participants: '乙川' })
  })

  it('每人小計排在總計之後，且 sum(每人) === 總計（整數金額，分帳不變量）', () => {
    const rows = buildItineraryRows(
      trip({ start_date: '2026-08-01', end_date: '2026-08-01', participants: P }),
      [
        mkStop({ id: 'a', startsAt: D + H, endsAt: D + 2 * H, estimated_cost: 1000 }),
        mkStop({ id: 'b', startsAt: D + 4 * H, endsAt: D + 5 * H, estimated_cost: 333, participant_ids: ['p1'] }),
      ],
      [mkLeg({ id: 'L', from_stop_id: 'a', to_stop_id: 'b', estimated_cost: 77 })],
    )
    const totalIdx = rows.findIndex(r => r.kind === 'total')
    const perRows = rows.filter(r => r.kind === 'participantTotal')
    expect(rows.findIndex(r => r.kind === 'participantTotal')).toBeGreaterThan(totalIdx)
    expect(perRows.map(r => r.name)).toEqual(['甲野', '乙川'])
    const total = (rows[totalIdx] as { cost: number }).cost
    expect(perRows.reduce((s, r) => s + r.cost, 0)).toBe(total)
  })

  // 審查 M-4：小數金額下「總計」（原始浮點加總）與「每人應付」（最小單位重算）可能差幾分。
  // 這裡鎖住的是真正成立的那條：每人加總 === totalForSplit，在最小單位上嚴格相等。
  it('小數金額：每人小計加總等於分帳基準（最小單位）', () => {
    const cents = (n: number) => Math.round(n * 100)
    const stops = [
      mkStop({ id: 'a', startsAt: D + H, endsAt: D + 2 * H, estimated_cost: 100.5 }),
      mkStop({ id: 'b', startsAt: D + 4 * H, endsAt: D + 5 * H, estimated_cost: 0.4, participant_ids: ['p1'] }),
    ]
    const legs = [mkLeg({ id: 'L', from_stop_id: 'a', to_stop_id: 'b', estimated_cost: 0.15 })]
    const rows = buildItineraryRows(
      trip({ start_date: '2026-08-01', end_date: '2026-08-01', participants: P }), stops, legs)
    const perRows = rows.filter(r => r.kind === 'participantTotal')
    const splitItems = [
      ...stops.map(s => ({ estimatedCost: s.estimated_cost, participantIds: s.participant_ids })),
      // 交通段 a→b 的交集：a 全員、b 只有 p1 → 交集 [p1]
      { estimatedCost: 0.15, participantIds: ['p1'] },
    ]
    expect(perRows.reduce((s, r) => s + cents(r.cost), 0)).toBe(cents(totalForSplit(splitItems)))
  })

  it('分頭時交通列不接到別人的停留點（匯出版的幻影段）', () => {
    const rows = buildItineraryRows(
      trip({ start_date: '2026-08-01', end_date: '2026-08-01', participants: P }),
      [
        mkStop({ id: 'a', startsAt: D + H, endsAt: D + 2 * H }),
        mkStop({ id: 'b', startsAt: D + 4 * H, endsAt: D + 5 * H, participant_ids: ['p1'] }),
        mkStop({ id: 'c', startsAt: D + 4 * H, endsAt: D + 5 * H, participant_ids: ['p2'] }),
      ],
      // b→c 是幻影段（沒有人從 b 走到 c）；a→b 與 a→c 才是真的
      [
        mkLeg({ id: 'phantom', from_stop_id: 'b', to_stop_id: 'c' }),
        mkLeg({ id: 'ab', from_stop_id: 'a', to_stop_id: 'b' }),
      ],
    )
    // 幻影段不會出現在正常插入位置，只會被歸到「脫離配對」區塊
    const inline = rows.filter(r => r.kind === 'leg' && !r.detached)
    expect(inline).toHaveLength(1)
    expect(rows.filter(r => r.kind === 'leg' && r.detached)).toHaveLength(1)
  })
})
