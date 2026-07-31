import { describe, it, expect } from 'vitest'
import { utcMsToWallInput, wallInputToUtcMs, formatLocalTime, localDateKey } from './tz'

// 固定用 Asia/Tokyo（UTC+9，無夏令）與 America/New_York（有夏令）——結果與執行機器的時區無關
describe('tz 轉換', () => {
  it('UTC → 東京牆面時間（datetime-local 格式）', () => {
    expect(utcMsToWallInput(Date.UTC(2026, 9, 1, 0, 0), 'Asia/Tokyo')).toBe('2026-10-01T09:00')
  })

  it('東京牆面時間 → UTC（雙向往返）', () => {
    const ms = wallInputToUtcMs('2026-10-01T09:00', 'Asia/Tokyo')
    expect(ms).toBe(Date.UTC(2026, 9, 1, 0, 0))
    expect(utcMsToWallInput(ms, 'Asia/Tokyo')).toBe('2026-10-01T09:00')
  })

  it('夏令時區的轉換正確（紐約 3 月）', () => {
    // 2026-03-15 紐約為 EDT（UTC-4）
    expect(wallInputToUtcMs('2026-03-15T08:00', 'America/New_York')).toBe(Date.UTC(2026, 2, 15, 12, 0))
  })

  it('formatLocalTime 輸出 HH:mm', () => {
    expect(formatLocalTime(Date.UTC(2026, 9, 1, 0, 30), 'Asia/Tokyo')).toBe('09:30')
  })

  it('localDateKey 依當地日期（跨日邊界）', () => {
    // UTC 10/1 16:00 = 東京 10/2 01:00
    expect(localDateKey(Date.UTC(2026, 9, 1, 16, 0), 'Asia/Tokyo')).toBe('2026-10-02')
  })
})
