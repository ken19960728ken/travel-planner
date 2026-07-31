/** 排程計算用的停留點視圖（時間一律為 epoch ms UTC） */
export type StopSchedule = {
  id: string
  startsAt: number
  endsAt: number
  locked: boolean
}

/** 排程計算用的交通段視圖 */
export type LegDuration = {
  fromStopId: string
  toStopId: string
  durationMinutes: number
}

export type ScheduleWarning =
  | /** stopIds 依時間順序排列：[較早的停留點, 較晚的停留點] */
    { type: 'overlap'; stopIds: [string, string] }
  | {
      type: 'transit_too_tight'
      fromStopId: string
      toStopId: string
      gapMinutes: number
      requiredMinutes: number
    }
