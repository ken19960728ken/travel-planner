import { describe, it, expect } from 'vitest'
import { safeNextPath } from './safeNext'

describe('safeNextPath', () => {
  it('接受站內相對路徑', () => {
    expect(safeNextPath('/trips')).toBe('/trips')
    expect(safeNextPath('/invite/0f2b7e6a-1234-4a2b-8c3d-abcdef123456')).toBe(
      '/invite/0f2b7e6a-1234-4a2b-8c3d-abcdef123456',
    )
  })

  it('拒絕 protocol-relative URL（開頭 //）', () => {
    expect(safeNextPath('//evil.com')).toBeNull()
  })

  it('拒絕外站絕對網址', () => {
    expect(safeNextPath('https://evil.com')).toBeNull()
  })

  it('拒絕不以 / 開頭的相對路徑', () => {
    expect(safeNextPath('trips')).toBeNull()
  })

  it('null 或空字串一律回傳 null', () => {
    expect(safeNextPath(null)).toBeNull()
    expect(safeNextPath('')).toBeNull()
  })
})
