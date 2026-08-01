import { CATEGORY_ORDER, normalizeCategory, type StopCategory } from './placeCategory'

/** 花費項目的最小結構：僅需 estimatedCost，供 stops/legs 共用聚合。 */
export type CostItem = { estimatedCost: number | null }

/** 加總所有項目的預估花費，null 視為 0；不四捨五入（顯示層再格式化）。 */
export function totalEstimatedCost(items: CostItem[]): number {
  return items.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0)
}

/** 平均每人預估花費；memberCount < 1 時回傳總額，防禦性避免除以 0 或負值。 */
export function perPersonCost(total: number, memberCount: number): number {
  if (memberCount < 1) return total
  return total / memberCount
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
