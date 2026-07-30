export type CostItem = { estimatedCost: number | null }

export function totalEstimatedCost(items: CostItem[]): number {
  return items.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0)
}

export function perPersonCost(total: number, memberCount: number): number {
  if (memberCount < 1) return total
  return total / memberCount
}
