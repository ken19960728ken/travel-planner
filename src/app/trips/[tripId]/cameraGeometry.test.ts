import { describe, it, expect } from 'vitest'
import { isInsideCenter, shouldPanCamera, type Viewport } from './cameraGeometry'

describe('isInsideCenter', () => {
  it('九州日：fitBounds 收好整段視野後，路線中點仍在中央 70% 內，不觸發 pan', () => {
    // 概略對應 fitBounds(福岡 33.58/130.45, 鹿兒島 31.80/130.72, padding 60) 收出來的視窗量級
    const viewport: Viewport = { ne: { lat: 34.5, lng: 132.0 }, sw: { lat: 30.5, lng: 129.0 } }
    const midpoint = { lat: 32.69, lng: 130.58 } // 兩停留點的路線中點附近
    expect(isInsideCenter(midpoint, viewport)).toBe(true)
  })

  it('單點日（零面積 bounds）：ne===sw 時安全退化為「不在中央」，不會除以零或誤判', () => {
    const viewport: Viewport = { ne: { lat: 35, lng: 139 }, sw: { lat: 35, lng: 139 } }
    expect(isInsideCenter({ lat: 35, lng: 139 }, viewport)).toBe(false)
  })

  it('跨 180 度經線（換日線）：視窗中央的點正確判定為 inside（M-1 根治）', () => {
    // sw.lng(170) > ne.lng(-170)：視窗往東橫跨換日線，寬度 20 度，中心約在 180/-180
    const viewport: Viewport = { ne: { lat: 10, lng: -170 }, sw: { lat: -10, lng: 170 } }
    expect(isInsideCenter({ lat: 0, lng: 180 }, viewport)).toBe(true)
    expect(isInsideCenter({ lat: 0, lng: -180 }, viewport)).toBe(true)
  })

  it('跨 180 度經線：貼近視窗邊緣（padding 區）的點正確判定為 outside，閘門仍會觸發 pan', () => {
    const viewport: Viewport = { ne: { lat: 10, lng: -170 }, sw: { lat: -10, lng: 170 } }
    // 寬度 20 度，padding 15% = 3 度；171 離 sw(170) 只有 1 度，落在 padding 區內
    expect(isInsideCenter({ lat: 0, lng: 171 }, viewport)).toBe(false)
  })
})

describe('shouldPanCamera', () => {
  it('getBounds() 為 undefined（地圖尚未 idle）時，保守地一律回傳需要 pan', () => {
    expect(shouldPanCamera({ lat: 0, lng: 0 }, null)).toBe(true)
  })

  it('viewport 存在且點在中央時不需要 pan', () => {
    const viewport: Viewport = { ne: { lat: 34.5, lng: 132.0 }, sw: { lat: 30.5, lng: 129.0 } }
    expect(shouldPanCamera({ lat: 32.69, lng: 130.58 }, viewport)).toBe(false)
  })
})
