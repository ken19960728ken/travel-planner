import { describe, it, expect } from 'vitest'
import { takeToken, type RateWindow } from './rateLimit'

describe('takeToken', () => {
  it('額度內放行並記錄時間戳（不改動輸入）', () => {
    const win: RateWindow = { timestamps: [0] }
    const r = takeToken(win, 1_000, 3, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.window.timestamps).toEqual([0, 1_000])
    expect(win.timestamps).toEqual([0]) // 不可變
  })
  it('額度滿時拒絕', () => {
    const r = takeToken({ timestamps: [0, 1, 2] }, 3, 3, 60_000)
    expect(r.allowed).toBe(false)
  })
  it('視窗外的舊時間戳釋放額度', () => {
    const r = takeToken({ timestamps: [0, 1, 2] }, 60_001, 3, 60_000)
    expect(r.allowed).toBe(true)
  })
})
