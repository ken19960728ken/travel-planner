import type { StopSchedule } from './types'

/**
 * 時間連鎖順延：changedStopId 之後（按開始時間排序）的未鎖定停留點整體平移 deltaMs。
 * 回傳新陣列（按 startsAt 排序），不改動輸入。
 * 同 startsAt 的停留點依輸入順序決定先後（穩定排序）。
 *
 * 注意：cascadeShift 目前無生產呼叫端——連鎖順延的權威實作是 DB 的 cascade_shift_stops RPC；
 * 本函式保留作為語義文件用。M-1 的 pendingShift 拖曳預覽已實作於 TripView.tsx（狀態）與
 * Timeline.tsx（色塊 offset），判斷邏輯見下方 pendingShiftOffsetMs / pendingShiftLanded——
 * 語義對齊本函式與 cascade_shift_stops RPC，但直接針對「單一停留點該不該加偏移」回答布林/數值，
 * 不像 cascadeShift 回傳整個平移後的陣列。
 */
export function cascadeShift(
  stops: StopSchedule[],
  changedStopId: string,
  deltaMs: number,
): StopSchedule[] {
  const sorted = [...stops].sort((a, b) => a.startsAt - b.startsAt)
  const idx = sorted.findIndex(s => s.id === changedStopId)
  if (idx === -1 || deltaMs === 0) return sorted
  return sorted.map((s, i) => {
    if (i <= idx || s.locked) return s
    return { ...s, startsAt: s.startsAt + deltaMs, endsAt: s.endsAt + deltaMs }
  })
}

/** M-1 拖曳回彈修復：cascade_shift_stops RPC 送出成功到 router.refresh() 落地前的過渡期間，
 *  用來預覽哪些停留點該加上 deltaMs 的偏移。 */
export type PendingShift = {
  changedStopId: string
  deltaMs: number
  /** RPC 呼叫當下（位移發生前）被拖點的 starts_at，語義對齊 RPC 的 v_changed_start */
  baselineStartMs: number
}

/** 某停留點在 pendingShift 過渡期間該不該加上 deltaMs 偏移——語義對齊 cascade_shift_stops RPC：
 *  被拖點本身、以及「未鎖定且 baseline 上（即位移發生前）晚於被拖點」的停留點都會被 RPC 一併平移。
 *  回傳 0 代表不偏移，否則回傳 pending.deltaMs。 */
export function pendingShiftOffsetMs(
  stop: Pick<StopSchedule, 'id' | 'startsAt' | 'locked'>,
  pending: PendingShift | null,
): number {
  if (!pending) return 0
  if (stop.id === pending.changedStopId) return pending.deltaMs
  if (!stop.locked && stop.startsAt > pending.baselineStartMs) return pending.deltaMs
  return 0
}

/** pendingShift 是否該被清除。**「已落地」與「不可能再落地」都要清**（2026-08-04 審查 Major）：
 *  只認落地會讓兩種真實可達的情境永久卡住偏移預覽，此時色塊位置與自己的 tooltip 互相矛盾，
 *  且跨日切換也不會消失，除了重新整理沒有恢復途徑——
 *
 *  1. **被拖點在 RPC 視窗內被協作者刪除**：找不到該點，永遠等不到落地
 *  2. **client baseline ≠ server baseline**：RPC（cascade_shift_v3）在 advisory lock 內從 DB 讀
 *     v_changed_start，呼叫端用的是 client 端 stops prop 的值。協作者在視窗內動過同一個點，
 *     落地值就不會等於 client baseline + delta。本產品主打多人共編，這個視窗真實存在。
 *
 *  情境 2 無法從「值」上區分於「還沒落地」，故呼叫端另備逾時保險；本函式負責 1 與正常落地。
 *
 *  精確 `===` 比對是刻意的，成立條件是三處性質的合成：Timeline 把 delta 吸附成 SNAP_MS 的倍數 →
 *  呼叫端 Math.round(deltaMs / 1000) 為 no-op → RPC 加的是整數秒。任一處改動（如吸附粒度改成
 *  非整秒）此處需改為容差比對。 */
export function pendingShiftResolved(
  pending: PendingShift,
  stops: Pick<StopSchedule, 'id' | 'startsAt'>[],
): boolean {
  const stop = stops.find(s => s.id === pending.changedStopId)
  if (stop === undefined) return true // 被拖點已不存在：不可能再落地，清掉
  return stop.startsAt === pending.baselineStartMs + pending.deltaMs
}
