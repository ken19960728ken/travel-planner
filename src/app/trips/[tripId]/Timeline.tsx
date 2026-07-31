'use client'

import type { Stop } from './TripView'
import { formatLocalTime, localDateKey } from '@/lib/domain/tz'
import { detectConflicts } from '@/lib/domain/conflicts'

const HOUR_MS = 60 * 60 * 1000

export type TimelineProps = {
  stops: Stop[]
  dayKeys: string[]
  activeDay: string
  onDayChange: (day: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  playheadMs: number | null
  onPlayheadChange: (ms: number | null) => void
  onMove?: (stopId: string, deltaMs: number) => void // Task 6 接上拖曳提交
}

/** 當日視窗：停留點最早前 1h ~ 最晚後 1h；空日 fallback 當地 08:00–20:00 概念上以 UTC 對齊隱藏 */
export function dayWindow(dayStops: Stop[]): { start: number; end: number } | null {
  if (dayStops.length === 0) return null
  const starts = dayStops.map(s => new Date(s.starts_at).getTime())
  const ends = dayStops.map(s => new Date(s.ends_at).getTime())
  return { start: Math.min(...starts) - HOUR_MS, end: Math.max(...ends) + HOUR_MS }
}

export default function Timeline({
  stops, dayKeys, activeDay, onDayChange, selectedId, onSelect, playheadMs, onPlayheadChange,
}: TimelineProps) {
  const dayStops = stops
    .filter(s => localDateKey(new Date(s.starts_at).getTime(), s.timezone) === activeDay)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  const win = dayWindow(dayStops)
  const span = win ? win.end - win.start : 1
  const pct = (t: number) => ((t - (win?.start ?? 0)) / span) * 100

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
      <div className="mb-2 flex items-center gap-1 overflow-x-auto">
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

      {win ? (
        <>
          <div className="relative h-12 rounded border">
            {dayStops.map(stop => {
              const s = new Date(stop.starts_at).getTime()
              const e = new Date(stop.ends_at).getTime()
              return (
                <button
                  key={stop.id}
                  type="button"
                  data-stop-block={stop.id}
                  onClick={() => onSelect(stop.id)}
                  title={`${stop.name} ${formatLocalTime(s, stop.timezone)}–${formatLocalTime(e, stop.timezone)}`}
                  className={`absolute top-1 bottom-1 overflow-hidden rounded px-1 text-left text-xs text-white ${
                    conflictIds.has(stop.id) ? 'bg-red-600' : selectedId === stop.id ? 'bg-blue-600' : 'bg-emerald-600'
                  }`}
                  style={{ left: `${pct(s)}%`, width: `${Math.max(pct(e) - pct(s), 1.5)}%` }}
                >
                  {stop.locked && '🔒'}
                  {stop.name}
                </button>
              )
            })}
            {playheadMs !== null && playheadMs >= win.start && playheadMs <= win.end && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-orange-500"
                style={{ left: `${pct(playheadMs)}%` }}
              />
            )}
          </div>
          <input
            className="mt-1 w-full"
            type="range"
            min={win.start}
            max={win.end}
            step={5 * 60 * 1000}
            value={playheadMs ?? win.start}
            onChange={e => onPlayheadChange(Number(e.target.value))}
            aria-label="時間軸播放頭"
          />
          <div className="flex justify-between text-xs text-gray-400">
            <span>{dayStops[0] && formatLocalTime(win.start, dayStops[0].timezone)}</span>
            <span>
              {playheadMs !== null && dayStops[0]
                ? `▶ ${formatLocalTime(playheadMs, dayStops[0].timezone)}`
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
