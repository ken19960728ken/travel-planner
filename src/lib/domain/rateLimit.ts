export type RateWindow = { timestamps: number[] }

/** 滑動視窗限流：回傳新 window（不改動輸入）。呼叫端自行保存 per-user 狀態。 */
export function takeToken(
  win: RateWindow,
  nowMs: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; window: RateWindow } {
  const kept = win.timestamps.filter(t => nowMs - t < windowMs)
  if (kept.length >= limit) return { allowed: false, window: { timestamps: kept } }
  return { allowed: true, window: { timestamps: [...kept, nowMs] } }
}
