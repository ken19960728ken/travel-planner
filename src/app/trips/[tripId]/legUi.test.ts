import { describe, it, expect } from 'vitest'
import { isNoRoute, isNoTransitData, legDurationText } from './legUi'
import type { Leg } from './TripView'

const mkLeg = (over: Partial<Leg> = {}): Leg => ({
  id: 'L', from_stop_id: 'A', to_stop_id: 'B', mode: 'transit',
  duration_minutes: null, distance_meters: null, polyline: null, detail: null,
  source: 'auto', stale: false, departs_at: null, arrives_at: null,
  estimated_cost: null, updated_at: '2026-08-01T00:00:00Z',
  ...over,
})

describe('legDurationText', () => {
  it('有 duration_minutes 時顯示「N 分」', () => {
    expect(legDurationText(mkLeg({ duration_minutes: 30 }))).toBe('30 分')
  })
  it('duration 為 null 且 detail 為 null 時顯示「待計算」', () => {
    expect(legDurationText(mkLeg({ duration_minutes: null, detail: null }))).toBe('待計算')
  })
  it('duration 為 null 且 detail.no_route 時顯示「查無路線」', () => {
    expect(legDurationText(mkLeg({ duration_minutes: null, detail: { no_route: true } }))).toBe('查無路線')
  })
  it('duration 為 null 且 detail.no_transit_data 時顯示「無大眾運輸資料」（日本大眾運輸 fallback）', () => {
    expect(legDurationText(mkLeg({ duration_minutes: null, detail: { no_transit_data: true } }))).toBe('無大眾運輸資料')
  })
})

describe('isNoRoute / isNoTransitData', () => {
  it('兩者互斥：no_route 不會被判成 no_transit_data，反之亦然', () => {
    const noRouteLeg = mkLeg({ detail: { no_route: true } })
    expect(isNoRoute(noRouteLeg)).toBe(true)
    expect(isNoTransitData(noRouteLeg)).toBe(false)

    const noTransitLeg = mkLeg({ detail: { no_transit_data: true } })
    expect(isNoRoute(noTransitLeg)).toBe(false)
    expect(isNoTransitData(noTransitLeg)).toBe(true)
  })
})
