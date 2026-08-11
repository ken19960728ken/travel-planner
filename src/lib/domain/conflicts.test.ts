import { describe, it, expect } from 'vitest'
import { detectConflicts, type ConflictStop } from './conflicts'
import type { LegDuration } from './types'

const HOUR = 60 * 60 * 1000

function stop(id: string, startHour: number, endHour: number, participantIds: unknown = null): ConflictStop {
  return { id, startsAt: startHour * HOUR, endsAt: endHour * HOUR, locked: false, participantIds }
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

describe('detectConflicts 分軌', () => {
  it('不同人時間重疊＝分頭行動，不報 overlap', () => {
    const stops = [stop('a', 11, 12, ['p1']), stop('b', 11, 12, ['p2'])]
    expect(detectConflicts(stops, [], ['p1', 'p2'])).toEqual([])
  })

  it('同一個人時間重疊仍是真衝突', () => {
    const stops = [stop('a', 11, 13, ['p1']), stop('b', 12, 14, ['p1'])]
    expect(detectConflicts(stops, [], ['p1', 'p2']))
      .toEqual([{ type: 'overlap', stopIds: ['a', 'b'] }])
  })

  it('全員的停留點與任何人重疊都算衝突（未指派＝全員，他也在場）', () => {
    const stops = [stop('a', 11, 13), stop('b', 12, 14, ['p1'])]
    expect(detectConflicts(stops, [], ['p1', 'p2']))
      .toEqual([{ type: 'overlap', stopIds: ['a', 'b'] }])
  })

  it('同一組衝突被多人各自偵測到時只回報一次', () => {
    const stops = [stop('a', 11, 13), stop('b', 12, 14)]
    expect(detectConflicts(stops, [], ['p1', 'p2', 'p3'])).toHaveLength(1)
  })

  it('趕不上也分軌：不同人之間不判定「趕不上」', () => {
    const stops = [stop('a', 9, 10, ['p1']), stop('b', 10, 11, ['p2'])]
    const legs: LegDuration[] = [{ fromStopId: 'a', toStopId: 'b', durationMinutes: 90 }]
    expect(detectConflicts(stops, legs, ['p1', 'p2'])).toEqual([])
  })

  it('同一個人的相鄰段落仍會判定「趕不上」', () => {
    const stops = [stop('a', 9, 10, ['p1']), stop('b', 10, 11, ['p1'])]
    const legs: LegDuration[] = [{ fromStopId: 'a', toStopId: 'b', durationMinutes: 90 }]
    expect(detectConflicts(stops, legs, ['p1', 'p2'])).toEqual([
      { type: 'transit_too_tight', fromStopId: 'a', toStopId: 'b', gapMinutes: 0, requiredMinutes: 90 },
    ])
  })

  it('名冊為空時逐項等同分軌前的行為', () => {
    const stops = [stop('a', 11, 13), stop('b', 12, 14)]
    expect(detectConflicts(stops, [], [])).toEqual(detectConflicts(stops, []))
  })
})
