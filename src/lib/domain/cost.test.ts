import { describe, it, expect } from 'vitest'
import { totalEstimatedCost, perPersonCost, costByCategory } from './cost'
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
