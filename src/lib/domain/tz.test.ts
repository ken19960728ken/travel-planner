import { describe, it, expect } from 'vitest'
import { utcMsToWallInput, wallInputToUtcMs, formatLocalTime, localDateKey, localWeekMinute } from './tz'

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

  it('localWeekMinute 換算當地週幾與當日分鐘數', () => {
    // UTC 2026-10-01（週四）16:00 = 東京 2026-10-02（週五）01:00 → day=5, minutes=60
    expect(localWeekMinute(Date.UTC(2026, 9, 1, 16, 0), 'Asia/Tokyo')).toEqual({ day: 5, minutes: 60 })
  })

  // spec §8 DST 條目：鎖定 date-fns-tz 對「不存在／重複」的當地牆面時刻的實際回傳值，
  // 不做顯式拒絕（本產品時區主場景東亞無 DST）。斷言值皆為實跑 fromZonedTime 取得，非推算。
  it('wallInputToUtcMs 對紐約春進不存在時刻（02:00-02:59 被跳過）靜默位移', () => {
    // 2026-03-08 紐約 02:00 EST 直接跳到 03:00 EDT，02:30 這個牆面時刻不存在。
    // 實測結果：date-fns-tz 套用「跳點之後」的 EDT（UTC-4）位移規則解讀輸入，
    // 得出 UTC 06:30——換算回當地實際是 01:30 EST（跳點前一小時），而非輸入的 02:30。
    // 靜默位移為現行接受的語義：不擋輸入、不拋錯，交給使用者自行發現落地時間有落差。
    expect(wallInputToUtcMs('2026-03-08T02:30', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 6, 30))
  })

  it('wallInputToUtcMs 對紐約秋回重複時刻（01:00-01:59 出現兩次）取後段 EST 位移', () => {
    // 2026-11-01 紐約 02:00 EDT 撥回 01:00 EST，01:30 這個牆面時刻出現兩次
    // （第一次 01:30 EDT／UTC-4，第二次 01:30 EST／UTC-5）。
    // 實測結果：date-fns-tz 取的是撥回「之後」的第二次出現（EST，UTC-5，UTC 06:30），
    // 而非較早的 EDT 那次（UTC 05:30）。靜默擇一為現行接受的語義，不做顯式拒絕。
    expect(wallInputToUtcMs('2026-11-01T01:30', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 6, 30))
  })
})
