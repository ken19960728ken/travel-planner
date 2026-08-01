import { describe, it, expect } from 'vitest'
import { nextDefaultSlot, defaultSlotForDay } from './slot'
import type { StopSchedule } from './types'
import { wallInputToUtcMs } from './tz'

const HOUR = 60 * 60 * 1000
const HALF_HOUR = 30 * 60 * 1000

function stop(id: string, startMs: number, endMs: number): StopSchedule {
  return { id, startsAt: startMs, endsAt: endMs, locked: false }
}

type DaySlotStop = { starts_at: string; ends_at: string; locked: boolean; timezone: string }

function daySlotStop(startsAt: string, endsAt: string, timezone: string): DaySlotStop {
  return { starts_at: startsAt, ends_at: endsAt, locked: false, timezone }
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

describe('defaultSlotForDay', () => {
  it('空行程空日 → 當地 09:00 起、1 小時', () => {
    const targetDay = '2026-08-01'
    const expectedStart = wallInputToUtcMs(`${targetDay}T09:00`, 'Asia/Taipei')
    expect(defaultSlotForDay([], targetDay, null, 'Asia/Taipei')).toEqual({
      startsAt: expectedStart,
      endsAt: expectedStart + HOUR,
    })
  })

  it('當日已有停留點 → 接最晚結束 +30 分', () => {
    const targetDay = '2026-08-05'
    const stops = [
      daySlotStop('2026-08-05T01:00:00.000Z', '2026-08-05T03:00:00.000Z', 'Asia/Taipei'),
      daySlotStop('2026-08-05T05:00:00.000Z', '2026-08-05T07:00:00.000Z', 'Asia/Taipei'),
    ]
    const lastEnd = new Date('2026-08-05T07:00:00.000Z').getTime()
    expect(defaultSlotForDay(stops, targetDay, null, 'Asia/Taipei')).toEqual({
      startsAt: lastEnd + HALF_HOUR,
      endsAt: lastEnd + HALF_HOUR + HOUR,
    })
  })

  it('pending.day !== targetDay 時墊底被忽略（R-4 回歸鎖）', () => {
    const targetDay = '2026-08-05'
    const pending = { day: '2026-08-04', endsAt: new Date('2026-08-04T23:00:00.000Z').getTime() }
    const expectedStart = wallInputToUtcMs(`${targetDay}T09:00`, 'Asia/Taipei')
    expect(defaultSlotForDay([], targetDay, pending, 'Asia/Taipei')).toEqual({
      startsAt: expectedStart,
      endsAt: expectedStart + HOUR,
    })
  })

  it('pending.endsAt 為 0 時視同無墊底（守衛內化，避免算出 1970 年時段）', () => {
    const targetDay = '2026-08-05'
    const expectedStart = wallInputToUtcMs(`${targetDay}T09:00`, 'Asia/Taipei')
    expect(defaultSlotForDay([], targetDay, { day: targetDay, endsAt: 0 }, 'Asia/Taipei')).toEqual({
      startsAt: expectedStart,
      endsAt: expectedStart + HOUR,
    })
  })

  it('pending.day === targetDay 且晚於當日所有停留點 → 以 pending 為基準', () => {
    const targetDay = '2026-08-05'
    const stops = [daySlotStop('2026-08-05T01:00:00.000Z', '2026-08-05T03:00:00.000Z', 'Asia/Taipei')]
    const pendingEnd = new Date('2026-08-05T10:00:00.000Z').getTime()
    const pending = { day: targetDay, endsAt: pendingEnd }
    expect(defaultSlotForDay(stops, targetDay, pending, 'Asia/Taipei')).toEqual({
      startsAt: pendingEnd + HALF_HOUR,
      endsAt: pendingEnd + HALF_HOUR + HOUR,
    })
  })

  it('目標日無停留點但其他日有 → refTz 取全行程最後一筆的時區', () => {
    const targetDay = '2026-08-05'
    const stops = [daySlotStop('2026-08-03T10:00:00.000Z', '2026-08-03T11:00:00.000Z', 'Asia/Tokyo')]
    const expectedStart = wallInputToUtcMs(`${targetDay}T09:00`, 'Asia/Tokyo')
    expect(defaultSlotForDay(stops, targetDay, null, 'Asia/Taipei')).toEqual({
      startsAt: expectedStart,
      endsAt: expectedStart + HOUR,
    })
  })

  it('全行程皆空 → 用 browserTimezone', () => {
    const targetDay = '2026-08-05'
    const expectedStart = wallInputToUtcMs(`${targetDay}T09:00`, 'America/New_York')
    expect(defaultSlotForDay([], targetDay, null, 'America/New_York')).toEqual({
      startsAt: expectedStart,
      endsAt: expectedStart + HOUR,
    })
  })
})
