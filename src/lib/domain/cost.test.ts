import { describe, it, expect } from 'vitest'
import { totalEstimatedCost, perPersonCost, costByCategory, costByParticipant, totalForSplit } from './cost'
import { CATEGORY_ORDER, type StopCategory } from './placeCategory'

describe('totalEstimatedCost', () => {
  it('加總所有項目，null 視為 0', () => {
    const items = [{ estimatedCost: 1200 }, { estimatedCost: null }, { estimatedCost: 180 }]
    expect(totalEstimatedCost(items)).toBe(1380)
  })

  it('空陣列回傳 0', () => {
    expect(totalEstimatedCost([])).toBe(0)
  })
})

describe('perPersonCost', () => {
  it('總額除以人數', () => {
    expect(perPersonCost(1380, 3)).toBe(460)
  })

  it('除不盡時回傳原始浮點數，不四捨五入（顯示層的事）', () => {
    expect(perPersonCost(1000, 3)).toBeCloseTo(1000 / 3, 10)
  })

  it('人數小於 1 時回傳總額', () => {
    expect(perPersonCost(1380, 0)).toBe(1380)
  })
})

describe('costByCategory', () => {
  it('依分類分桶，legs 獨立成第七桶', () => {
    const r = costByCategory(
      [
        { category: 'food', estimatedCost: 800 },
        { category: 'food', estimatedCost: 200 },
        { category: 'lodging', estimatedCost: 3000 },
        { category: 'transport', estimatedCost: 50 },
      ],
      [{ estimatedCost: 1200 }, { estimatedCost: 340 }],
    )
    expect(r.byCategory.food).toBe(1000)
    expect(r.byCategory.lodging).toBe(3000)
    expect(r.byCategory.transport).toBe(50)
    expect(r.byCategory.sight).toBe(0)
    expect(r.legs).toBe(1540)
    expect(r.total).toBe(5590)
  })

  it('六個桶恆存在，未出現的分類為 0', () => {
    const r = costByCategory([{ category: 'sight', estimatedCost: 100 }], [])
    expect(Object.keys(r.byCategory).sort()).toEqual([...CATEGORY_ORDER].sort())
    for (const c of CATEGORY_ORDER) expect(typeof r.byCategory[c]).toBe('number')
  })

  it('null 花費視為 0', () => {
    const r = costByCategory(
      [{ category: 'food', estimatedCost: null }, { category: 'food', estimatedCost: 60 }],
      [{ estimatedCost: null }],
    )
    expect(r.byCategory.food).toBe(60)
    expect(r.legs).toBe(0)
    expect(r.total).toBe(60)
  })

  it('空陣列 → 七桶皆 0', () => {
    const r = costByCategory([], [])
    for (const c of CATEGORY_ORDER) expect(r.byCategory[c]).toBe(0)
    expect(r.legs).toBe(0)
    expect(r.total).toBe(0)
  })

  it('只有 legs 沒有 stops', () => {
    const r = costByCategory([], [{ estimatedCost: 500 }])
    expect(r.legs).toBe(500)
    expect(r.total).toBe(500)
  })

  it('只有 stops 沒有 legs', () => {
    const r = costByCategory([{ category: 'shopping', estimatedCost: 700 }], [])
    expect(r.byCategory.shopping).toBe(700)
    expect(r.legs).toBe(0)
    expect(r.total).toBe(700)
  })

  // D5 不變量（R9）：小計加總必等於總計，且總計必等於既有 totalEstimatedCost 的結果。
  // 用隨機組合而非固定案例——固定案例只能證明「這幾筆對」，不變量要證明「所有組合都對」。
  it('不變量：sum(六桶) + legs === total === totalEstimatedCost(全部)', () => {
    let seed = 20260802
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 200; round++) {
      const stops = Array.from({ length: Math.floor(rand() * 12) }, () => ({
        category: CATEGORY_ORDER[Math.floor(rand() * CATEGORY_ORDER.length)] as StopCategory,
        estimatedCost: rand() < 0.25 ? null : Math.round(rand() * 5000),
      }))
      const legs = Array.from({ length: Math.floor(rand() * 8) }, () => ({
        estimatedCost: rand() < 0.25 ? null : Math.round(rand() * 3000),
      }))
      const r = costByCategory(stops, legs)
      const bucketSum = Object.values(r.byCategory).reduce((a, b) => a + b, 0)
      expect(bucketSum + r.legs).toBe(r.total)
      expect(r.total).toBe(totalEstimatedCost([...stops, ...legs]))
    }
  })
})

describe('costByParticipant', () => {
  const roster = ['p1', 'p2', 'p3']

  it('未指派（null）＝全員均分', () => {
    expect(costByParticipant([{ estimatedCost: 900, participantIds: null }], roster))
      .toEqual({ p1: 300, p2: 300, p3: 300 })
  })

  it('只有部分人參與時，只分攤給他們', () => {
    expect(costByParticipant([{ estimatedCost: 900, participantIds: ['p1', 'p2'] }], roster))
      .toEqual({ p1: 450, p2: 450, p3: 0 })
  })

  it('除不盡時餘數按 id 字典序分給前幾人，總和嚴格等於原金額', () => {
    const r = costByParticipant([{ estimatedCost: 1000, participantIds: null }], roster)
    expect(r).toEqual({ p1: 334, p2: 333, p3: 333 })
    expect(r.p1 + r.p2 + r.p3).toBe(1000)
  })

  it('分配是決定性的：participantIds 順序不影響結果', () => {
    const a = costByParticipant([{ estimatedCost: 1000, participantIds: ['p3', 'p1', 'p2'] }], roster)
    const b = costByParticipant([{ estimatedCost: 1000, participantIds: ['p1', 'p2', 'p3'] }], roster)
    expect(a).toEqual(b)
  })

  it('null 花費與 0 一律略過', () => {
    expect(costByParticipant([
      { estimatedCost: null, participantIds: null },
      { estimatedCost: 0, participantIds: null },
    ], roster)).toEqual({ p1: 0, p2: 0, p3: 0 })
  })

  it('名冊為空時回空物件', () => {
    expect(costByParticipant([{ estimatedCost: 900, participantIds: null }], [])).toEqual({})
  })

  it('未知 id 的指派視同全員（與 resolveStopParticipants 同一套規則，不另開分支）', () => {
    expect(costByParticipant([{ estimatedCost: 900, participantIds: ['ghost'] }], roster))
      .toEqual({ p1: 300, p2: 300, p3: 300 })
  })

  // 端點參與人無交集的交通段（只可能出現在「已脫離順序」的段落：起點只有甲、終點只有乙）。
  // 交集為空 → resolveStopParticipants 視同全員 → 該筆算給所有人。
  // 這是**刻意**的：不算給任何人會讓「sum(每人) === 總計」的不變量破掉，帳面對不起來，
  // 而錢確實花掉了。脫離順序的段落在 UI 上本就另外標示，使用者看得到它的存在。
  it('端點無交集的交通段算給全員（維持分帳不變量，不是漏判）', () => {
    expect(costByParticipant([{ estimatedCost: 900, participantIds: [] }], roster))
      .toEqual({ p1: 300, p2: 300, p3: 300 })
  })

  // 審查 M-4：estimated_cost 是 numeric(12,2)、輸入框是 step="0.01"，小數是明確支援的輸入。
  // 舊版先 Math.round 到整數再分，導致 total 100.5 而每人加總 101、三筆 0.4 直接歸零。
  // 在最小單位上比較——scale=100 時把各人的值除回「元」再相加有浮點誤差
  // （0.4+0.4+0.4 = 1.2000000000000002），那是 IEEE 754 的性質不是演算法缺陷
  const cents = (n: number) => Math.round(n * 100)
  const sumCents = (per: Record<string, number>) =>
    Object.values(per).reduce((s, v) => s + cents(v), 0)

  it('全整數金額時以「元」為單位分攤，不會產生付不出來的 333.34 日圓', () => {
    const r = costByParticipant([{ estimatedCost: 1000, participantIds: null }], roster)
    expect(r).toEqual({ p1: 334, p2: 333, p3: 333 })
  })

  it('小數金額：切到 1/100 分攤，總和在最小單位上嚴格相等', () => {
    const items = [{ estimatedCost: 100.5, participantIds: ['p1', 'p2'] }]
    const r = costByParticipant(items, roster)
    expect(sumCents(r)).toBe(cents(totalForSplit(items)))
    expect(totalForSplit(items)).toBe(100.5)
    expect(r).toEqual({ p1: 50.25, p2: 50.25, p3: 0 })
  })

  it('小額不再被整包丟棄（舊版 Math.round(0.4) = 0 讓三筆 0.4 全歸零）', () => {
    const items = [
      { estimatedCost: 0.4, participantIds: null },
      { estimatedCost: 0.4, participantIds: null },
      { estimatedCost: 0.4, participantIds: null },
    ]
    const r = costByParticipant(items, roster)
    expect(sumCents(r)).toBe(cents(totalForSplit(items)))
    expect(sumCents(r)).toBe(120)
  })

  it('不變量：任意組合（含小數）下 sum(每人應付) === totalForSplit（最小單位）', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      estimatedCost: ((i * 37) % 1000) + (i % 4) * 0.25,
      participantIds: i % 3 === 0 ? null : ['p1', 'p2', 'p3'].slice(0, (i % 3) + 1),
    }))
    expect(sumCents(costByParticipant(items, roster))).toBe(cents(totalForSplit(items)))
  })

  it('不變量：整數組合下 sum(每人應付) === 總額', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      estimatedCost: (i * 37) % 1000,
      participantIds: i % 3 === 0 ? null : ['p1', 'p2', 'p3'].slice(0, (i % 3) + 1),
    }))
    const total = items.reduce((sum, i) => sum + (i.estimatedCost ?? 0), 0)
    const per = costByParticipant(items, roster)
    expect(Object.values(per).reduce((a, b) => a + b, 0)).toBe(total)
  })
})
