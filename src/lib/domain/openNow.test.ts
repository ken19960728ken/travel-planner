import { describe, it, expect } from 'vitest'
import { isOpenNow, type OpeningPeriod } from './openNow'

describe('isOpenNow', () => {
  it('落在單一時段內為營業中', () => {
    const periods: OpeningPeriod[] = [{ openDay: 2, openMinutes: 9 * 60, closeDay: 2, closeMinutes: 22 * 60 }]
    expect(isOpenNow(periods, 2, 10 * 60)).toBe(true)
    expect(isOpenNow(periods, 2, 23 * 60)).toBe(false)
  })

  it('不在任何時段內為休息中', () => {
    const periods: OpeningPeriod[] = [{ openDay: 1, openMinutes: 9 * 60, closeDay: 1, closeMinutes: 17 * 60 }]
    expect(isOpenNow(periods, 2, 10 * 60)).toBe(false)
  })

  it('跨夜時段（週五 22:00 開到週六 02:00）在午夜後仍算營業中', () => {
    const periods: OpeningPeriod[] = [{ openDay: 5, openMinutes: 22 * 60, closeDay: 6, closeMinutes: 2 * 60 }]
    expect(isOpenNow(periods, 6, 1 * 60)).toBe(true) // 週六 01:00
    expect(isOpenNow(periods, 5, 23 * 60)).toBe(true) // 週五 23:00
    expect(isOpenNow(periods, 6, 3 * 60)).toBe(false) // 週六 03:00 已打烊
  })

  it('跨週邊界（週六 23:00 開到週日 01:00）在週日凌晨仍算營業中', () => {
    const periods: OpeningPeriod[] = [{ openDay: 6, openMinutes: 23 * 60, closeDay: 0, closeMinutes: 1 * 60 }]
    expect(isOpenNow(periods, 0, 0 * 60)).toBe(true) // 週日 00:00
    expect(isOpenNow(periods, 0, 2 * 60)).toBe(false) // 週日 02:00 已打烊
  })

  it('close 為 null 視為 24 小時營業', () => {
    const periods: OpeningPeriod[] = [{ openDay: 3, openMinutes: 0, closeDay: null, closeMinutes: null }]
    expect(isOpenNow(periods, 3, 3 * 60)).toBe(true)
  })

  it('多時段任一命中即為營業中', () => {
    const periods: OpeningPeriod[] = [
      { openDay: 1, openMinutes: 9 * 60, closeDay: 1, closeMinutes: 14 * 60 },
      { openDay: 1, openMinutes: 17 * 60, closeDay: 1, closeMinutes: 21 * 60 },
    ]
    expect(isOpenNow(periods, 1, 18 * 60)).toBe(true)
    expect(isOpenNow(periods, 1, 15 * 60)).toBe(false) // 兩段之間的空檔
  })

  it('空陣列一律為休息中', () => {
    expect(isOpenNow([], 1, 12 * 60)).toBe(false)
  })
})
