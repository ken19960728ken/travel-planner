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

/** pendingShift 是否已落地：觀察最新 stops，被拖點的 starts_at 是否已追上 baseline + delta。
 *  落地後應清空 pendingShift，讓後續渲染回歸 props 真相。 */
export function pendingShiftLanded(
  pending: PendingShift,
  stops: Pick<StopSchedule, 'id' | 'startsAt'>[],
): boolean {
  const stop = stops.find(s => s.id === pending.changedStopId)
  return stop !== undefined && stop.startsAt === pending.baselineStartMs + pending.deltaMs
}
