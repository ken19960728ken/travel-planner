import { describe, it, expect } from 'vitest'
import { totalEstimatedCost, perPersonCost } from './cost'

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

  it('人數小於 1 時回傳總額', () => {
    expect(perPersonCost(1380, 0)).toBe(1380)
  })
})
