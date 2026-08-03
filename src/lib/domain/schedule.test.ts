import { describe, it, expect } from 'vitest'
import { cascadeShift, pendingShiftOffsetMs, pendingShiftResolved, type PendingShift } from './schedule'
import type { StopSchedule } from './types'

const HOUR = 60 * 60 * 1000

function stop(id: string, startHour: number, endHour: number, locked = false): StopSchedule {
  return { id, startsAt: startHour * HOUR, endsAt: endHour * HOUR, locked }
}

describe('cascadeShift', () => {
  it('把被改動停留點之後的所有停留點順延 delta', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12), stop('c', 13, 14)]
    const result = cascadeShift(stops, 'a', HOUR)
    expect(result.find(s => s.id === 'b')!.startsAt).toBe(12 * HOUR)
    expect(result.find(s => s.id === 'c')!.startsAt).toBe(14 * HOUR)
  })

  it('被改動的停留點本身與更早的停留點不動', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12), stop('c', 13, 14)]
    const result = cascadeShift(stops, 'b', HOUR)
    expect(result.find(s => s.id === 'a')!.startsAt).toBe(9 * HOUR)
    expect(result.find(s => s.id === 'b')!.startsAt).toBe(11 * HOUR)
    expect(result.find(s => s.id === 'c')!.startsAt).toBe(14 * HOUR)
  })

  it('鎖定的停留點不順延', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12, true), stop('c', 13, 14)]
    const result = cascadeShift(stops, 'a', HOUR)
    expect(result.find(s => s.id === 'b')!.startsAt).toBe(11 * HOUR)
    expect(result.find(s => s.id === 'c')!.startsAt).toBe(14 * HOUR)
  })

  it('delta 為 0 或找不到 id 時回傳排序後的原內容', () => {
    const stops = [stop('b', 11, 12), stop('a', 9, 10)]
    expect(cascadeShift(stops, 'a', 0).map(s => s.id)).toEqual(['a', 'b'])
    expect(cascadeShift(stops, 'missing', HOUR).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('deltaMs 為負時後續停留點整體提前', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12)]
    const result = cascadeShift(stops, 'a', -HOUR)
    expect(result.find(s => s.id === 'b')!.startsAt).toBe(10 * HOUR)
  })

  it('不改動輸入陣列（不可變）', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12)]
    cascadeShift(stops, 'a', HOUR)
    expect(stops[1].startsAt).toBe(11 * HOUR)
  })
})

describe('pendingShiftOffsetMs', () => {
  const pending: PendingShift = { changedStopId: 'a', deltaMs: HOUR, baselineStartMs: 9 * HOUR }

  it('pending 為 null 時一律不偏移', () => {
    expect(pendingShiftOffsetMs(stop('a', 9, 10), null)).toBe(0)
  })

  it('被拖點本身套用偏移', () => {
    expect(pendingShiftOffsetMs(stop('a', 9, 10), pending)).toBe(HOUR)
  })

  it('未鎖定且 baseline 上晚於被拖點的停留點套用偏移', () => {
    expect(pendingShiftOffsetMs(stop('c', 13, 14), pending)).toBe(HOUR)
  })

  it('baseline 上早於或等於被拖點的其他停留點不偏移', () => {
    expect(pendingShiftOffsetMs(stop('z', 8, 9), pending)).toBe(0)
  })

  it('鎖定的停留點即使晚於被拖點也不偏移', () => {
    expect(pendingShiftOffsetMs(stop('c', 13, 14, true), pending)).toBe(0)
  })
})

describe('pendingShiftResolved', () => {
  const pending: PendingShift = { changedStopId: 'a', deltaMs: HOUR, baselineStartMs: 9 * HOUR }

  it('被拖點的 starts_at 尚未追上 baseline+delta 時不清除', () => {
    expect(pendingShiftResolved(pending, [{ id: 'a', startsAt: 9 * HOUR }])).toBe(false)
  })

  it('被拖點的 starts_at 已等於 baseline+delta 時清除（正常落地）', () => {
    expect(pendingShiftResolved(pending, [{ id: 'a', startsAt: 10 * HOUR }])).toBe(true)
  })

  it('找不到被拖點（協作者已刪除）時也要清除——不可能再落地', () => {
    // 舊版把這個情境當成「尚未落地」而回 false，會讓偏移預覽永久卡住（2026-08-04 審查 Major）
    expect(pendingShiftResolved(pending, [{ id: 'other', startsAt: 10 * HOUR }])).toBe(true)
    expect(pendingShiftResolved(pending, [])).toBe(true)
  })
})
