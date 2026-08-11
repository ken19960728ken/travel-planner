/** Timeline 的分軌版面：把時間上重疊的停留點分配到不同的水平軌道（lane）。
 *
 *  【為什麼需要】Timeline 的色塊位置純由時間推導（left/width），單一軌道時兩個時間相同的
 *  停留點會**完全疊在同一個矩形上**——DOM 後者整個蓋住前者，下層那格看不到、點不到、拖不動。
 *  分頭行動正是「同一時段多個停留點」的常態情境，而它原本靠「衝突紅色」被間接標示出來；
 *  分軌之後紅色被正確拿掉了（不同人重疊不是衝突），取代它的可辨識性必須由這裡補上，
 *  否則這個功能在自己的主場景裡反而比改版前更沒有資訊（審查 M-8）。
 *
 *  【演算法】區間圖著色的貪婪版：按開始時間排序，每個停留點放進「最後一個結束時間 <= 它的
 *  開始時間」的最早那條 lane，都放不下才開新 lane。這對區間圖是最佳解（用到的 lane 數等於
 *  最大同時重疊數），而且是決定性的。
 *
 *  屬 domain 層，輸入型別自帶最小欄位（沿 snapshot.ts / exportRows.ts 慣例）。 */

export type LaneItem = { id: string; startsAt: number; endsAt: number }

export type LaneLayout = {
  /** stop id → lane 索引（0 起算） */
  laneOf: Map<string, number>
  /** 總共用到幾條 lane。無重疊時恆為 1，Timeline 據此決定軌道高度。 */
  laneCount: number
}

export function assignLanes(items: readonly LaneItem[]): LaneLayout {
  const laneOf = new Map<string, number>()
  if (items.length === 0) return { laneOf, laneCount: 1 }

  // 同刻以 id 決勝，讓結果不隨輸入順序漂移（同 adjacentPairs 的穩定排序理由）
  const sorted = [...items].sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))
  /** 每條 lane 目前的結束時間 */
  const laneEnds: number[] = []

  for (const item of sorted) {
    let placed = -1
    for (let i = 0; i < laneEnds.length; i++) {
      // <= 而非 <：前一段剛好結束就開始的行程不算重疊，可以共用同一條 lane
      if (laneEnds[i] <= item.startsAt) { placed = i; break }
    }
    if (placed === -1) {
      placed = laneEnds.length
      laneEnds.push(item.endsAt)
    } else {
      // 零長度或反向區間（endsAt <= startsAt，DB 有 check 但 UI 預覽可能短暫出現）
      // 仍要推進 lane 結束時間，否則後續全部擠進同一條而重疊
      laneEnds[placed] = Math.max(laneEnds[placed], item.endsAt)
    }
    laneOf.set(item.id, placed)
  }
  return { laneOf, laneCount: Math.max(1, laneEnds.length) }
}
