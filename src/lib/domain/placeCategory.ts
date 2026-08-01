/** 我方六值地點分類——單一來源，供搜尋預填、備選庫分組、地圖/時間軸上色、Excel 分類欄共用。
 *  對照表以 Google Places API (New) 官方文件逐 section 核對（2026-08-02 WebFetch 讀取
 *  https://developers.google.com/maps/documentation/places/web-service/place-types），不得憑記憶補字串。
 *  歸類規則（Plan D1）：
 *    transport ← Table A「Transportation」全 section，減具名例外 bridge
 *    sight     ← Table A「Culture」+「Entertainment and Recreation」+「Natural Features」+「Places of Worship」
 *                全 section，加具名例外 bridge／ski_resort／stadium／arena（後三者屬 Table A「Sports」，
 *                僅此三型併入 sight，Sports section 其餘型別無歸屬、落 other）
 *                加 Table B：place_of_worship／natural_feature／landmark／town_square
 *    food      ← Table A「Food and Drink」全 section + Table B：food
 *    lodging   ← Table A「Lodging」全 section
 *    shopping  ← Table A「Shopping」全 section
 *    other     ← 其餘全部，且為預設值（未收錄的 Table A section、以及所有其餘 Table B 型別皆落此桶）
 *  DB 只存本檔的六值 slug，不存 Google raw types/primaryType（ToS 紅線，見 Plan 文件）。 */

export type StopCategory = 'transport' | 'sight' | 'food' | 'lodging' | 'shopping' | 'other'

export const CATEGORY_ORDER: readonly StopCategory[] = ['transport', 'sight', 'food', 'lodging', 'shopping', 'other']

export const CATEGORY_LABEL: Record<StopCategory, string> = {
  transport: '交通站',
  sight: '景點',
  food: '餐飲',
  lodging: '住宿',
  shopping: '購物',
  other: '其他',
}

/** Table A「Transportation」全 section，減 bridge（併入 sight）。 */
const TRANSPORT_TYPES: readonly string[] = [
  'airport', 'airstrip', 'bike_sharing_station', 'bus_station', 'bus_stop',
  'ferry_service', 'ferry_terminal', 'heliport', 'international_airport', 'light_rail_station',
  'park_and_ride', 'subway_station', 'taxi_service', 'taxi_stand', 'toll_station',
  'train_station', 'train_ticket_office', 'tram_stop', 'transit_depot', 'transit_station',
  'transit_stop', 'transportation_service', 'truck_stop',
]

/** Table A「Culture」+「Entertainment and Recreation」+「Natural Features」+「Places of Worship」
 *  全 section，加具名例外 bridge／ski_resort／stadium／arena，加 Table B：
 *  place_of_worship／natural_feature／landmark／town_square。 */
const SIGHT_TYPES: readonly string[] = [
  'art_gallery', 'art_museum', 'art_studio', 'auditorium', 'castle',
  'cultural_landmark', 'fountain', 'historical_place', 'history_museum', 'monument',
  'museum', 'performing_arts_theater', 'sculpture', 'adventure_sports_center', 'amphitheatre',
  'amusement_center', 'amusement_park', 'aquarium', 'banquet_hall', 'barbecue_area',
  'botanical_garden', 'bowling_alley', 'casino', 'childrens_camp', 'city_park',
  'comedy_club', 'community_center', 'concert_hall', 'convention_center', 'cultural_center',
  'cycling_park', 'dance_hall', 'dog_park', 'event_venue', 'ferris_wheel',
  'garden', 'go_karting_venue', 'hiking_area', 'historical_landmark', 'indoor_playground',
  'internet_cafe', 'karaoke', 'live_music_venue', 'marina', 'miniature_golf_course',
  'movie_rental', 'movie_theater', 'national_park', 'night_club', 'observation_deck',
  'off_roading_area', 'opera_house', 'paintball_center', 'park', 'philharmonic_hall',
  'picnic_ground', 'planetarium', 'plaza', 'roller_coaster', 'skateboard_park',
  'state_park', 'tourist_attraction', 'video_arcade', 'vineyard', 'visitor_center',
  'water_park', 'wedding_venue', 'wildlife_park', 'wildlife_refuge', 'zoo',
  'beach', 'island', 'lake', 'mountain_peak', 'nature_preserve',
  'river', 'scenic_spot', 'woods', 'buddhist_temple', 'church',
  'hindu_temple', 'mosque', 'shinto_shrine', 'synagogue', 'bridge',
  'ski_resort', 'stadium', 'arena', 'place_of_worship', 'natural_feature',
  'landmark', 'town_square',
]

/** Table A「Food and Drink」全 section + Table B：food。 */
const FOOD_TYPES: readonly string[] = [
  'acai_shop', 'afghani_restaurant', 'african_restaurant', 'american_restaurant', 'argentinian_restaurant',
  'asian_fusion_restaurant', 'asian_restaurant', 'australian_restaurant', 'austrian_restaurant', 'bagel_shop',
  'bakery', 'bangladeshi_restaurant', 'bar', 'bar_and_grill', 'barbecue_restaurant',
  'basque_restaurant', 'bavarian_restaurant', 'beer_garden', 'belgian_restaurant', 'bistro',
  'brazilian_restaurant', 'breakfast_restaurant', 'brewery', 'brewpub', 'british_restaurant',
  'brunch_restaurant', 'buffet_restaurant', 'burmese_restaurant', 'burrito_restaurant', 'cafe',
  'cafeteria', 'cajun_restaurant', 'cake_shop', 'californian_restaurant', 'cambodian_restaurant',
  'candy_store', 'cantonese_restaurant', 'caribbean_restaurant', 'cat_cafe', 'chicken_restaurant',
  'chicken_wings_restaurant', 'chilean_restaurant', 'chinese_noodle_restaurant', 'chinese_restaurant', 'chocolate_factory',
  'chocolate_shop', 'cocktail_bar', 'coffee_roastery', 'coffee_shop', 'coffee_stand',
  'colombian_restaurant', 'confectionery', 'croatian_restaurant', 'cuban_restaurant', 'czech_restaurant',
  'danish_restaurant', 'deli', 'dessert_restaurant', 'dessert_shop', 'dim_sum_restaurant',
  'diner', 'dog_cafe', 'donut_shop', 'dumpling_restaurant', 'dutch_restaurant',
  'eastern_european_restaurant', 'ethiopian_restaurant', 'european_restaurant', 'falafel_restaurant', 'family_restaurant',
  'fast_food_restaurant', 'filipino_restaurant', 'fine_dining_restaurant', 'fish_and_chips_restaurant', 'fondue_restaurant',
  'food_court', 'french_restaurant', 'fusion_restaurant', 'gastropub', 'german_restaurant',
  'greek_restaurant', 'gyro_restaurant', 'halal_restaurant', 'hamburger_restaurant', 'hawaiian_restaurant',
  'hookah_bar', 'hot_dog_restaurant', 'hot_dog_stand', 'hot_pot_restaurant', 'hungarian_restaurant',
  'ice_cream_shop', 'indian_restaurant', 'indonesian_restaurant', 'irish_pub', 'irish_restaurant',
  'israeli_restaurant', 'italian_restaurant', 'japanese_curry_restaurant', 'japanese_izakaya_restaurant', 'japanese_restaurant',
  'juice_shop', 'kebab_shop', 'korean_barbecue_restaurant', 'korean_restaurant', 'latin_american_restaurant',
  'lebanese_restaurant', 'lounge_bar', 'malaysian_restaurant', 'meal_delivery', 'meal_takeaway',
  'mediterranean_restaurant', 'mexican_restaurant', 'middle_eastern_restaurant', 'mongolian_barbecue_restaurant', 'moroccan_restaurant',
  'noodle_shop', 'north_indian_restaurant', 'oyster_bar_restaurant', 'pakistani_restaurant', 'pastry_shop',
  'persian_restaurant', 'peruvian_restaurant', 'pizza_delivery', 'pizza_restaurant', 'polish_restaurant',
  'portuguese_restaurant', 'pub', 'ramen_restaurant', 'restaurant', 'romanian_restaurant',
  'russian_restaurant', 'salad_shop', 'sandwich_shop', 'scandinavian_restaurant', 'seafood_restaurant',
  'shawarma_restaurant', 'snack_bar', 'soul_food_restaurant', 'soup_restaurant', 'south_american_restaurant',
  'south_indian_restaurant', 'southwestern_us_restaurant', 'spanish_restaurant', 'sports_bar', 'sri_lankan_restaurant',
  'steak_house', 'sushi_restaurant', 'swiss_restaurant', 'taco_restaurant', 'taiwanese_restaurant',
  'tapas_restaurant', 'tea_house', 'tex_mex_restaurant', 'thai_restaurant', 'tibetan_restaurant',
  'tonkatsu_restaurant', 'turkish_restaurant', 'ukrainian_restaurant', 'vegan_restaurant', 'vegetarian_restaurant',
  'vietnamese_restaurant', 'western_restaurant', 'wine_bar', 'winery', 'yakiniku_restaurant',
  'yakitori_restaurant', 'food',
]

/** Table A「Lodging」全 section。 */
const LODGING_TYPES: readonly string[] = [
  'bed_and_breakfast', 'budget_japanese_inn', 'campground', 'camping_cabin', 'cottage',
  'extended_stay_hotel', 'farmstay', 'guest_house', 'hostel', 'hotel',
  'inn', 'japanese_inn', 'lodging', 'mobile_home_park', 'motel',
  'private_guest_room', 'resort_hotel', 'rv_park',
]

/** Table A「Shopping」全 section。 */
const SHOPPING_TYPES: readonly string[] = [
  'asian_grocery_store', 'auto_parts_store', 'bicycle_store', 'book_store', 'building_materials_store',
  'butcher_shop', 'cell_phone_store', 'clothing_store', 'convenience_store', 'cosmetics_store',
  'department_store', 'discount_store', 'discount_supermarket', 'electronics_store', 'farmers_market',
  'flea_market', 'food_store', 'furniture_store', 'garden_center', 'general_store',
  'gift_shop', 'grocery_store', 'hardware_store', 'health_food_store', 'home_goods_store',
  'home_improvement_store', 'hypermarket', 'jewelry_store', 'liquor_store', 'market',
  'pet_store', 'shoe_store', 'shopping_mall', 'sporting_goods_store', 'sportswear_store',
  'store', 'supermarket', 'tea_store', 'thrift_store', 'toy_store',
  'warehouse_store', 'wholesaler', 'womens_clothing_store',
]

/** other 無專屬白名單——未落入前五桶者一律視為 other；此陣列恆為空，僅為湊滿六桶結構。 */
const OTHER_TYPES: readonly string[] = []

/** 六桶原始資料，供 TYPE_CATEGORY 的唯一資料來源、亦供測試遍歷做重複偵測。 */
export const CATEGORY_TYPES: Readonly<Record<StopCategory, readonly string[]>> = {
  transport: TRANSPORT_TYPES,
  sight: SIGHT_TYPES,
  food: FOOD_TYPES,
  lodging: LODGING_TYPES,
  shopping: SHOPPING_TYPES,
  other: OTHER_TYPES,
}

/** 模組初始化時把六桶攤平成單一 Map，供 categorize() O(1) 查詢。 */
const TYPE_CATEGORY: ReadonlyMap<string, StopCategory> = new Map(
  (Object.entries(CATEGORY_TYPES) as Array<[StopCategory, readonly string[]]>).flatMap(([category, types]) =>
    types.map(type => [type, category] as const),
  ),
)

/** 推導順序寫死：primaryType 查表命中即回傳；否則依 types 陣列原順序逐項查表，
 *  第一個命中即回傳；全不命中 → other。TYPE_CATEGORY 內不含 other 鍵，故「命中」恆非 other。 */
export function categorize(types: readonly string[], primaryType: string | null | undefined): StopCategory {
  if (primaryType) {
    const primary = TYPE_CATEGORY.get(primaryType)
    if (primary) return primary
  }
  for (const type of types) {
    const category = TYPE_CATEGORY.get(type)
    if (category) return category
  }
  return 'other'
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set(CATEGORY_ORDER)

/** 校驗一個「已宣稱是分類值」的字串（例如來自 DB 或分享 RPC）；未知值一律收口為 other。 */
export function normalizeCategory(value: string | null | undefined): StopCategory {
  if (value && VALID_CATEGORIES.has(value)) return value as StopCategory
  return 'other'
}
