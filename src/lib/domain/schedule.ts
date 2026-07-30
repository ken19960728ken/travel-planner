import type { StopSchedule } from './types'

/**
 * 時間連鎖順延：changedStopId 之後（按開始時間排序）的未鎖定停留點整體平移 deltaMs。
 * 回傳新陣列（按 startsAt 排序），不改動輸入。
 * 同 startsAt 的停留點依輸入順序決定先後（穩定排序）。
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
