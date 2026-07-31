'use client'

import { useRef, useState } from 'react'
import type { Stop } from './TripView'
import { formatLocalTime } from '@/lib/domain/tz'
import { filterDayStops } from '@/lib/domain/days'
import { detectConflicts } from '@/lib/domain/conflicts'

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
  playing: boolean
  onTogglePlay: () => void
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
  playing, onTogglePlay,
}: TimelineProps) {
  const dayStops = filterDayStops(stops, activeDay)
  const win = dayWindow(dayStops)
  const span = win ? win.end - win.start : 1
  const pct = (t: number) => ((t - (win?.start ?? 0)) / span) * 100
  // playheadMs 可能因資料變動（拖曳/刪除後 win 縮小）落在視窗外；畫線/滑桿/文字一律用夾回視窗內的值，避免互相矛盾
  const ph = win && playheadMs !== null ? Math.min(Math.max(playheadMs, win.start), win.end) : null

  // 拖曳平移色塊：位移 < SNAP_MS 視為點擊（→ onSelect），否則放開時提交平移（→ onMove）
  const [drag, setDrag] = useState<{ id: string; startX: number; deltaMs: number; pointerId: number } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  function beginDrag(e: React.PointerEvent, stopId: string) {
    if (!win || busy || drag) return // 上層寫入中或已有拖曳進行中，不再開新的一場
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
      // 等 RPC 完成才清 drag（縮短回彈窗口；refresh 落地前仍有短暫跳動，完整消除需 pendingDelta 機制，記入 Plan 4）
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

  const warnings = detectConflicts(
    dayStops.map(s => ({
      id: s.id,
      startsAt: new Date(s.starts_at).getTime(),
      endsAt: new Date(s.ends_at).getTime(),
      locked: s.locked,
    })),
    [], // 交通段 Plan 4 接入
  )
  const conflictIds = new Set(
    warnings.flatMap(w => (w.type === 'overlap' ? w.stopIds : [w.fromStopId, w.toStopId])),
  )

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
              // 拖曳中的色塊用偏移後的時間預覽位置，放開才真正提交
              const offset = drag?.id === stop.id ? drag.deltaMs : 0
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
                  title={`${stop.name} ${formatLocalTime(s, stop.timezone)}–${formatLocalTime(e, stop.timezone)}`}
                  className={`absolute top-1 bottom-1 touch-none overflow-hidden rounded px-1 text-left text-xs text-white ${
                    conflictIds.has(stop.id) ? 'bg-red-600' : selectedId === stop.id ? 'bg-blue-600' : 'bg-emerald-600'
                  }`}
                  style={{ left: `${pct(s + offset)}%`, width: `${Math.max(pct(e + offset) - pct(s + offset), 1.5)}%` }}
                >
                  {stop.locked && '🔒'}
                  {stop.name}
                </button>
              )
            })}
            {ph !== null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-orange-500"
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
            <span>{dayStops[0] && formatLocalTime(win.start, dayStops[0].timezone)}</span>
            <span>
              {ph !== null && dayStops[0]
                ? `▶ ${formatLocalTime(ph, dayStops[0].timezone)}`
                : ''}
            </span>
            <span>{dayStops[0] && formatLocalTime(win.end, dayStops[0].timezone)}</span>
          </div>
        </>
      ) : (
        <p className="p-2 text-xs text-gray-500">這一天還沒有行程，切到地圖加入停留點吧</p>
      )}
    </div>
  )
}
