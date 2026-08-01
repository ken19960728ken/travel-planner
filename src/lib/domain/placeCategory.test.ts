import { describe, it, expect } from 'vitest'
import { categorize, normalizeCategory, CATEGORY_TYPES, CATEGORY_ORDER, CATEGORY_LABEL } from './placeCategory'

describe('categorize', () => {
  it('東京駅：多個交通 type，無 primaryType', () => {
    expect(categorize(['train_station', 'subway_station', 'transit_station', 'shopping_mall'], null)).toBe('transport')
  })

  it('明治神宮：primaryType=shinto_shrine', () => {
    expect(categorize([], 'shinto_shrine')).toBe('sight')
  })

  it('一蘭：primaryType=ramen_restaurant', () => {
    expect(categorize([], 'ramen_restaurant')).toBe('food')
  })

  it('帶餐廳的飯店：hotel 排在前面', () => {
    expect(categorize(['hotel', 'lodging', 'restaurant'], null)).toBe('lodging')
  })

  it('純雜訊：point_of_interest/establishment 皆無歸屬', () => {
    expect(categorize(['point_of_interest', 'establishment'], null)).toBe('other')
  })

  it('primaryType 優先於 types 陣列', () => {
    expect(categorize(['restaurant'], 'train_station')).toBe('transport')
  })

  it('primaryType 落在 other 時改用 types 陣列（不視為已命中）', () => {
    expect(categorize(['ramen_restaurant'], 'point_of_interest')).toBe('food')
  })

  it('Table B：place_of_worship 伴隨具體宗教型別，仍歸 sight', () => {
    expect(categorize(['shinto_shrine', 'place_of_worship'], null)).toBe('sight')
  })

  it('Table B：food 伴隨 point_of_interest，仍歸 food', () => {
    expect(categorize(['food', 'point_of_interest'], null)).toBe('food')
  })

  it('具名例外：bridge 歸 sight（非 transport）', () => {
    expect(categorize(['bridge'], null)).toBe('sight')
  })

  it('具名例外：ski_resort 歸 sight', () => {
    expect(categorize(['ski_resort'], null)).toBe('sight')
  })

  it('types 陣列依原順序，第一個命中即回傳', () => {
    expect(categorize(['point_of_interest', 'cafe', 'hotel'], null)).toBe('food')
  })

  it('transport 桶每桶至少 5 個代表性 type', () => {
    for (const type of ['train_station', 'bus_stop', 'airport', 'ferry_terminal', 'taxi_stand']) {
      expect(categorize([type], null)).toBe('transport')
    }
  })

  it('sight 桶每桶至少 5 個代表性 type', () => {
    for (const type of ['museum', 'park', 'tourist_attraction', 'church', 'beach']) {
      expect(categorize([type], null)).toBe('sight')
    }
  })

  it('food 桶每桶至少 5 個代表性 type', () => {
    for (const type of ['restaurant', 'cafe', 'bakery', 'ramen_restaurant', 'japanese_izakaya_restaurant']) {
      expect(categorize([type], null)).toBe('food')
    }
  })

  it('lodging 桶每桶至少 5 個代表性 type', () => {
    for (const type of ['hotel', 'hostel', 'motel', 'guest_house', 'inn']) {
      expect(categorize([type], null)).toBe('lodging')
    }
  })

  it('shopping 桶每桶至少 5 個代表性 type', () => {
    for (const type of ['shopping_mall', 'supermarket', 'convenience_store', 'department_store', 'book_store']) {
      expect(categorize([type], null)).toBe('shopping')
    }
  })

  it('other 桶每桶至少 5 個代表性 type', () => {
    for (const type of ['point_of_interest', 'establishment', 'route', 'premise', 'political']) {
      expect(categorize([type], null)).toBe('other')
    }
  })
})

describe('六桶對照表無重複', () => {
  it('無任何 type 字串出現在兩個以上陣列', () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const [category, types] of Object.entries(CATEGORY_TYPES)) {
      for (const type of types) {
        if (seen.has(type)) {
          duplicates.push(type)
        } else {
          seen.set(type, category)
        }
      }
    }
    expect(duplicates).toEqual([])
  })

  it('六桶皆存在（含恆空的 other）', () => {
    expect(Object.keys(CATEGORY_TYPES).sort()).toEqual([...CATEGORY_ORDER].sort())
  })
})

describe('normalizeCategory', () => {
  it('已知六值原樣回傳', () => {
    for (const category of CATEGORY_ORDER) {
      expect(normalizeCategory(category)).toBe(category)
    }
  })

  it('未知字串回傳 other', () => {
    expect(normalizeCategory('not_a_category')).toBe('other')
  })

  it('null/undefined 回傳 other', () => {
    expect(normalizeCategory(null)).toBe('other')
    expect(normalizeCategory(undefined)).toBe('other')
  })
})

describe('CATEGORY_ORDER / CATEGORY_LABEL', () => {
  it('順序固定為 transport, sight, food, lodging, shopping, other', () => {
    expect(CATEGORY_ORDER).toEqual(['transport', 'sight', 'food', 'lodging', 'shopping', 'other'])
  })

  it('每個分類皆有繁中標籤', () => {
    expect(CATEGORY_LABEL).toEqual({
      transport: '交通站',
      sight: '景點',
      food: '餐飲',
      lodging: '住宿',
      shopping: '購物',
      other: '其他',
    })
  })
})
