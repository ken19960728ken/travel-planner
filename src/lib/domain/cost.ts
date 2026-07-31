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
