import { describe, it, expect } from 'vitest'
import { assignLanes } from './lanes'

const H = 3_600_000
const it_ = (id: string, from: number, to: number) => ({ id, startsAt: from * H, endsAt: to * H })

describe('assignLanes', () => {
  it('空輸入回 laneCount 1（Timeline 的軌道高度不能是 0）', () => {
    expect(assignLanes([])).toEqual({ laneOf: new Map(), laneCount: 1 })
  })

  it('完全不重疊 → 全部在 lane 0，laneCount 1（既有行程零變化）', () => {
    const r = assignLanes([it_('a', 9, 10), it_('b', 11, 12), it_('c', 13, 14)])
    expect(r.laneCount).toBe(1)
    expect([...r.laneOf.values()]).toEqual([0, 0, 0])
  })

  it('前一段結束時刻＝後一段開始時刻，不算重疊（共用 lane）', () => {
    const r = assignLanes([it_('a', 9, 10), it_('b', 10, 11)])
    expect(r.laneCount).toBe(1)
  })

  it('兩個完全同時段 → 兩條 lane', () => {
    const r = assignLanes([it_('a', 11, 12), it_('b', 11, 12)])
    expect(r.laneCount).toBe(2)
    expect(r.laneOf.get('a')).toBe(0)
    expect(r.laneOf.get('b')).toBe(1)
  })

  it('三方重疊 → 三條 lane（laneCount 等於最大同時重疊數）', () => {
    const r = assignLanes([it_('a', 9, 12), it_('b', 10, 13), it_('c', 11, 14)])
    expect(r.laneCount).toBe(3)
  })

  it('重疊結束後回收 lane，不會無限增長', () => {
    // a、b 重疊用兩條；c 在兩者都結束後開始，應回到 lane 0
    const r = assignLanes([it_('a', 9, 11), it_('b', 10, 12), it_('c', 13, 14)])
    expect(r.laneCount).toBe(2)
    expect(r.laneOf.get('c')).toBe(0)
  })

  it('結果不隨輸入順序漂移（同刻以 id 決勝）', () => {
    const a = assignLanes([it_('x', 11, 12), it_('y', 11, 12)])
    const b = assignLanes([it_('y', 11, 12), it_('x', 11, 12)])
    expect([...a.laneOf]).toEqual([...b.laneOf])
  })

  it('零長度區間與後續共用 lane（依 <= 規則不算重疊）', () => {
    // DB 有 ends_at > starts_at 的 check，這只在 UI 拖曳預覽時可能短暫出現。
    // 共用 lane 是正確的——零寬色塊本來就不佔視覺空間；它「看不見也點不到」是
    // slot.ts 記錄過的另一個既有問題，不該由分軌來補償。
    const r = assignLanes([it_('a', 11, 11), it_('b', 11, 12)])
    expect(r.laneCount).toBe(1)
  })

  it('先開始但晚結束的區間不會讓後續誤判可共用（laneEnds 取 max）', () => {
    // a 橫跨整個上午，b 在中間，c 在 b 之後但仍在 a 之內
    const r = assignLanes([it_('a', 9, 15), it_('b', 10, 11), it_('c', 12, 13)])
    expect(r.laneCount).toBe(2)
    expect(r.laneOf.get('a')).toBe(0)
    expect(r.laneOf.get('b')).toBe(1)
    expect(r.laneOf.get('c')).toBe(1) // 回收 b 的 lane，不開第三條
  })
})
