import { describe, it, expect } from 'vitest'
import { safeNextPath } from './safeNext'

describe('safeNextPath', () => {
  it('接受站內相對路徑', () => {
    expect(safeNextPath('/trips')).toBe('/trips')
    expect(safeNextPath('/invite/0f2b7e6a-1234-4a2b-8c3d-abcdef123456')).toBe(
      '/invite/0f2b7e6a-1234-4a2b-8c3d-abcdef123456',
    )
  })

  it('保留查詢字串與 hash', () => {
    expect(safeNextPath('/trips?day=2026-08-05#timeline')).toBe('/trips?day=2026-08-05#timeline')
  })

  it('拒絕 protocol-relative URL（開頭 //）', () => {
    expect(safeNextPath('//evil.com')).toBeNull()
  })

  it('拒絕外站絕對網址', () => {
    expect(safeNextPath('https://evil.com')).toBeNull()
    expect(safeNextPath('http://evil.com/trips')).toBeNull()
  })

  it('拒絕不以 / 開頭的相對路徑', () => {
    expect(safeNextPath('trips')).toBeNull()
  })

  it('null 或空字串一律回傳 null', () => {
    expect(safeNextPath(null)).toBeNull()
    expect(safeNextPath('')).toBeNull()
  })

  // 以下五個向量在初版 `startsWith('/') && !startsWith('//')` 判準下全部通過，
  // 但 new URL(next, origin) 會把它們解析成 https://evil.com/ —— 即 open redirect。
  // 每一條都是 2026-08-04 安全審查用 node 實測確認過的，不是推測值。
  it('拒絕反斜線變體（WHATWG special-authority-ignore-slashes）', () => {
    expect(safeNextPath('/\\evil.com')).toBeNull()
    expect(safeNextPath('/\\/evil.com')).toBeNull()
  })

  it('拒絕內嵌 ASCII 控制字元的變體（解析前會被整串移除）', () => {
    // URLSearchParams.get() 會解百分比編碼，所以 ?next=/%09/evil.com 到達這裡時是真的 tab 字元
    expect(safeNextPath('/\t/evil.com')).toBeNull()
    expect(safeNextPath('/\n/evil.com')).toBeNull()
    expect(safeNextPath('/\r/evil.com')).toBeNull()
  })

  it('編碼後的斜線維持站內（正規化後仍是本站路徑）', () => {
    // %2F 不會被解成路徑分隔符，解析結果仍在本站，屬安全值——鎖住行為避免日後誤擋
    expect(safeNextPath('/%2F%2Fevil.com')).toBe('/%2F%2Fevil.com')
  })

  // 這三條會通過「輸入解析同源」那一關（origin 仍是 sentinel），但正規化後的 pathname 是
  // `//evil.com`，呼叫端再解析一次就變外站——是輸出端二次驗證存在的唯一理由，刪掉就破。
  it('拒絕路徑穿越後正規化成 protocol-relative 的值', () => {
    expect(safeNextPath('/..//evil.com')).toBeNull()
    expect(safeNextPath('/./..//evil.com')).toBeNull()
    expect(safeNextPath('/a/../..//evil.com')).toBeNull()
  })

  it('回傳正規化後的路徑而非原始字串', () => {
    expect(safeNextPath('/trips/../invite/abc')).toBe('/invite/abc')
  })
})
