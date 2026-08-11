import { CATEGORY_ORDER, normalizeCategory, type StopCategory } from './placeCategory'
import { resolveStopParticipants } from './participants'

/** 花費項目的最小結構：僅需 estimatedCost，供 stops/legs 共用聚合。 */
export type CostItem = { estimatedCost: number | null }

/** 加總所有項目的預估花費，null 視為 0；不四捨五入（顯示層再格式化）。 */
export function totalEstimatedCost(items: CostItem[]): number {
  return items.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0)
}

/** 平均每人預估花費；memberCount < 1 時回傳總額，防禦性避免除以 0 或負值。
 *  @deprecated 2026-08-11 起由 costByParticipant 取代——全員均分不考慮分頭行動，
 *  沒去的人也被算進去，分帳會錯。保留是因為刪除與本次改動無關；目前沒有任何 UI 消費端。 */
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

export type ParticipantCostItem = { estimatedCost: number | null; participantIds: unknown }

/** 每筆花費只分攤給該項目的參與人（設計文件 2026-08-11-participants §6）。
 *
 *  【整數分攤，不用浮點除法】這是要拿去分帳的數字，1000 ÷ 3 再加回來不等於 1000。
 *  base = floor(金額 ÷ 人數)，餘數按 participant id **字典序**分給前幾人各 +1——排序讓分配
 *  決定性（同一份資料每次算出同樣的帳，不隨 participantIds 的儲存順序漂移）。
 *  不變量（cost.test.ts 以 50 筆組合鎖住）：sum(每人應付) === totalEstimatedCost(全部)。
 *
 *  金額先 Math.round：JPY/TWD 無小數，這是刻意的簡化（設計文件 §10 殘留風險）。
 *  <= 0 一律略過——負數走 Math.floor 會得到反直覺的分配，而 UI 本就不允許負花費。 */
export function costByParticipant(
  items: ReadonlyArray<ParticipantCostItem>,
  roster: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(roster.map(p => [p, 0]))
  if (roster.length === 0) return out
  for (const item of items) {
    const amount = Math.round(item.estimatedCost ?? 0)
    if (amount <= 0) continue
    const who = [...resolveStopParticipants(item.participantIds, roster)].sort()
    const base = Math.floor(amount / who.length)
    let remainder = amount - base * who.length
    for (const p of who) {
      out[p] += base + (remainder > 0 ? 1 : 0)
      if (remainder > 0) remainder -= 1
    }
  }
  return out
}
