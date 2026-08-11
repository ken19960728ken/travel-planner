import { CATEGORY_ORDER, normalizeCategory, type StopCategory } from './placeCategory'
import { resolveStopParticipants } from './participants'

/** 花費項目的最小結構：僅需 estimatedCost，供 stops/legs 共用聚合。 */
export type CostItem = { estimatedCost: number | null }

/** 加總所有項目的預估花費，null 視為 0；不四捨五入（顯示層再格式化）。 */
export function totalEstimatedCost(items: CostItem[]): number {
  return items.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0)
}

/** 帶分類的花費項目（stops 專用；legs 沒有 category）。 */
export type CategoryCostItem = CostItem & { category: StopCategory }

/** 依分類聚合花費（Plan 7 D5）。**legs 獨立成第七桶，刻意不併進 transport**——
 *  「交通站」是在車站買便當、寄物的花費，「交通段」是車資，兩者混在一起會讓 transport 這桶語意不明。
 *  legs 也不再依 mode 細分：mode 本身已是分類，再拆會讓桶數膨脹而資訊量沒增加。
 *  不變量（cost.test.ts 以隨機組合鎖住）：sum(六桶) + legs === total === totalEstimatedCost(全部)。 */
export function costByCategory(
  stops: readonly CategoryCostItem[],
  legs: readonly CostItem[],
): { byCategory: Record<StopCategory, number>; legs: number; total: number } {
  const byCategory = Object.fromEntries(
    CATEGORY_ORDER.map(c => [c, 0]),
  ) as Record<StopCategory, number>
  for (const s of stops) byCategory[normalizeCategory(s.category)] += s.estimatedCost ?? 0
  const legsTotal = totalEstimatedCost([...legs])
  const bucketSum = CATEGORY_ORDER.reduce((sum, c) => sum + byCategory[c], 0)
  return { byCategory, legs: legsTotal, total: bucketSum + legsTotal }
}

export type ParticipantCostItem = { estimatedCost: number | null; participantIds: unknown }

/** 分攤用的最小單位倒數：全部金額都是整數時為 1（日圓／新台幣的實務情況），
 *  只要有任何一筆帶小數就切到 1/100。
 *
 *  為何要適應而不是一律用「分」：JPY 沒有小數，1000 ÷ 3 分成 333.34 / 333.33 / 333.33
 *  是付不出來的金額；一律用整數又會讓 numeric(12,2) 的小數輸入被丟掉（審查 M-4）。
 *  currency 欄位是自由的三碼字串（init.sql:42），沒有可靠的「這個幣別有幾位小數」來源，
 *  改由**實際資料**決定精度——使用者真的輸入了小數，就代表這趟行程的幣別有小數。 */
function splitScale(items: ReadonlyArray<ParticipantCostItem>): number {
  for (const item of items) {
    const v = item.estimatedCost ?? 0
    if (!Number.isInteger(v)) return 100
  }
  return 1
}

/** 分帳用的總額。**必須與 costByParticipant 用同一份基底**，否則兩個數字對不起來。
 *
 *  為何不直接用 totalEstimatedCost：後者是原始浮點加總，而分攤是在最小單位上做整數運算。
 *  審查 M-4 實測：三筆 0.4 的花費，totalEstimatedCost 得 1.2，而舊版分攤先 Math.round(0.4)=0
 *  再分，每人 0——畫面上「總計 1.2」配「甲 0 / 乙 0」。金額欄位是 numeric(12,2)、
 *  StopEditor 的輸入框是 step="0.01"，小數是這個系統明確支援的輸入，不是邊界情況。 */
export function totalForSplit(items: ReadonlyArray<ParticipantCostItem>): number {
  const scale = splitScale(items)
  let units = 0
  for (const item of items) units += Math.round((item.estimatedCost ?? 0) * scale)
  return units / scale
}

/** 每筆花費只分攤給該項目的參與人（設計文件 2026-08-11-participants §6）。
 *
 *  【在最小單位上做整數運算】這是要拿去分帳的數字，浮點除法加回來不等於原值。
 *  精度由 splitScale 依實際資料決定（全整數 → 1，有小數 → 1/100）。
 *  base = floor(單位 ÷ 人數)，餘數按 participant id **字典序**分給前幾人各 +1——排序讓分配
 *  決定性（同一份資料每次算出同樣的帳，不隨 participantIds 的儲存順序漂移）。
 *
 *  不變量（cost.test.ts 以隨機組合 + 小數案例鎖住）：
 *      sum(每人應付的最小單位) === totalForSplit 的最小單位
 *  ⚠️ 兩點要注意。一、是 totalForSplit **不是** totalEstimatedCost；舊版註解宣稱對後者成立，
 *  那是錯的（審查 M-4 實測：total 100.5 而每人加總 101）。二、相等**只在最小單位上嚴格成立**——
 *  scale 為 100 時把各人的值除回「元」再相加會有浮點誤差（0.4+0.4+0.4 = 1.2000000000000002），
 *  這是 IEEE 754 的性質，不是分攤演算法的缺陷。顯示層照著各人的值印即可；
 *  要驗證加總請在最小單位上比較。
 *
 *  <= 0 一律略過——負數走 Math.floor 會得到反直覺的分配，而 UI 本就不允許負花費。 */
export function costByParticipant(
  items: ReadonlyArray<ParticipantCostItem>,
  roster: readonly string[],
): Record<string, number> {
  const acc: Record<string, number> = Object.fromEntries(roster.map(p => [p, 0]))
  if (roster.length === 0) return acc
  const scale = splitScale(items)
  for (const item of items) {
    const units = Math.round((item.estimatedCost ?? 0) * scale)
    if (units <= 0) continue
    const who = [...resolveStopParticipants(item.participantIds, roster)].sort()
    const base = Math.floor(units / who.length)
    let remainder = units - base * who.length
    for (const p of who) {
      acc[p] += base + (remainder > 0 ? 1 : 0)
      if (remainder > 0) remainder -= 1
    }
  }
  return scale === 1 ? acc : Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v / scale]))
}
