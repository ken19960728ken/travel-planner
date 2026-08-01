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
  it('endpoint、金鑰 header 與必填 FieldMask（transit 額外帶 steps.travelMode 供大眾運輸偵測）', () => {
    const r = buildComputeRoutesRequest(Q, 'test-key')
    expect(r.url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes')
    expect(r.headers['X-Goog-Api-Key']).toBe('test-key')
    expect(r.headers['X-Goog-FieldMask']).toBe(
      'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.travelMode',
    )
  })

  it('DRIVE/WALK 的 FieldMask 不擴充（不做步行偵測，維持原樣）', () => {
    const base = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
    expect(buildComputeRoutesRequest({ ...Q, mode: 'driving' }, 'k').headers['X-Goog-FieldMask']).toBe(base)
    expect(buildComputeRoutesRequest({ ...Q, mode: 'walking' }, 'k').headers['X-Goog-FieldMask']).toBe(base)
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
    }, 'driving')).toEqual({ ok: true, durationMinutes: 3, distanceMeters: 820, polyline: 'abc' })
    expect(parseComputeRoutesResponse({ routes: [{ duration: '10s' }] }, 'driving')).toEqual(
      { ok: true, durationMinutes: 1, distanceMeters: null, polyline: null },
    )
  })
  it('空 routes = 查無路線（官方：無法計算路線時 routes 為空，非 404）', () => {
    expect(parseComputeRoutesResponse({ routes: [] }, 'driving')).toEqual({ ok: false, reason: 'no_route' })
    expect(parseComputeRoutesResponse({}, 'driving')).toEqual({ ok: false, reason: 'no_route' })
  })
  it('duration 格式異常回報 bad_response', () => {
    expect(parseComputeRoutesResponse({ routes: [{ duration: 'oops' }] }, 'driving')).toEqual({ ok: false, reason: 'bad_response' })
    expect(parseComputeRoutesResponse(null, 'driving')).toEqual({ ok: false, reason: 'bad_response' })
  })
  it('duration 超過 30 天上限（43200 分鐘）視為查無路線（M-4：穩定結論可快取，避免每次重打 Google）', () => {
    expect(parseComputeRoutesResponse({ routes: [{ duration: '2592060s' }] }, 'driving')).toEqual({ ok: false, reason: 'no_route' })
  })
})

describe('parseComputeRoutesResponse — 日本大眾運輸 fallback（transit steps 三態偵測，I-1/I-2）', () => {
  it('transit 回應含至少一個 TRANSIT step → ok（正常大眾運輸路線，台北實測對照組）', () => {
    const json = {
      routes: [{
        duration: '1800s',
        legs: [{ steps: [{ travelMode: 'WALK' }, { travelMode: 'TRANSIT' }, { travelMode: 'WALK' }] }],
      }],
    }
    expect(parseComputeRoutesResponse(json, 'transit')).toEqual(
      { ok: true, durationMinutes: 30, distanceMeters: null, polyline: null },
    )
  })
  it('transit 回應全是 WALK step（無 TRANSIT）→ no_transit_data 且保留步行時長/距離/polyline（I-2 方案 a，福岡實測）', () => {
    const json = {
      routes: [{
        duration: '2074s', distanceMeters: 2361, polyline: { encodedPolyline: 'walk-only' },
        legs: [{ steps: [{ travelMode: 'WALK' }] }],
      }],
    }
    expect(parseComputeRoutesResponse(json, 'transit')).toEqual(
      { ok: false, reason: 'no_transit_data', durationMinutes: 35, distanceMeters: 2361, polyline: 'walk-only' },
    )
  })
  it('transit 回應多個 leg 中至少一個帶 steps 且無 TRANSIT（部分 leg 缺 steps 陣列）→ 仍視為 walk_only', () => {
    const json = {
      routes: [{
        duration: '600s',
        legs: [{ steps: [{ travelMode: 'WALK' }] }, { /* 無 steps 欄位 */ }],
      }],
    }
    expect(parseComputeRoutesResponse(json, 'transit')).toEqual(
      { ok: false, reason: 'no_transit_data', durationMinutes: 10, distanceMeters: null, polyline: null },
    )
  })
  it('transit 回應缺少 legs 欄位（無資料可判斷）→ bad_response（I-1：不可斷言 no_transit_data，留 pending 自動重試）', () => {
    expect(parseComputeRoutesResponse({ routes: [{ duration: '600s' }] }, 'transit')).toEqual(
      { ok: false, reason: 'bad_response' },
    )
  })
  it('transit 回應 legs 為陣列但所有 leg 都沒有 steps 陣列 → 同樣視為 bad_response（unknown）', () => {
    const json = { routes: [{ duration: '600s', legs: [{}, { steps: 'not-an-array' }] }] }
    expect(parseComputeRoutesResponse(json, 'transit')).toEqual({ ok: false, reason: 'bad_response' })
  })
  it('transit 空 routes 仍維持 no_route（不被 no_transit_data/bad_response 取代既有語意）', () => {
    expect(parseComputeRoutesResponse({ routes: [] }, 'transit')).toEqual({ ok: false, reason: 'no_route' })
  })
  it('walking 模式全是 WALK step 不誤判（步行偵測僅限 transit 請求，WALK 模式本就該是純步行）', () => {
    const json = { routes: [{ duration: '600s', legs: [{ steps: [{ travelMode: 'WALK' }] }] }] }
    expect(parseComputeRoutesResponse(json, 'walking')).toEqual(
      { ok: true, durationMinutes: 10, distanceMeters: null, polyline: null },
    )
  })
  it('driving 模式不受 steps 偵測影響（即使沒有 legs 欄位也照常判 ok，不會落入 bad_response）', () => {
    expect(parseComputeRoutesResponse({ routes: [{ duration: '600s' }] }, 'driving')).toEqual(
      { ok: true, durationMinutes: 10, distanceMeters: null, polyline: null },
    )
  })
})
