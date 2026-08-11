import { describe, it, expect } from 'vitest'
import { buildTripSnapshot, type SnapshotTrip, type SnapshotStop, type SnapshotLeg } from './snapshot'

const trip = (over: Partial<SnapshotTrip> = {}): SnapshotTrip => ({
  title: '九州行', start_date: '2026-08-02', end_date: '2026-08-08', currency: 'JPY', ...over,
})
const mkStop = (over: Partial<SnapshotStop> & { id: string }): SnapshotStop => ({
  name: over.id, lat: 33.59, lng: 130.4, place_id: 'ChIJ-google', is_custom: false,
  timezone: 'Asia/Tokyo', starts_at: '2026-08-02T00:00:00Z', ends_at: '2026-08-02T01:00:00Z',
  locked: false, notes: null, estimated_cost: null, ...over,
})
const mkLeg = (over: Partial<SnapshotLeg> & { from_stop_id: string; to_stop_id: string }): SnapshotLeg => ({
  mode: 'transit', source: 'auto', estimated_cost: null,
  duration_minutes: null, departs_at: null, arrives_at: null, custom_path: null, ...over,
})

describe('buildTripSnapshot', () => {
  it('trip 只凍結四個計畫欄位，頂層帶 snapshot_version: 1', () => {
    const result = buildTripSnapshot(trip(), [], [])
    expect(result.snapshot_version).toBe(1)
    expect(result.trip).toEqual({
      title: '九州行', start_date: '2026-08-02', end_date: '2026-08-08', currency: 'JPY',
    })
    expect(Object.keys(result.trip).sort()).toEqual(['currency', 'end_date', 'start_date', 'title'])
  })

  it('custom 地點的座標是使用者資料，快照收錄 lat/lng', () => {
    const custom = mkStop({ id: 'A', is_custom: true, lat: 12.34, lng: 56.78, place_id: null })
    const result = buildTripSnapshot(trip(), [custom], [])
    expect(result.stops[0]).toMatchObject({ is_custom: true, lat: 12.34, lng: 56.78 })
  })

  it('非 custom 地點的座標屬 30 天快取類別，快照不收錄——逐鍵斷言無 lat/lng 鍵', () => {
    const google = mkStop({ id: 'A', is_custom: false })
    const result = buildTripSnapshot(trip(), [google], [])
    expect(Object.keys(result.stops[0]).sort()).toEqual([
      'ends_at', 'estimated_cost', 'id', 'is_custom', 'locked', 'name', 'notes', 'place_id', 'starts_at', 'timezone',
    ])
  })

  it('auto 段只存 5 個欄位（時長由前後停留點時間隱含，不落地）——逐鍵斷言', () => {
    const leg = mkLeg({ from_stop_id: 'A', to_stop_id: 'B', source: 'auto', mode: 'walking', estimated_cost: 100 })
    const result = buildTripSnapshot(trip(), [], [leg])
    expect(Object.keys(result.legs[0]).sort()).toEqual(['estimated_cost', 'from_stop_id', 'mode', 'source', 'to_stop_id'])
    expect(result.legs[0]).toMatchObject({ from_stop_id: 'A', to_stop_id: 'B', mode: 'walking', source: 'auto', estimated_cost: 100 })
  })

  it('manual 段全存使用者欄位（+ duration_minutes/departs_at/arrives_at）——逐鍵斷言 8 鍵', () => {
    const leg = mkLeg({
      from_stop_id: 'A', to_stop_id: 'B', source: 'manual', mode: 'flight',
      duration_minutes: 90, departs_at: '2026-08-03T01:00:00Z', arrives_at: '2026-08-03T02:30:00Z',
      estimated_cost: 5000,
    })
    const result = buildTripSnapshot(trip(), [], [leg])
    expect(Object.keys(result.legs[0]).sort()).toEqual([
      'arrives_at', 'departs_at', 'duration_minutes', 'estimated_cost', 'from_stop_id', 'mode', 'source', 'to_stop_id',
    ])
    expect(result.legs[0]).toMatchObject({ duration_minutes: 90, departs_at: '2026-08-03T01:00:00Z', arrives_at: '2026-08-03T02:30:00Z' })
  })

  it('一律不含 Google 衍生欄位（polyline/detail/distance_meters/computed_at）——輸入型別本就不帶，混合案例整包確認', () => {
    const stops = [mkStop({ id: 'A' }), mkStop({ id: 'B', is_custom: true })]
    const legs = [
      mkLeg({ from_stop_id: 'A', to_stop_id: 'B', source: 'auto' }),
      mkLeg({ from_stop_id: 'B', to_stop_id: 'A', source: 'manual', duration_minutes: 20 }),
    ]
    const result = buildTripSnapshot(trip(), stops, legs)
    expect(result.stops).toHaveLength(2)
    expect(result.legs).toHaveLength(2)
    for (const leg of result.legs) {
      expect(leg).not.toHaveProperty('polyline')
      expect(leg).not.toHaveProperty('detail')
      expect(leg).not.toHaveProperty('distance_meters')
      expect(leg).not.toHaveProperty('computed_at')
    }
  })

  // custom_path 是 Google 衍生欄位排除規則的**刻意例外**：使用者自己畫的路線不受 30 天 TTL 限制，
  // 永久保存正是目的——為日本電車段畫的路線不該在快照裡消失（2026-08-10 手繪路徑）
  it('收錄使用者手繪路徑，且與 auto/manual 無關', () => {
    const legs = [
      mkLeg({ from_stop_id: 'A', to_stop_id: 'B', source: 'auto', custom_path: [[25, 121], [26, 122]] }),
    ]
    const result = buildTripSnapshot(trip(), [mkStop({ id: 'A' }), mkStop({ id: 'B' })], legs)
    expect(result.legs[0].custom_path).toEqual([[25, 121], [26, 122]])
  })

  it('沒畫過的段落不帶 custom_path 鍵', () => {
    const legs = [mkLeg({ from_stop_id: 'A', to_stop_id: 'B' })]
    const result = buildTripSnapshot(trip(), [mkStop({ id: 'A' }), mkStop({ id: 'B' })], legs)
    expect(result.legs[0]).not.toHaveProperty('custom_path')
  })

  it('畸形的手繪路徑被清洗，不進入永久保存的凍結副本', () => {
    const legs = [
      mkLeg({
        from_stop_id: 'A', to_stop_id: 'B',
        custom_path: [[25, 121], ['x', 'y'], [999, 999], null, [26, 122]],
      }),
    ]
    const result = buildTripSnapshot(trip(), [mkStop({ id: 'A' }), mkStop({ id: 'B' })], legs)
    expect(result.legs[0].custom_path).toEqual([[25, 121], [26, 122]])
  })

  it('手繪路徑全部畸形時，等同沒畫過（不帶鍵）', () => {
    const legs = [mkLeg({ from_stop_id: 'A', to_stop_id: 'B', custom_path: 'not-an-array' })]
    const result = buildTripSnapshot(trip(), [mkStop({ id: 'A' }), mkStop({ id: 'B' })], legs)
    expect(result.legs[0]).not.toHaveProperty('custom_path')
  })
})
