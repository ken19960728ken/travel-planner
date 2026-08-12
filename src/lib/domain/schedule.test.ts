import { describe, it, expect } from 'vitest'
import { cascadeShift, pendingShiftOffsetMs, pendingShiftResolved, followingShiftMs, countFollowingStops, type PendingShift, type FollowingStop } from './schedule'
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

describe('followingShiftMs', () => {
  const H = 3_600_000
  const M = 60_000

  it('整段後移半小時 → 後續順延半小時', () => {
    expect(followingShiftMs(12 * H, 12 * H + 30 * M)).toBe(30 * M)
  })

  it('只延長停留（多待一小時）→ 後續順延一小時', () => {
    // 開始時間沒變，取開始時間差會得到 0——那正是這條規則要避免的錯誤
    expect(followingShiftMs(12 * H, 13 * H)).toBe(1 * H)
  })

  it('提早結束 → 後續往前移', () => {
    expect(followingShiftMs(12 * H, 12 * H - 30 * M)).toBe(-30 * M)
  })

  it('提早到但同時離開 → 後續完全不用動（0 代表不必詢問使用者）', () => {
    expect(followingShiftMs(12 * H, 12 * H)).toBe(0)
  })
})

describe('countFollowingStops', () => {
  const H = 3_600_000
  const D0 = Date.UTC(2026, 8, 1)
  const mk = (id: string, from: number, to: number, over: Partial<FollowingStop> = {}): FollowingStop =>
    ({ id, startsAt: D0 + from * H, endsAt: D0 + to * H, locked: false, participants: [], ...over })
  const range = { startMs: D0, endMs: D0 + 48 * H }
  const base = { anchorId: 'B', afterMs: D0 + 11 * H, anchorWho: [] as string[], rosterEmpty: true, deltaMs: H, range }

  it('只算開始時間晚於切點的（切點當下與更早的都不算）', () => {
    const stops = [mk('A', 9, 10), mk('B', 11, 12), mk('tie', 11, 12), mk('D', 15, 16)]
    expect(countFollowingStops(stops, base).total).toBe(1) // 只有 D
  })

  it('排除錨點本身', () => {
    // 錨點被挪到很後面時，它自己的 startsAt 也會 > 切點——沒有顯式排除就會把自己算進去
    const stops = [mk('B', 20, 21), mk('D', 15, 16)]
    expect(countFollowingStops(stops, base).total).toBe(1)
  })

  it('鎖定的不算', () => {
    const stops = [mk('D', 15, 16, { locked: true }), mk('E', 17, 18)]
    expect(countFollowingStops(stops, base).total).toBe(1)
  })

  it('名冊為空時不做參與人過濾', () => {
    const stops = [mk('D', 15, 16, { participants: [] })]
    expect(countFollowingStops(stops, { ...base, rosterEmpty: true }).total).toBe(1)
  })

  it('名冊非空時只算與錨點有共同參與人的', () => {
    const stops = [
      mk('甲的', 15, 16, { participants: ['p1'] }),
      mk('乙的', 17, 18, { participants: ['p2'] }),
      mk('全員', 19, 20, { participants: ['p1', 'p2'] }),
    ]
    const r = countFollowingStops(stops, { ...base, rosterEmpty: false, anchorWho: ['p1'] })
    expect(r.total).toBe(2) // 甲的 + 全員，乙的不算
  })

  it('anchorWho 用傳入值而非查表——同一次儲存改了指派時這是唯一正確的來源', () => {
    const stops = [mk('乙的', 15, 16, { participants: ['p2'] })]
    expect(countFollowingStops(stops, { ...base, rosterEmpty: false, anchorWho: ['p1'] }).total).toBe(0)
    expect(countFollowingStops(stops, { ...base, rosterEmpty: false, anchorWho: ['p2'] }).total).toBe(1)
  })

  it('數出「會被移出行程日期範圍」的筆數（移出後 UI 上沒有任何分頁能顯示它）', () => {
    const stops = [mk('末日晚上', 47, 47.5)]
    const r = countFollowingStops(stops, { ...base, deltaMs: 4 * H })
    expect(r).toEqual({ total: 1, outOfRange: 1 })
  })

  it('往前移也會出界（提前到行程開始日之前）', () => {
    const stops = [mk('首日早上', 1, 2)]
    const r = countFollowingStops(stops, { ...base, afterMs: D0, deltaMs: -4 * H })
    expect(r).toEqual({ total: 1, outOfRange: 1 })
  })

  it('沒有出界時 outOfRange 為 0', () => {
    const stops = [mk('D', 15, 16)]
    expect(countFollowingStops(stops, base)).toEqual({ total: 1, outOfRange: 0 })
  })
})
