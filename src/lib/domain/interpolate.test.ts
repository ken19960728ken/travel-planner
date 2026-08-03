import { describe, it, expect } from 'vitest'
import { interpolatePosition, segmentAt } from './interpolate'

const HOUR = 60 * 60 * 1000
const stop = (id: string, s: number, e: number, lat: number, lng: number) => ({
  id, startsAt: s * HOUR, endsAt: e * HOUR, lat, lng,
})

describe('interpolatePosition', () => {
  const stops = [stop('a', 9, 10, 35.0, 139.0), stop('b', 12, 13, 36.0, 140.0)]

  it('停留期間回傳該停留點座標', () => {
    expect(interpolatePosition(stops, 9.5 * HOUR)).toEqual({ lat: 35.0, lng: 139.0 })
  })

  it('兩停留點之間線性內插', () => {
    // 10:00–12:00 的中點 11:00 → 座標中點
    expect(interpolatePosition(stops, 11 * HOUR)).toEqual({ lat: 35.5, lng: 139.5 })
  })

  it('第一個停留點之前回傳第一點；最後之後回傳最後點', () => {
    expect(interpolatePosition(stops, 8 * HOUR)).toEqual({ lat: 35.0, lng: 139.0 })
    expect(interpolatePosition(stops, 14 * HOUR)).toEqual({ lat: 36.0, lng: 140.0 })
  })

  it('空陣列回傳 null', () => {
    expect(interpolatePosition([], 0)).toBeNull()
  })

  it('重疊停留點：B 已結束但 A 仍在進行中 → 回 A（非陣列最後一筆／非結束最晚者）', () => {
    // A 9–20 涵蓋 B 10–11；t=15 時 B 已結束，只有 A 仍在進行中 → 應回 A
    const overlapping = [stop('a', 9, 20, 10.0, 10.0), stop('b', 10, 11, 99.0, 99.0)]
    expect(interpolatePosition(overlapping, 15 * HOUR)).toEqual({ lat: 10.0, lng: 10.0 })
  })

  it('重疊停留點：兩者同時涵蓋 t → 取開始最早者（真正命中 tie-break）', () => {
    // A 9–20 涵蓋 B 10–11；t=10.5 時 A、B 都在進行中 → 應回開始最早的 A，而非 B
    const overlapping = [stop('a', 9, 20, 10.0, 10.0), stop('b', 10, 11, 99.0, 99.0)]
    expect(interpolatePosition(overlapping, 10.5 * HOUR)).toEqual({ lat: 10.0, lng: 10.0 })
  })

  it('未排序輸入仍正確內插（不依賴呼叫端先排序）', () => {
    const reversed = [...stops].reverse()
    expect(interpolatePosition(reversed, 11 * HOUR)).toEqual({ lat: 35.5, lng: 139.5 })
  })

  it('背靠背停留點（前者結束＝後者開始）交界時刻回傳前一點', () => {
    const backToBack = [stop('a', 9, 10, 1.0, 1.0), stop('b', 10, 11, 2.0, 2.0)]
    expect(interpolatePosition(backToBack, 10 * HOUR)).toEqual({ lat: 1.0, lng: 1.0 })
  })
})

describe('segmentAt', () => {
  const stops = [
    { id: 'a', startsAt: 1000, endsAt: 2000, lat: 0, lng: 0 },
    { id: 'b', startsAt: 3000, endsAt: 4000, lat: 1, lng: 1 },
  ]
  it('停留中回 stay', () => {
    expect(segmentAt(stops, 1500)).toEqual({ kind: 'stay', stopId: 'a' })
  })
  it('空檔回 travel + progress', () => {
    expect(segmentAt(stops, 2500)).toEqual({ kind: 'travel', fromStopId: 'a', toStopId: 'b', progress: 0.5 })
  })
  it('界外回端點 stay', () => {
    expect(segmentAt(stops, 500)).toEqual({ kind: 'stay', stopId: 'a' })
    expect(segmentAt(stops, 9999)).toEqual({ kind: 'stay', stopId: 'b' })
  })
  it('空陣列回 null；重疊取開始最早者（與 interpolatePosition 同語義）', () => {
    expect(segmentAt([], 1500)).toBeNull()
    const overlap = [
      { id: 'x', startsAt: 1000, endsAt: 3000, lat: 0, lng: 0 },
      { id: 'y', startsAt: 1200, endsAt: 2000, lat: 5, lng: 5 },
    ]
    expect(segmentAt(overlap, 1500)).toEqual({ kind: 'stay', stopId: 'x' })
  })
})
