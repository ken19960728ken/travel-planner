import { describe, it, expect } from 'vitest'
import {
  buildComputeRoutesRequest, parseComputeRoutesResponse, clampTransitDeparture,
} from './routes'

const NOW = Date.UTC(2026, 7, 1, 0)
const DAY = 24 * 60 * 60 * 1000
const Q = {
  fromLat: 33.5902, fromLng: 130.4017, toLat: 33.5859, toLng: 130.4201,
  mode: 'transit' as const, departureMs: NOW + DAY,
}

describe('buildComputeRoutesRequest（官方 v2 格式，2026-07-31 查證）', () => {
  it('endpoint、金鑰 header 與必填 FieldMask', () => {
    const r = buildComputeRoutesRequest(Q, 'test-key')
    expect(r.url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes')
    expect(r.headers['X-Goog-Api-Key']).toBe('test-key')
    expect(r.headers['X-Goog-FieldMask']).toBe('routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline')
  })

  it('TRANSIT：latLng 結構 + RFC3339 departureTime；不帶 routingPreference', () => {
    const r = buildComputeRoutesRequest(Q, 'k')
    expect(r.body.origin).toEqual({ location: { latLng: { latitude: Q.fromLat, longitude: Q.fromLng } } })
    expect(r.body.travelMode).toBe('TRANSIT')
    expect(r.body.departureTime).toBe(new Date(Q.departureMs).toISOString())
    expect('routingPreference' in r.body).toBe(false)
  })

  it('DRIVE/WALK：不帶 departureTime（官方：非 TRANSIT 不允許過去時間，且結果與出發時間無關）', () => {
    expect('departureTime' in buildComputeRoutesRequest({ ...Q, mode: 'driving' }, 'k').body).toBe(false)
    expect(buildComputeRoutesRequest({ ...Q, mode: 'walking' }, 'k').body.travelMode).toBe('WALK')
    expect(buildComputeRoutesRequest({ ...Q, mode: 'driving' }, 'k').body.travelMode).toBe('DRIVE')
  })
})

describe('clampTransitDeparture（TRANSIT 允許區間：過去 7 天 ~ 未來 100 天）', () => {
  it('區間內原樣回傳', () => {
    expect(clampTransitDeparture(NOW + DAY, NOW)).toBe(NOW + DAY)
  })
  it('過去超過 7 天夾到下限、未來超過 100 天夾到上限（各留 1 天餘裕）', () => {
    expect(clampTransitDeparture(NOW - 30 * DAY, NOW)).toBe(NOW - 6 * DAY)
    expect(clampTransitDeparture(NOW + 365 * DAY, NOW)).toBe(NOW + 99 * DAY)
  })
})

describe('parseComputeRoutesResponse', () => {
  it('正常回應："165s" 字串轉分鐘（四捨五入、至少 1 分）', () => {
    expect(parseComputeRoutesResponse({
      routes: [{ duration: '165s', distanceMeters: 820, polyline: { encodedPolyline: 'abc' } }],
    })).toEqual({ ok: true, durationMinutes: 3, distanceMeters: 820, polyline: 'abc' })
    expect(parseComputeRoutesResponse({ routes: [{ duration: '10s' }] })).toEqual(
      { ok: true, durationMinutes: 1, distanceMeters: null, polyline: null },
    )
  })
  it('空 routes = 查無路線（官方：無法計算路線時 routes 為空，非 404）', () => {
    expect(parseComputeRoutesResponse({ routes: [] })).toEqual({ ok: false, reason: 'no_route' })
    expect(parseComputeRoutesResponse({})).toEqual({ ok: false, reason: 'no_route' })
  })
  it('duration 格式異常回報 bad_response', () => {
    expect(parseComputeRoutesResponse({ routes: [{ duration: 'oops' }] })).toEqual({ ok: false, reason: 'bad_response' })
    expect(parseComputeRoutesResponse(null)).toEqual({ ok: false, reason: 'bad_response' })
  })
  it('duration 超過 30 天上限（43200 分鐘）回報 bad_response（R-2：防禦異常大數值污染 30 天快取）', () => {
    expect(parseComputeRoutesResponse({ routes: [{ duration: '2592060s' }] })).toEqual({ ok: false, reason: 'bad_response' })
  })
})
