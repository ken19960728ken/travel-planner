import { describe, it, expect } from 'vitest'
import { tripDayKeys, filterDayStops } from './days'

describe('tripDayKeys', () => {
  it('起訖日期展開為連續日期鍵', () => {
    expect(tripDayKeys('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
  })

  it('起訖同日回傳單一鍵', () => {
    expect(tripDayKeys('2026-10-01', '2026-10-01')).toEqual(['2026-10-01'])
  })
})

describe('filterDayStops', () => {
  it('依當地日期過濾（跨日排除）並依開始時間排序（輸入刻意亂序）', () => {
    const stops = [
      { id: 'c', starts_at: '2026-10-01T10:00:00Z', timezone: 'Asia/Tokyo' }, // 東京 10/1 19:00
      { id: 'a', starts_at: '2026-09-30T23:00:00Z', timezone: 'Asia/Tokyo' }, // 東京 10/1 08:00
      { id: 'x', starts_at: '2026-10-02T01:00:00Z', timezone: 'Asia/Tokyo' }, // 東京 10/2，非當日
    ]
    expect(filterDayStops(stops, '2026-10-01').map(s => s.id)).toEqual(['a', 'c'])
  })
})
