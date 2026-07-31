import { describe, it, expect } from 'vitest'
import { adjacentPairs, planLegSync, AUTO_TTL_MS, type SyncStop, type SyncLeg } from './legSync'

const H = 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 1, 0)
const stop = (id: string, s: number, e: number): SyncStop =>
  ({ id, lat: 33, lng: 130, startsAt: NOW + s * H, endsAt: NOW + e * H })
const leg = (over: Partial<SyncLeg>): SyncLeg => ({
  id: 'L', fromStopId: 'a', toStopId: 'b', source: 'auto',
  durationMinutes: 10, departsAtMs: NOW + 2 * H, computedAtMs: NOW, stale: false,
  estimatedCost: null, ...over,
})

describe('adjacentPairs', () => {
  it('按 startsAt 排序取連續配對（不限同日）', () => {
    const pairs = adjacentPairs([stop('b', 3, 4), stop('a', 1, 2), stop('c', 30, 31)])
    expect(pairs.map(([f, t]) => `${f.id}→${t.id}`)).toEqual(['a→b', 'b→c'])
  })
  it('少於兩個停留點回傳空陣列', () => {
    expect(adjacentPairs([stop('a', 1, 2)])).toEqual([])
    expect(adjacentPairs([])).toEqual([])
  })
})

describe('planLegSync', () => {
  const stops = [stop('a', 1, 2), stop('b', 3, 4), stop('c', 5, 6)]

  it('缺 leg 的相鄰配對進 create', () => {
    const plan = planLegSync(stops, [], NOW)
    expect(plan.create).toEqual([
      { fromStopId: 'a', toStopId: 'b' },
      { fromStopId: 'b', toStopId: 'c' },
    ])
  })

  it('配對不再相鄰：auto 段進 removeAuto、manual 段進 markStale', () => {
    const plan = planLegSync(stops, [
      leg({ id: 'L1', fromStopId: 'a', toStopId: 'c' }),
      leg({ id: 'L2', fromStopId: 'c', toStopId: 'a', source: 'manual' }),
    ], NOW)
    expect(plan.removeAuto).toEqual(['L1'])
    expect(plan.markStale).toEqual(['L2'])
  })

  it('配對脫離的 auto 段有花費 → detachAuto（不進 removeAuto，Important-1 根治）', () => {
    const plan = planLegSync(stops, [
      leg({ id: 'L1', fromStopId: 'a', toStopId: 'c', estimatedCost: 500 }),
    ], NOW)
    expect(plan.detachAuto).toEqual(['L1'])
    expect(plan.removeAuto).toEqual([])
  })

  it('配對脫離的 auto 段無花費 → removeAuto（現行為不變，不進 detachAuto）', () => {
    const plan = planLegSync(stops, [
      leg({ id: 'L1', fromStopId: 'a', toStopId: 'c', estimatedCost: null }),
    ], NOW)
    expect(plan.removeAuto).toEqual(['L1'])
    expect(plan.detachAuto).toEqual([])
  })

  it('相鄰配對上的帶花費 auto 段完全不動（不進 detachAuto/removeAuto）', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', estimatedCost: 300 })], NOW)
    expect(plan.detachAuto).toEqual([])
    expect(plan.removeAuto).toEqual([])
  })

  it('已 stale 的 manual 段不重複進 markStale', () => {
    const plan = planLegSync(stops, [leg({ id: 'L2', fromStopId: 'c', toStopId: 'a', source: 'manual', stale: true })], NOW)
    expect(plan.markStale).toEqual([])
  })

  it('auto 段從未計算（computed_at null）進 recompute', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', durationMinutes: null, computedAtMs: null })], NOW)
    expect(plan.recompute).toEqual(['L1'])
  })

  it('no_route 段（duration null 但已計算過）不每次重算，靠 TTL 重試（成本護欄，審查 M-2）', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', durationMinutes: null })], NOW)
    expect(plan.recompute).toEqual([])
  })

  it('auto 段 departs 基準偏離 from.endsAt 進 recompute', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', departsAtMs: NOW + 1 * H })], NOW)
    expect(plan.recompute).toEqual(['L1'])
  })

  it('auto 段 computed_at 超過 30 天 TTL 進 recompute（ToS 分層）', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', computedAtMs: NOW - AUTO_TTL_MS - 1 })], NOW + 0)
    expect(plan.recompute).toEqual(['L1'])
  })

  it('基準吻合且未過期的 auto 段不動', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1' })], NOW)
    expect(plan).toEqual({
      create: [{ fromStopId: 'b', toStopId: 'c' }], removeAuto: [], detachAuto: [], markStale: [], recompute: [],
    })
  })

  it('相鄰配對上的 manual 段完全不動（絕不被自動覆蓋）', () => {
    const plan = planLegSync(stops, [
      leg({ id: 'L1', source: 'manual', durationMinutes: null, computedAtMs: NOW - AUTO_TTL_MS * 2 }),
    ], NOW)
    expect(plan.removeAuto).toEqual([])
    expect(plan.markStale).toEqual([])
    expect(plan.recompute).toEqual([])
  })
})
