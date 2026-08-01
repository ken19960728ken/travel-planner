import { describe, it, expect } from 'vitest'
import { isNoRoute, isNoTransitData, legDurationText, type LegStatusInput } from './legStatus'

const mkLeg = (over: Partial<LegStatusInput> = {}): LegStatusInput => ({
  duration_minutes: null, detail: null, ...over,
})

describe('legDurationText', () => {
  it('有 duration_minutes 且 detail 為 null 時顯示「N 分」', () => {
    expect(legDurationText(mkLeg({ duration_minutes: 30 }))).toBe('30 分')
  })
  it('duration 為 null 且 detail 為 null 時顯示「待計算」', () => {
    expect(legDurationText(mkLeg({ duration_minutes: null, detail: null }))).toBe('待計算')
  })
  it('duration 為 null 且 detail.no_route 時顯示「查無路線」', () => {
    expect(legDurationText(mkLeg({ duration_minutes: null, detail: { no_route: true } }))).toBe('查無路線')
  })
  it('duration 有值且 detail.no_transit_data 時顯示「無大眾運輸資料（步行約 N 分）」（I-2 方案 a：保留步行時長）', () => {
    expect(legDurationText(mkLeg({ duration_minutes: 35, detail: { no_transit_data: true } }))).toBe(
      '無大眾運輸資料（步行約 35 分）',
    )
  })
  it('duration 為 null 且 detail.no_transit_data 時顯示「無大眾運輸資料」，不落回「待計算」（m-8：N-1 抽取遺漏的分支）', () => {
    expect(legDurationText(mkLeg({ duration_minutes: null, detail: { no_transit_data: true } }))).toBe('無大眾運輸資料')
  })
})

describe('legDurationText 優先序（M-3：detail 同時髒污含 no_route 與 no_transit_data 的邊界情境）', () => {
  it('duration_minutes 有值時（no_transit_data 的正常型態）忽略 no_route，顯示步行估算', () => {
    const leg = mkLeg({ duration_minutes: 12, detail: { no_route: true, no_transit_data: true } })
    expect(legDurationText(leg)).toBe('無大眾運輸資料（步行約 12 分）')
  })
  it('duration_minutes 為 null 時（正常流程不會發生，僅防禦資料髒污）no_route 優先於 no_transit_data', () => {
    const leg = mkLeg({ duration_minutes: null, detail: { no_route: true, no_transit_data: true } })
    expect(legDurationText(leg)).toBe('查無路線')
  })
})

describe('isNoRoute / isNoTransitData', () => {
  it('各自獨立判斷 detail 上的旗標，互不影響', () => {
    expect(isNoRoute(mkLeg({ detail: { no_route: true } }))).toBe(true)
    expect(isNoTransitData(mkLeg({ detail: { no_route: true } }))).toBe(false)
    expect(isNoRoute(mkLeg({ detail: { no_transit_data: true } }))).toBe(false)
    expect(isNoTransitData(mkLeg({ detail: { no_transit_data: true } }))).toBe(true)
  })
  it('detail 為 null 或非物件時兩者皆為 false', () => {
    expect(isNoRoute(mkLeg({ detail: null }))).toBe(false)
    expect(isNoTransitData(mkLeg({ detail: null }))).toBe(false)
  })
})
