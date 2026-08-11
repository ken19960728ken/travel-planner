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

/** 側欄編輯器改完時間後，「後續行程要順延多少」的量（毫秒；0 代表不需要問）。
 *
 *  **取結束時間的變化量，不是開始時間的**——這是這個功能對不對的關鍵：
 *
 *    操作                    Δ開始   Δ結束   後續該順延
 *    晚半小時出發（整段後移）  +30    +30     +30  ✓
 *    想多待一小時（只改結束）    0    +60     +60  ✓
 *    提早結束                   0    −30     −30  ✓
 *    提早到、但同時離開        −30      0       0  ✓（後面不用動）
 *
 *  取開始時間的話，第二與第四種都會算錯。直覺上「我改了開始時間所以後面要跟著移」是錯的——
 *  真正決定「下一個行程最早能從幾點開始」的是這一個**幾點結束**。
 *
 *  時間軸拖曳是純平移（Δ開始 === Δ結束），兩種取法一致，所以那條路徑一直沒暴露這個區別。 */
export function followingShiftMs(oldEndsAtMs: number, newEndsAtMs: number): number {
  return newEndsAtMs - oldEndsAtMs
}

/** 「一起順延」會影響幾筆，以及其中幾筆會被移出行程的日期範圍。
 *
 *  【為何在 domain 層】這份判準必須與 shift_following_stops 的 WHERE **逐條一致**——
 *  使用者是看著詢問框上那個數字決定要不要按的，對不起來就是在騙人。埋在 client component
 *  裡沒辦法用表格式測試逐條鎖住，而這正是最容易隨改動漂移的一段（cascadeShift 當年抽到
 *  domain 層是同一個理由）。RPC 端另有 p_expected_count 守衛作為第二道防線。
 *
 *  【anchorWho 由呼叫端傳入，不從 stops 裡查】審查 M-1：同一次儲存可能**也改了錨點的參與人
 *  指派**，此時 stops（props）裡還是舊指派，而 RPC 讀到的是已寫入的新指派。實測「畫面說 1、
 *  實際動 2」，另一條分軌的行程被推遲。所以要傳表單當下的值。 */
export type FollowingStop = {
  id: string
  startsAt: number
  endsAt: number
  locked: boolean
  /** 已解讀過的參與人（roster 的子集）；名冊為空時傳空陣列 */
  participants: readonly string[]
}

export function countFollowingStops(
  stops: readonly FollowingStop[],
  opts: {
    anchorId: string
    /** 錨點編輯**前**的開始時間（切點） */
    afterMs: number
    /** 錨點當下的參與人（表單值，不是 props） */
    anchorWho: readonly string[]
    /** 名冊是否為空——為空時不做參與人過濾 */
    rosterEmpty: boolean
    /** 順延量；用來判斷會不會被移出行程範圍 */
    deltaMs: number
    /** 行程可顯示的時間範圍（含頭尾）。超出這個範圍的停留點在 UI 上沒有任何分頁能顯示 */
    range: { startMs: number; endMs: number }
  },
): { total: number; outOfRange: number } {
  let total = 0
  let outOfRange = 0
  for (const s of stops) {
    if (s.id === opts.anchorId) continue
    if (s.locked) continue
    if (s.startsAt <= opts.afterMs) continue
    if (!opts.rosterEmpty && !s.participants.some(id => opts.anchorWho.includes(id))) continue
    total += 1
    const movedStart = s.startsAt + opts.deltaMs
    if (movedStart < opts.range.startMs || movedStart > opts.range.endMs) outOfRange += 1
  }
  return { total, outOfRange }
}
