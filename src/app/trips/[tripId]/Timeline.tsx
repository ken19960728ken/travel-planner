'use client'

import { useRef, useState } from 'react'
import type { Stop } from './TripView'
import { formatLocalTime } from '@/lib/domain/tz'
import { filterDayStops } from '@/lib/domain/days'
import { pendingShiftOffsetMs, type PendingShift } from '@/lib/domain/schedule'
import type { DayView } from './dayView'
import { MODE_ICON, MODE_LABEL, legDurationText, legDurationShortText } from './legUi'
import { CATEGORY_BLOCK_CLASS, CATEGORY_ICON } from './categoryUi'
import { normalizeCategory } from '@/lib/domain/placeCategory'

const HOUR_MS = 60 * 60 * 1000
const SNAP_MS = 5 * 60 * 1000 // 拖曳吸附至 5 分鐘；位移小於此視為點擊

export type TimelineProps = {
  stops: Stop[]
  dayKeys: string[]
  activeDay: string
  onDayChange: (day: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  playheadMs: number | null
  onPlayheadChange: (ms: number | null) => void
  onMove?: (stopId: string, deltaMs: number) => Promise<void> // 拖曳提交：await 完成後才清空預覽偏移，避免回彈
  busy?: boolean // 上層寫入中：擋新拖曳、軌道降低透明度提示
  /** M-1：RPC 成功到 refresh 落地間的過渡偏移預覽（TripView 的 moveStop 設定、觀察 stops 落地後清空） */
  pendingShift?: PendingShift | null
  playing: boolean
  onTogglePlay: () => void
  dayView: DayView
  selectedLegId: string | null
  onSelectLeg: (id: string | null) => void
}

/** 當日視窗：停留點最早前 1h ~ 最晚後 1h；空日 fallback 當地 08:00–20:00 概念上以 UTC 對齊隱藏 */
export function dayWindow(dayStops: Stop[]): { start: number; end: number } | null {
  if (dayStops.length === 0) return null
  const starts = dayStops.map(s => new Date(s.starts_at).getTime())
  const ends = dayStops.map(s => new Date(s.ends_at).getTime())
  return { start: Math.min(...starts) - HOUR_MS, end: Math.max(...ends) + HOUR_MS }
}

export default function Timeline({
  stops, dayKeys, activeDay, onDayChange, selectedId, onSelect, playheadMs, onPlayheadChange, onMove, busy,
  playing, onTogglePlay, dayView, selectedLegId, onSelectLeg, pendingShift,
}: TimelineProps) {
  const dayStops = filterDayStops(stops, activeDay)
  const win = dayWindow(dayStops)
  // M-6 右標籤用：win.end = max(endsAt) + 1h，故時區要取「結束最晚」那筆，不是排序後的最後一筆
  const endStop =
    dayStops.length > 0
      ? dayStops.reduce((a, b) => (new Date(b.ends_at).getTime() > new Date(a.ends_at).getTime() ? b : a))
      : null
  const span = win ? win.end - win.start : 1
  const pct = (t: number) => ((t - (win?.start ?? 0)) / span) * 100
  // playheadMs 可能因資料變動（拖曳/刪除後 win 縮小）落在視窗外；畫線/滑桿/文字一律用夾回視窗內的值，避免互相矛盾
  const ph = win && playheadMs !== null ? Math.min(Math.max(playheadMs, win.start), win.end) : null

  // 拖曳平移色塊：位移 < SNAP_MS 視為點擊（→ onSelect），否則放開時提交平移（→ onMove）
  const [drag, setDrag] = useState<{ id: string; startX: number; deltaMs: number; pointerId: number } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  function beginDrag(e: React.PointerEvent, stopId: string) {
    // Task 5：!onMove 早退（viewer 沒有 onMove）——原本只在 endDrag 檢查，viewer 會看到拖曳預覽卻提交不了，
    // 半互動狀態比不能拖更困惑，改在拖曳一開始就擋下
    if (!win || busy || drag || !onMove) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id: stopId, startX: e.clientX, deltaMs: 0, pointerId: e.pointerId })
  }
  function moveDrag(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId || !trackRef.current || !win) return
    const pxPerMs = trackRef.current.clientWidth / span
    const rawDelta = (e.clientX - drag.startX) / pxPerMs
    setDrag({ ...drag, deltaMs: Math.round(rawDelta / SNAP_MS) * SNAP_MS })
  }
  async function endDrag(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return
    const { id, deltaMs } = drag
    if (Math.abs(deltaMs) >= SNAP_MS && onMove) {
      // 等 RPC 完成才清 drag：onMove（TripView.moveStop）在發出 RPC 前已設定 pendingShift，drag 清空的
      // 瞬間 pendingShift 已經頂上同樣的偏移量，色塊位置無縫接手，直到 refresh 落地才回歸 props 真相（M-1）
      // finally 保證任何例外都不會讓 drag 卡死（否則 beginDrag 會永久擋住後續拖曳）
      try {
        await onMove(id, deltaMs)
      } finally {
        setDrag(null)
      }
    } else {
      setDrag(null)
      onSelect(id) // 位移過小視為點擊，交由統一的 pointer 流程處理選取
    }
  }
  function cancelDrag(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return
    setDrag(null) // 拖曳被中斷（如瀏覽器手勢搶走指標）：只捨棄預覽，絕不提交 onMove
  }

  // dayLegs/conflictIds/tightPairs 的計算單一來源：dayView 由 TripView 呼叫 buildDayView 產出
  // （審查 M-4：連接條渲染與側欄警示同讀一份，不各自組裝）
  const { dayLegs, conflictIds, tightPairs } = dayView

  return (
    <div className="border-t bg-background p-2">
      <div className="mb-2 flex items-center gap-1">
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {dayKeys.map((key, i) => (
            <button
              key={key}
              type="button"
              onClick={() => onDayChange(key)}
              className={`shrink-0 rounded px-2 py-1 text-xs ${
                activeDay === key ? 'bg-foreground text-background' : 'border'
              }`}
            >
              D{i + 1} {key.slice(5)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={!win && !playing}
          className="shrink-0 rounded border px-2 py-1 text-xs disabled:opacity-40"
        >
          {playing ? '⏸ 暫停' : '▶ 播放'}
        </button>
      </div>

      {win ? (
        <>
          {drag && (
            <div className="text-xs text-orange-500">
              {drag.deltaMs > 0 ? '+' : ''}
              {Math.round(drag.deltaMs / 60000)} 分鐘（放開套用，之後行程自動順延）
            </div>
          )}
          <div ref={trackRef} className={`relative h-12 rounded border ${busy ? 'opacity-60' : ''}`}>
            {dayStops.map(stop => {
              const s = new Date(stop.starts_at).getTime()
              const e = new Date(stop.ends_at).getTime()
              // 拖曳中的色塊用偏移後的時間預覽位置，放開才真正提交；放開後（drag 已清空）
              // 交給 pendingShift 接手預覽，直到 refresh 落地（M-1，語義對齊 cascade RPC）
              const offset = drag?.id === stop.id
                ? drag.deltaMs
                : pendingShiftOffsetMs({ id: stop.id, startsAt: s, locked: stop.locked }, pendingShift ?? null)
              return (
                <button
                  key={stop.id}
                  type="button"
                  data-stop-block={stop.id}
                  tabIndex={-1} // 鍵盤選取走側欄清單，時間軸色塊只認 pointer
                  onPointerDown={ev => beginDrag(ev, stop.id)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={cancelDrag}
                  onLostPointerCapture={cancelDrag} // 指標擷取被瀏覽器/系統手勢強制搶走時（未必觸發 pointercancel），一併釋放拖曳，避免卡死
                  // viewer（!onMove）：beginDrag 一開始就早退，drag 恆為 null，endDrag 內的 onSelect 永遠到不了——
                  // 點擊選取會整個死掉（唯讀不是不能看）。補一條不經過拖曳流程的 onClick 出口；
                  // editor 維持原本「按下→放開由 endDrag 判斷位移」流程，onClick 讓給 undefined 不重複觸發
                  onClick={onMove ? undefined : () => onSelect(stop.id)}
                  title={`${stop.name} ${formatLocalTime(s, stop.timezone)}–${formatLocalTime(e, stop.timezone)}`}
                  // 底色優先序寫死：衝突 > 分類。選取改用 ring 疊加而非換底色——否則選取會蓋掉分類色，
                  // 使用者一點下去就看不出這格是什麼類型了。
                  // 註：bg-emerald-600 原本是「一般色塊」的預設 fallback，Plan 7 起重新賦義為「景點」；
                  // 分類接上後這個顏色只會在該格真的是景點時出現，語意不衝突。
                  className={`absolute top-1 bottom-1 touch-none truncate rounded px-1 text-left text-xs text-white ${
                    conflictIds.has(stop.id) ? 'bg-red-600' : CATEGORY_BLOCK_CLASS[normalizeCategory(stop.category)]
                  } ${selectedId === stop.id ? 'ring-2 ring-blue-500' : ''}`}
                  style={{ left: `${pct(s + offset)}%`, width: `${Math.max(pct(e + offset) - pct(s + offset), 1.5)}%` }}
                >
                  {stop.locked && '🔒'}
                  {CATEGORY_ICON[normalizeCategory(stop.category)]}
                  {stop.name}
                </button>
              )
            })}
            {dayLegs.map(({ from, to, leg }) => {
              const gs = new Date(from.ends_at).getTime()
              const ge = Math.min(new Date(to.starts_at).getTime(), win.end) // 跨夜段夾到視窗尾（M-4）
              if (ge <= gs) return null
              const tight = tightPairs.has(`${from.id}→${to.id}`)
              const leftPct = pct(gs)
              const rawWidthPct = pct(ge) - leftPct
              // I-1：視覺最小寬度撐寬到 2%，但右緣不可超過軌道（100%），空檔越接近視窗尾越明顯
              const widthPct = Math.min(Math.max(rawWidthPct, 2), 100 - leftPct)
              // I-1：被撐寬出來的死區不該搶走點擊——選取一律走側欄交通列，連接條在此僅供顯示
              const isDeadZone = rawWidthPct < 2
              return (
                <button
                  key={leg.id}
                  type="button"
                  data-leg-connector={leg.id}
                  tabIndex={-1}
                  onClick={() => onSelectLeg(selectedLegId === leg.id ? null : leg.id)}
                  title={`${MODE_LABEL[leg.mode]} ${legDurationText(leg)}`}
                  className={`absolute top-1/2 z-10 -translate-y-1/2 overflow-hidden text-ellipsis whitespace-nowrap rounded text-center text-[10px] leading-tight ${
                    isDeadZone ? 'pointer-events-none' : ''
                  } ${tight ? 'bg-red-100 text-red-700' : 'bg-background/80 text-gray-600'} ${
                    selectedLegId === leg.id ? 'ring-1 ring-blue-500' : ''
                  }`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                >
                  {MODE_ICON[leg.mode]}
                  {leg.stale && '⚠️'}
                  {legDurationShortText(leg)}
                </button>
              )
            })}
            {ph !== null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-orange-500"
                style={{ left: `${pct(ph)}%` }}
              />
            )}
          </div>
          <input
            className="mt-1 w-full"
            type="range"
            min={win.start}
            max={win.end}
            step={5 * 60 * 1000}
            value={ph ?? win.start}
            onChange={e => onPlayheadChange(Number(e.target.value))}
            aria-label="時間軸播放頭"
          />
          <div className="flex justify-between text-xs text-gray-400">
            {/* M-6：左標籤用起點時區、右標籤改用終點時區（跨時區日程的當日視窗起訖各自對齊自己的地點），
                播放頭標籤維持起點時區並以 title 註記，避免和右標籤的時區不一致造成誤解 */}
            <span>{dayStops[0] && formatLocalTime(win.start, dayStops[0].timezone)}</span>
            <span title={dayStops[0] ? `播放頭時間以起點時區（${dayStops[0].timezone}）顯示` : undefined}>
              {ph !== null && dayStops[0]
                ? `▶ ${formatLocalTime(ph, dayStops[0].timezone)}`
                : ''}
            </span>
            <span>
              {/* 右標籤取「結束最晚」那筆的時區，不是「開始最晚」那筆（審查 Minor）：filterDayStops
                  依 starts_at 排序，但 win.end 取的是 max(endsAt)——重疊行程或長時間住宿的情況下
                  兩者不是同一筆，用陣列最後一筆的時區去格式化就會犯 M-6 本身要修的錯 */}
              {endStop && formatLocalTime(win.end, endStop.timezone)}
            </span>
          </div>
        </>
      ) : (
        <p className="p-2 text-xs text-gray-500">
          {onMove ? '這一天還沒有行程，切到地圖加入停留點吧' : '這一天還沒有行程'}
        </p>
      )}
    </div>
  )
}
