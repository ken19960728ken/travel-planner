import { describe, it, expect } from 'vitest'
import { buildRouteCacheKey } from './cacheKey'

const BASE = {
  fromLat: 35.71478,
  fromLng: 139.79665,
  toLat: 35.71006,
  toLng: 139.8107,
  mode: 'transit' as const,
  departureMs: Date.UTC(2026, 9, 1, 9, 10), // 09:10 → 落在 09:00 的 30 分桶
}

describe('buildRouteCacheKey', () => {
  it('鍵含版本前綴（C-1：no_transit_data 語意變更後舊快取需全面 miss，見 migration 20260803000002）', () => {
    expect(buildRouteCacheKey(BASE).startsWith('v2|')).toBe(true)
  })

  it('同一 30 分鐘桶內的不同出發時間產生相同的鍵', () => {
    const a = buildRouteCacheKey({ ...BASE, departureMs: Date.UTC(2026, 9, 1, 9, 1) })
    const b = buildRouteCacheKey({ ...BASE, departureMs: Date.UTC(2026, 9, 1, 9, 29) })
    expect(a).toBe(b)
  })

  it('跨桶的出發時間產生不同的鍵', () => {
    const a = buildRouteCacheKey({ ...BASE, departureMs: Date.UTC(2026, 9, 1, 9, 29) })
    const b = buildRouteCacheKey({ ...BASE, departureMs: Date.UTC(2026, 9, 1, 9, 31) })
    expect(a).not.toBe(b)
  })

  it('座標第 5 位小數的差異不影響鍵（4 位精度）', () => {
    const a = buildRouteCacheKey(BASE)
    const b = buildRouteCacheKey({ ...BASE, fromLat: 35.714781 })
    expect(a).toBe(b)
  })

  it('交通方式不同則鍵不同', () => {
    const a = buildRouteCacheKey(BASE)
    const b = buildRouteCacheKey({ ...BASE, mode: 'walking' })
    expect(a).not.toBe(b)
  })
})
