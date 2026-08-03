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

  // 這批專打「輸出端驗證自我指涉」的殘留洞：曾用「輸出丟進 probe origin 再解析、要求同源」，
  // 而輸出若正規化成 `//<probe 主機>/x`，在 probe 下解析出來的 origin 正好就是 probe → 誤放行。
  // 改成形狀檢查後這些必須全擋。主機名故意寫成當初的兩個常數，鎖住這個具體失效模式。
  it('拒絕正規化後成為 protocol-relative 的值（含指向驗證用主機者）', () => {
    expect(safeNextPath('/..//safe-next-probe.invalid/x')).toBeNull()
    expect(safeNextPath('/./..//safe-next-probe.invalid/')).toBeNull()
    expect(safeNextPath('/.\\//safe-next-probe.invalid')).toBeNull()
    expect(safeNextPath('//safe-next.invalid/x')).toBeNull()
    expect(safeNextPath('/..///evil.com')).toBeNull()
  })
})
