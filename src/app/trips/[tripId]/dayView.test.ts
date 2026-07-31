import { describe, it, expect } from 'vitest'
import { buildDayView } from './dayView'
import type { Stop, Leg } from './TripView'

const HOUR = 60 * 60 * 1000

function stop(id: string, startsAtMs: number, endsAtMs: number, overrides: Partial<Stop> = {}): Stop {
  return {
    id,
    name: id,
    lat: 0,
    lng: 0,
    place_id: null,
    is_custom: false,
    timezone: 'UTC',
    starts_at: new Date(startsAtMs).toISOString(),
    ends_at: new Date(endsAtMs).toISOString(),
    locked: false,
    notes: null,
    estimated_cost: null,
    ...overrides,
  }
}

function leg(id: string, fromStopId: string, toStopId: string, durationMinutes: number | null): Leg {
  return {
    id,
    from_stop_id: fromStopId,
    to_stop_id: toStopId,
    mode: 'transit',
    duration_minutes: durationMinutes,
    distance_meters: null,
    polyline: null,
    detail: null,
    source: 'auto',
    stale: false,
    departs_at: null,
    arrives_at: null,
    estimated_cost: null,
    updated_at: new Date(0).toISOString(),
  }
}

describe('buildDayView', () => {
  it('組出當日 dayLegs，且趕不上時 warnings/conflictIds/tightPairs 一致命中', () => {
    // a 09:00-10:00，b 10:30-12:00：空檔 30 分 < 交通 45 分 → 趕不上
    const a = stop('a', 9 * HOUR, 10 * HOUR)
    const b = stop('b', 10.5 * HOUR, 12 * HOUR)
    const legAB = leg('leg-ab', 'a', 'b', 45)
    const stops = [a, b]
    const legs = [legAB]

    const view = buildDayView([a, b], stops, legs)

    expect(view.dayLegs).toEqual([{ from: a, to: b, leg: legAB }])
    expect(view.warnings).toEqual([
      { type: 'transit_too_tight', fromStopId: 'a', toStopId: 'b', gapMinutes: 30, requiredMinutes: 45 },
    ])
    expect(view.conflictIds).toEqual(new Set(['a', 'b']))
    expect(view.tightPairs).toEqual(new Set(['a→b']))
  })

  it('空檔充足時沒有任何警示', () => {
    const a = stop('a', 9 * HOUR, 10 * HOUR)
    const b = stop('b', 11 * HOUR, 12 * HOUR)
    const legAB = leg('leg-ab', 'a', 'b', 45)

    const view = buildDayView([a, b], [a, b], [legAB])

    expect(view.warnings).toEqual([])
    expect(view.conflictIds.size).toBe(0)
    expect(view.tightPairs.size).toBe(0)
    expect(view.dayLegs).toEqual([{ from: a, to: b, leg: legAB }])
  })

  it('時間重疊時 conflictIds 命中重疊的兩點，且不產生 tightPairs', () => {
    const a = stop('a', 9 * HOUR, 11 * HOUR)
    const b = stop('b', 10 * HOUR, 12 * HOUR)

    const view = buildDayView([a, b], [a, b], [])

    expect(view.warnings).toEqual([{ type: 'overlap', stopIds: ['a', 'b'] }])
    expect(view.conflictIds).toEqual(new Set(['a', 'b']))
    expect(view.tightPairs.size).toBe(0)
  })

  it('duration_minutes 為 null 的 leg 不參與趕不上偵測，但仍出現在 dayLegs（Timeline 連接條需要顯示）', () => {
    const a = stop('a', 9 * HOUR, 10 * HOUR)
    const b = stop('b', 10.1 * HOUR, 12 * HOUR) // 空檔 6 分，若 leg 有時長會判定趕不上
    const legAB = leg('leg-ab', 'a', 'b', null)

    const view = buildDayView([a, b], [a, b], [legAB])

    expect(view.dayLegs).toEqual([{ from: a, to: b, leg: legAB }])
    expect(view.warnings).toEqual([])
    expect(view.tightPairs.size).toBe(0)
  })

  it('跨夜段（次日停留點）仍算入出發日的 dayLegs（M-4：顯示於出發日末尾）', () => {
    const a = stop('a', 9 * HOUR, 10 * HOUR)
    const bNextDay = stop('b', 34 * HOUR, 36 * HOUR) // 隔天
    const legAB = leg('leg-ab', 'a', 'b', 20)

    // dayStops 只有 a（b 屬於隔天，不在當日 dayStops 內）；stops/legs 是全行程
    const view = buildDayView([a], [a, bNextDay], [legAB])

    expect(view.dayLegs).toEqual([{ from: a, to: bNextDay, leg: legAB }])
  })
})
