import { describe, it, expect } from 'vitest'
import { nextDefaultSlot } from './slot'
import type { StopSchedule } from './types'

const HOUR = 60 * 60 * 1000
const HALF_HOUR = 30 * 60 * 1000

function stop(id: string, startMs: number, endMs: number): StopSchedule {
  return { id, startsAt: startMs, endsAt: endMs, locked: false }
}

describe('nextDefaultSlot', () => {
  it('沒有停留點時從 fallback 開始，停留一小時', () => {
    const t0 = 1_000_000
    expect(nextDefaultSlot([], t0)).toEqual({ startsAt: t0, endsAt: t0 + HOUR })
  })

  it('已有停留點時接在最晚結束時間後 30 分鐘', () => {
    const stops = [stop('a', 0, 2 * HOUR), stop('b', 3 * HOUR, 4 * HOUR)]
    expect(nextDefaultSlot(stops, 0)).toEqual({
      startsAt: 4 * HOUR + HALF_HOUR,
      endsAt: 4 * HOUR + HALF_HOUR + HOUR,
    })
  })

  it('不受輸入順序影響（取全域最晚 endsAt）', () => {
    const stops = [stop('b', 3 * HOUR, 6 * HOUR), stop('a', 0, 2 * HOUR)]
    expect(nextDefaultSlot(stops, 0).startsAt).toBe(6 * HOUR + HALF_HOUR)
  })
})
