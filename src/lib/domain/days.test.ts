import { describe, it, expect } from 'vitest'
import { tripDayKeys } from './days'

describe('tripDayKeys', () => {
  it('起訖日期展開為連續日期鍵', () => {
    expect(tripDayKeys('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
  })

  it('起訖同日回傳單一鍵', () => {
    expect(tripDayKeys('2026-10-01', '2026-10-01')).toEqual(['2026-10-01'])
  })
})
