import { describe, expect, it } from 'vitest'
import { decodePolyline, greatCirclePoints, pathPosition, pathSlice } from './polyline'

describe('decodePolyline', () => {
  // Google 官方文件 Encoded Polyline Algorithm Format 的標準範例
  it('解碼官方範例', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
    expect(pts).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ])
  })
  it('空字串回空陣列', () => {
    expect(decodePolyline('')).toEqual([])
  })
})

describe('greatCirclePoints', () => {
  it('端點精確等於輸入、點數為 steps+1', () => {
    const from = { lat: 25.08, lng: 121.23 }
    const to = { lat: 33.585, lng: 130.45 }
    const pts = greatCirclePoints(from, to, 64)
    expect(pts).toHaveLength(65)
    expect(pts[0].lat).toBeCloseTo(from.lat, 9)
    expect(pts[64].lng).toBeCloseTo(to.lng, 9)
  })
  it('兩點重合時回兩個相同點（不除以零）', () => {
    const p = { lat: 33, lng: 130 }
    const pts = greatCirclePoints(p, p, 64)
    expect(pts[0]).toEqual(p)
    expect(pts[pts.length - 1]).toEqual(p)
    expect(pts.every(q => Number.isFinite(q.lat) && Number.isFinite(q.lng))).toBe(true)
  })
  it('中點在兩端點緯度之外側（大圓北彎，非直線內插）', () => {
    const pts = greatCirclePoints({ lat: 35.68, lng: 139.77 }, { lat: 37.77, lng: -122.42 }, 64)
    expect(pts[32].lat).toBeGreaterThan(45)
  })
})

describe('pathPosition', () => {
  const path = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 1, lng: 1 },
  ]
  it('fraction 0 / 1 取端點', () => {
    expect(pathPosition(path, 0)).toMatchObject({ lat: 0, lng: 0 })
    expect(pathPosition(path, 1)).toMatchObject({ lat: 1, lng: 1 })
  })
  it('fraction 0.25 落在第一段中間、heading 朝東（≈90）', () => {
    const p = pathPosition(path, 0.25)!
    expect(p.lat).toBeCloseTo(0, 5)
    expect(p.lng).toBeCloseTo(0.5, 2)
    expect(p.headingDeg).toBeCloseTo(90, 0)
  })
  it('fraction 0.75 落在第二段、heading 朝北（≈0）', () => {
    const p = pathPosition(path, 0.75)!
    expect(p.lng).toBeCloseTo(1, 5)
    expect(p.headingDeg).toBeCloseTo(0, 0)
  })
  it('界外 fraction 夾回 [0,1]；空/單點路徑', () => {
    expect(pathPosition(path, -1)).toMatchObject({ lat: 0, lng: 0 })
    expect(pathPosition(path, 2)).toMatchObject({ lat: 1, lng: 1 })
    expect(pathPosition([], 0.5)).toBeNull()
    expect(pathPosition([{ lat: 5, lng: 5 }], 0.5)).toMatchObject({ lat: 5, lng: 5, headingDeg: 0 })
  })
})

describe('pathSlice', () => {
  const path = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 1, lng: 1 },
  ]
  it('fraction 0.25：末尾是內插目前點', () => {
    const s = pathSlice(path, 0.25)
    expect(s[0]).toEqual({ lat: 0, lng: 0 })
    expect(s[s.length - 1].lng).toBeCloseTo(0.5, 2)
  })
  it('fraction 1 等於整條；fraction 0 只有起點', () => {
    expect(pathSlice(path, 1)).toEqual(path)
    expect(pathSlice(path, 0)).toEqual([{ lat: 0, lng: 0 }])
  })
})
