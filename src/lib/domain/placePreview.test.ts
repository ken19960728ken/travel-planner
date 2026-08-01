import { describe, it, expect } from 'vitest'
import { isRatableCategory, priceLevelLabel, googleMapsSearchUrl } from './placePreview'

describe('isRatableCategory', () => {
  it('primaryType 命中白名單即為 true', () => {
    expect(isRatableCategory([], 'restaurant')).toBe(true)
  })

  it('types 陣列命中白名單即為 true', () => {
    expect(isRatableCategory(['point_of_interest', 'cafe'], null)).toBe(true)
  })

  it('車站等未列入白名單者為 false', () => {
    expect(isRatableCategory(['train_station', 'transit_station'], 'train_station')).toBe(false)
  })

  it('空陣列且無 primaryType 為 false', () => {
    expect(isRatableCategory([], null)).toBe(false)
    expect(isRatableCategory([], undefined)).toBe(false)
  })

  it('刻意擴大：拉麵店（舊白名單漏掉的 Food and Drink 細分類）現在也算 ratable', () => {
    expect(isRatableCategory([], 'ramen_restaurant')).toBe(true)
  })

  it('atm 不屬於任何 ratable 分類，仍為 false', () => {
    expect(isRatableCategory([], 'atm')).toBe(false)
  })
})

describe('priceLevelLabel', () => {
  it('已知等級對應到金錢符號', () => {
    expect(priceLevelLabel('INEXPENSIVE')).toBe('¥')
    expect(priceLevelLabel('MODERATE')).toBe('¥¥')
    expect(priceLevelLabel('VERY_EXPENSIVE')).toBe('¥¥¥¥')
    expect(priceLevelLabel('FREE')).toBe('免費')
  })

  it('null/undefined/未知值回傳 null', () => {
    expect(priceLevelLabel(null)).toBeNull()
    expect(priceLevelLabel(undefined)).toBeNull()
    expect(priceLevelLabel('PRICE_LEVEL_UNSPECIFIED')).toBeNull()
  })
})

describe('googleMapsSearchUrl', () => {
  it('組出含 query 與 query_place_id 的官方 Search action 網址', () => {
    const url = googleMapsSearchUrl('ChIJabc123', '一蘭 本店')
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=%E4%B8%80%E8%98%AD+%E6%9C%AC%E5%BA%97&query_place_id=ChIJabc123')
  })
})
