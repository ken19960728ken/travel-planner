import { describe, it, expect } from 'vitest'
import { parseRoster, resolveStopParticipants, legParticipants, MAX_PARTICIPANTS } from './participants'

const ok = { id: 'p1', user_id: null, name: '小明', color: '#e11d48' }

describe('parseRoster', () => {
  it('非陣列一律回空陣列', () => {
    expect(parseRoster(null)).toEqual([])
    expect(parseRoster('x')).toEqual([])
    expect(parseRoster({ id: 'p1' })).toEqual([])
  })

  it('逐個丟棄畸形元素，保留合法的（不整批放棄）', () => {
    expect(parseRoster([ok, null, { id: 'p2' }, { ...ok, id: 'p3', name: '' }, { ...ok, id: 'p4' }]))
      .toEqual([ok, { ...ok, id: 'p4' }])
  })

  it('id 重複時只留第一個', () => {
    expect(parseRoster([ok, { ...ok, name: '重複' }])).toHaveLength(1)
  })

  it('user_id 可為 null（無帳號同行者）或字串', () => {
    expect(parseRoster([{ ...ok, user_id: 'u1' }])[0].user_id).toBe('u1')
    expect(parseRoster([ok])[0].user_id).toBeNull()
  })

  it(`超過 ${MAX_PARTICIPANTS} 人截斷`, () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...ok, id: `p${i}` }))
    expect(parseRoster(many)).toHaveLength(MAX_PARTICIPANTS)
  })

  it('原型鏈上的鍵不會被誤當成資料（__proto__ 等不是自有屬性）', () => {
    expect(parseRoster([{ id: 'p1', name: '小明', color: '#fff' }])[0].user_id).toBeNull()
    expect(parseRoster([Object.create({ id: 'ghost', name: 'g', color: '#000' })])).toEqual([])
  })
})

describe('resolveStopParticipants', () => {
  const roster = ['p1', 'p2', 'p3']

  it('null 代表全員', () => {
    expect(resolveStopParticipants(null, roster)).toEqual(roster)
    expect(resolveStopParticipants(undefined, roster)).toEqual(roster)
  })

  it('非陣列視同全員（DB 形狀不可信）', () => {
    expect(resolveStopParticipants('p1', roster)).toEqual(roster)
  })

  it('只回傳名冊裡確實存在的 id，順序沿名冊', () => {
    expect(resolveStopParticipants(['p3', 'p1'], roster)).toEqual(['p1', 'p3'])
  })

  it('未知 id 被忽略', () => {
    expect(resolveStopParticipants(['p1', 'ghost'], roster)).toEqual(['p1'])
  })

  it('全部無效時視同全員——否則該停留點不在任何人的鏈上，前後交通段會無聲消失', () => {
    expect(resolveStopParticipants(['ghost'], roster)).toEqual(roster)
    expect(resolveStopParticipants([], roster)).toEqual(roster)
  })

  it('名冊為空時回空陣列（呼叫端據此退回單軌行為）', () => {
    expect(resolveStopParticipants(null, [])).toEqual([])
  })

  it('回傳值不是 roster 本身的參照（呼叫端 mutate 不會污染名冊）', () => {
    const out = resolveStopParticipants(null, roster)
    expect(out).not.toBe(roster)
  })
})

describe('legParticipants', () => {
  it('取交集，順序沿 from', () => {
    expect(legParticipants(['p1', 'p2', 'p3'], ['p3', 'p1'])).toEqual(['p1', 'p3'])
  })

  it('無交集回空陣列', () => {
    expect(legParticipants(['p1'], ['p2'])).toEqual([])
  })
})
