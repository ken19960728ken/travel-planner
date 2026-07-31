import { describe, it, expect } from 'vitest'
import { detectConflicts } from './conflicts'
import type { StopSchedule, LegDuration } from './types'

const HOUR = 60 * 60 * 1000

function stop(id: string, startHour: number, endHour: number): StopSchedule {
  return { id, startsAt: startHour * HOUR, endsAt: endHour * HOUR, locked: false }
}

describe('detectConflicts', () => {
  it('偵測時間重疊', () => {
    const stops = [stop('a', 9, 11), stop('b', 10, 12)]
    const warnings = detectConflicts(stops, [])
    expect(warnings).toEqual([{ type: 'overlap', stopIds: ['a', 'b'] }])
  })

  it('偵測空檔小於交通時間（趕不上）', () => {
    const stops = [stop('a', 9, 10), stop('b', 10.5, 12)] // 空檔 30 分
    const legs: LegDuration[] = [{ fromStopId: 'a', toStopId: 'b', durationMinutes: 45 }]
    const warnings = detectConflicts(stops, legs)
    expect(warnings).toEqual([
      {
        type: 'transit_too_tight',
        fromStopId: 'a',
        toStopId: 'b',
        gapMinutes: 30,
        requiredMinutes: 45,
      },
    ])
  })

  it('空檔足夠且無重疊時回傳空陣列', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12)]
    const legs: LegDuration[] = [{ fromStopId: 'a', toStopId: 'b', durationMinutes: 45 }]
    expect(detectConflicts(stops, legs)).toEqual([])
  })

  it('沒有對應交通段的相鄰停留點只檢查重疊', () => {
    const stops = [stop('a', 9, 10), stop('b', 10.25, 12)]
    expect(detectConflicts(stops, [])).toEqual([])
  })

  it('偵測 3+ 停留點的連環/巢狀重疊', () => {
    const stops = [stop('a', 9, 11), stop('b', 9.5, 9.6), stop('c', 9.7, 13)]
    const warnings = detectConflicts(stops, [])
    expect(warnings).toEqual([
      { type: 'overlap', stopIds: ['a', 'b'] },
      { type: 'overlap', stopIds: ['a', 'c'] },
    ])
  })

  it('重疊時不重複回報 transit_too_tight（避免雙重警示）', () => {
    const stops = [stop('a', 9, 11), stop('b', 10, 12)]
    const legs: LegDuration[] = [{ fromStopId: 'a', toStopId: 'b', durationMinutes: 45 }]
    expect(detectConflicts(stops, legs)).toEqual([{ type: 'overlap', stopIds: ['a', 'b'] }])
  })
})
