import { describe, it, expect } from 'vitest'
import { toDatetimeLocalValue, fromDatetimeLocalValue } from './datetime'

describe('datetime-local 轉換', () => {
  it('分鐘對齊的時間戳可無損往返', () => {
    const ms = new Date(2026, 9, 1, 9, 30).getTime()
    expect(fromDatetimeLocalValue(toDatetimeLocalValue(ms))).toBe(ms)
  })

  it('輸出符合 datetime-local 格式', () => {
    expect(toDatetimeLocalValue(new Date(2026, 0, 5, 8, 7).getTime())).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
})
