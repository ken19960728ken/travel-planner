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
          // 失敗訊息帶上「哪兩桶撞了」，否則只知道字串重複、還要自己去翻六個陣列
          duplicates.push(`${type}: ${seen.get(type)} vs ${category}`)
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

  // 審查 I-1：categorize 的「命中恆非 other」前提只靠 OTHER_TYPES 為空維持。
  // 程式碼已加 `!== 'other'` 防禦，這條測試把不變量本身也鎖住，兩道防線。
  it('other 桶恆為空（categorize 的短路前提）', () => {
    expect(CATEGORY_TYPES.other).toEqual([])
  })

  // 審查 M-4：343 筆對照表原本只有 30 個字串（8.7%）被測試覆蓋，刪行/貼錯/合併衝突誤解都不會被發現。
  // 數字對應 2026-08-02 官方文件 + 本專案的具名例外；Google 新增型別時本測試會紅，這是刻意的提醒機制。
  it('各桶數量符合官方 section（Google 改文件時會紅，屬預期）', () => {
    expect(CATEGORY_TYPES.transport).toHaveLength(24) // Transportation 23 + rest_stop
    expect(CATEGORY_TYPES.sight).toHaveLength(97) // 原 92 + 溫泉/三溫暖/spa/massage_spa/觀光案內所
    expect(CATEGORY_TYPES.food).toHaveLength(167)
    expect(CATEGORY_TYPES.lodging).toHaveLength(18)
    expect(CATEGORY_TYPES.shopping).toHaveLength(43)
  })
})

describe('具名例外與反向邊界', () => {
  it('自其他 section 移入的具名例外', () => {
    for (const type of ['bridge', 'ski_resort', 'stadium', 'arena']) {
      expect(categorize([type], null)).toBe('sight')
    }
  })

  // 審查 M-5（主控拍板）：日本旅遊語境下溫泉/銭湯/三溫暖是「去玩的目的地」而非附屬設施。
  it('日本行程實務例外：溫泉、銭湯、三溫暖、觀光案內所歸景點', () => {
    for (const type of ['public_bath', 'sauna', 'spa', 'massage_spa', 'tourist_information_center']) {
      expect(categorize([type], type)).toBe('sight')
    }
  })

  it('道の駅（rest_stop）歸交通，不被 types 陣列裡的 store 撿走', () => {
    expect(categorize(['rest_stop', 'store', 'food'], 'rest_stop')).toBe('transport')
    expect(categorize(['rest_stop', 'store', 'food'], null)).toBe('transport')
  })

  // 審查 M-2：D1 明文「Sports section 僅 ski_resort/stadium/arena 三型移入 sight，其餘落 other」。
  // 沒有這條反向測試的話，未來把整個 Sports section（21 型）併進 sight 也不會有人發現。
  it('Sports section 其餘型別落 other（守住「僅此三型」的邊界）', () => {
    for (const type of ['gym', 'golf_course', 'swimming_pool', 'athletic_field']) {
      expect(categorize([type], null)).toBe('other')
    }
  })

  // 審查 M-3：Table B 五項原本只測了 place_of_worship 與 food
  it('Table B 其餘三項歸 sight', () => {
    for (const type of ['natural_feature', 'landmark', 'town_square']) {
      expect(categorize([type], null)).toBe('sight')
    }
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
