import { describe, it, expect } from 'vitest'
import { legDurationShortText, legDurationText } from './legUi'
import type { Leg } from './TripView'

// isNoRoute/isNoTransitData/legDurationText 的完整行為測試已下沉至
// src/lib/domain/legStatus.test.ts（N-1 單一來源）；這裡只測 legUi.ts 自己持有的
// legDurationShortText（Timeline 連接條專用短標籤，legStatus.ts 沒有這個概念）。
const mkLeg = (over: Partial<Leg> = {}): Leg => ({
  id: 'L', from_stop_id: 'A', to_stop_id: 'B', mode: 'transit',
  duration_minutes: null, distance_meters: null, polyline: null, custom_path: null, detail: null,
  source: 'auto', stale: false, departs_at: null, arrives_at: null,
  estimated_cost: null, updated_at: '2026-08-01T00:00:00Z',
  ...over,
})

describe('legDurationShortText（M-1：Timeline 連接條窄空間短標籤）', () => {
  it('有 duration_minutes 且非 no_transit_data 時顯示「N 分」', () => {
    expect(legDurationShortText(mkLeg({ duration_minutes: 30 }))).toBe('30 分')
  })
  it('no_transit_data 有 duration_minutes 時顯示「步行約N分」（比完整文案短）', () => {
    expect(legDurationShortText(mkLeg({ duration_minutes: 35, detail: { no_transit_data: true } }))).toBe('步行約35分')
  })
  it('no_transit_data 但沒有 duration_minutes（防禦性邊界，正常流程不會發生）顯示「無班次資料」', () => {
    expect(legDurationShortText(mkLeg({ duration_minutes: null, detail: { no_transit_data: true } }))).toBe('無班次資料')
  })
  it('duration 為 null 且 detail.no_route 時顯示「查無路線」', () => {
    expect(legDurationShortText(mkLeg({ duration_minutes: null, detail: { no_route: true } }))).toBe('查無路線')
  })
  it('duration 為 null 且 detail 為 null 時顯示「待計算」', () => {
    expect(legDurationShortText(mkLeg({ duration_minutes: null, detail: null }))).toBe('待計算')
  })
})

describe('legDurationText 與 legDurationShortText 語意一致性（m-8：N-1 單一來源不該讓兩處文案漂移）', () => {
  it('duration=null + no_transit_data：兩者都要指出「無大眾運輸資料」，都不能落回「待計算」', () => {
    const leg = mkLeg({ duration_minutes: null, detail: { no_transit_data: true } })
    expect(legDurationText(leg)).not.toBe('待計算')
    expect(legDurationShortText(leg)).not.toBe('待計算')
    expect(legDurationText(leg)).toBe('無大眾運輸資料')
    expect(legDurationShortText(leg)).toBe('無班次資料')
  })
})
