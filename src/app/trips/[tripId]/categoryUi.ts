import type { StopCategory } from '@/lib/domain/placeCategory'
import { CATEGORY_LABEL, CATEGORY_ORDER } from '@/lib/domain/placeCategory'

/** 六桶分類的視覺對照表（Pin 底色 / 色塊 class / emoji）——單一來源，供地圖標記、時間軸色塊、
 *  未來的分類圖例（legend）共用。分類值定義與中文標籤在 placeCategory.ts，本檔不重寫，只 re-export。
 *
 *  本表刻意迴避的既有語意色（逐一比對 TripView.tsx / Timeline.tsx，2026-08-03）：
 *    #2563eb / bg-blue-600  已選取（地圖選取態 + 時間軸選取態，兩處共用同一 hex）
 *    #ef4444  red-500       當日停留點（地圖）
 *    #d1d5db  gray-300      他日停留點（地圖）
 *    #9ca3af  gray-400      草稿針／搜尋預覽針（地圖，兩處共用同一 hex）
 *    #f59e0b  amber-500     選中的備選（Plan 6 新上線，地圖上與一般停留點同框顯示）
 *    bg-orange-500          播放頭圓點／拖曳位移把手（地圖）
 *    bg-red-600             時間衝突色塊（時間軸）
 *    red-100 / red-700      趕不上連接條（時間軸）
 *
 *  例外一（刻意重疊，非漏比對）：bg-emerald-600 在 Timeline.tsx 目前是「一般色塊」的預設 fallback
 *  （非選取、非衝突時的色塊底色）。本表把 emerald-600 重新賦義為「景點」——因為 Timeline 那個
 *  fallback 本身就是未分類前的佔位色，Plan 7 後續任務接上分類後，這格會被换成依分類上色，屆時
 *  emerald-600 只會在「這格恰好是景點」時出現，語意不衝突，特此記錄以免後人誤判為撞色遺漏。
 *
 *  例外二（刻意偏離建議表，非抄錯）：食物桶原建議 amber-700 `#b45309`。實測 amber-700 與已佔用的
 *  amber-500 `#f59e0b`（選中的備選）色相僅相差約 21°（OKLCH hue 48.998° vs 70.08°），對比度只有
 *  2.34:1，兩者在地圖小尺寸 Pin 上（尤其戶外強光下用手機看）非常容易被誤認成同一顆針。備選釘與
 *  一般停留點釘會同框出現，一旦某停留點恰好是餐飲類，「這是我選的備選」跟「這只是間餐廳」會混淆，
 *  這是誤導性 UI，不能接受。改用 stone-700 `#44403b`：色相雖仍落在暖色系（約 33°），但飽和度只有
 *  7%（amber-500 是 92%），視覺上讀作低調的深棕灰，而非鮮豔的橘 / 黃，與 amber-500 的對比度提升到
 *  4.79:1，與 orange-500（播放頭）對比度 3.67:1，足以區分（比對方法：sRGB 轉線性後算 WCAG 相對亮
 *  度比值；hue/saturation 用標準 HSL 換算，皆以 Tailwind v4 官方 oklch token 換算回 sRGB 驗證）。 */

/** 下游查表前一律先過 normalizeCategory() 正規化，不要直接用 `MAP[c] ?? MAP.other` 這種寫法查表。
 *  三個 Record（CATEGORY_PIN_HEX / CATEGORY_BLOCK_CLASS / CATEGORY_ICON）底層都是一般 object，
 *  `'__proto__'` / `'toString'` / `'constructor'` 這類 key 會命中原型鏈上的既有屬性（函式），
 *  不是 undefined，`??` 不會觸發 fallback，會把函式當成顏色/class/emoji 用，行為未定義。
 *  normalizeCategory() 已把輸入收斂成 StopCategory 六值之一（非六值一律收口為 'other'），
 *  查表後保證命中，不需要也不應該再疊一層 `?? MAP.other`。 */
export const CATEGORY_PIN_HEX: Record<StopCategory, string> = {
  transport: '#0891b2',
  sight: '#059669',
  food: '#44403b',
  lodging: '#7c3aed',
  shopping: '#db2777',
  other: '#6b7280',
}

/** 完整字面 class，供 Tailwind v4 掃描（v4 只認原始碼中的字面字串，`bg-${x}` 樣板字串一律失效，
 *  嚴禁在此表以外的地方用字串拼接重建這些 class）。 */
export const CATEGORY_BLOCK_CLASS: Record<StopCategory, string> = {
  transport: 'bg-cyan-600',
  sight: 'bg-emerald-600',
  food: 'bg-stone-700',
  lodging: 'bg-violet-600',
  shopping: 'bg-pink-600',
  other: 'bg-gray-500',
}

/** 逐字元核對過皆為 U+FE0F 變體選擇子之外的基底碼位，跨平台（尤其部分 Android / 舊字型）
 *  不會被降級成黑白字元（驗證方式：node -e 逐字印出 codePointAt）。 */
export const CATEGORY_ICON: Record<StopCategory, string> = {
  transport: '🚉',
  sight: '🗼',
  food: '🍜',
  lodging: '🏨',
  shopping: '🛒',
  other: '📍',
}

export { CATEGORY_LABEL, CATEGORY_ORDER }
