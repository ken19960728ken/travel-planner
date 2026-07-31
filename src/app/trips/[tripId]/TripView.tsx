'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { APIProvider, Map, AdvancedMarker, Pin, useMap } from '@vis.gl/react-google-maps'
import { createClient } from '@/lib/supabase/client'
import { nextDefaultSlot } from '@/lib/domain/slot'
import { formatLocalTime, localDateKey, wallInputToUtcMs } from '@/lib/domain/tz'
import { tripDayKeys, filterDayStops } from '@/lib/domain/days'
import PlaceSearch from './PlaceSearch'
import StopEditor from './StopEditor'
import Timeline from './Timeline'
import tzlookup from '@photostructure/tz-lookup'

export type Trip = {
  id: string
  title: string
  start_date: string
  end_date: string
  currency: string
}

export type Stop = {
  id: string
  name: string
  lat: number
  lng: number
  place_id: string | null
  is_custom: boolean
  timezone: string
  starts_at: string
  ends_at: string
  locked: boolean
  notes: string | null
  estimated_cost: number | null
}

const FALLBACK_CENTER = { lat: 25.034, lng: 121.5645 } // 台北 101，行程還沒有停留點時的預設視野

type Notice = { kind: 'error' | 'success'; text: string } | null

/** 鏡頭跟隨：target 變更時平移過去；視野太遠時拉近（需在 APIProvider 內才能拿到 map 實例） */
function CameraFollow({ target }: { target: { lat: number; lng: number } | null }) {
  const map = useMap()
  useEffect(() => {
    if (!map || !target) return
    map.panTo(target)
    if ((map.getZoom() ?? 0) < 12) map.setZoom(14)
  }, [map, target])
  return null
}

export default function TripView({
  trip,
  stops,
  stopsError,
}: {
  trip: Trip
  stops: Stop[]
  stopsError?: boolean
}) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  // 預設顯示行程第一天；Timeline 的 Day 分頁點擊會切換它
  const [activeDay, setActiveDay] = useState<string>(() => tripDayKeys(trip.start_date, trip.end_date)[0])
  const [playheadMs, setPlayheadMs] = useState<number | null>(null)
  const busyRef = useRef(false)
  const lastInsertedEndRef = useRef(0)
  const [draftPin, setDraftPin] = useState<{ lat: number; lng: number } | null>(null)
  const [draftName, setDraftName] = useState('')
  const [cameraTarget, setCameraTarget] = useState<{ lat: number; lng: number } | null>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const center = stops.length > 0 ? { lat: stops[0].lat, lng: stops[0].lng } : FALLBACK_CENTER

  // refresh 落地（真實列已涵蓋墊底基準）後歸零，讓後續預設時段計算回歸 props 真相
  useEffect(() => {
    if (stops.some(s => new Date(s.ends_at).getTime() >= lastInsertedEndRef.current)) {
      lastInsertedEndRef.current = 0
    }
  }, [stops])

  async function addStop(p: { name: string; lat: number; lng: number; placeId: string | null; isCustom: boolean }): Promise<boolean> {
    if (busyRef.current) return false
    if (stopsError) return false // 讀取失敗時基準不可信，關閉所有寫入入口（含草稿表單）
    busyRef.current = true
    setBusy(true)
    try {
      // Day-aware：只用當日既有停留點排定時段，避開「多日預設時段疊加」
      const targetDay = activeDay
      // 該日的參考時區：當日已有停留點用其時區，否則沿用全行程最後一個停留點的時區，再不然用瀏覽器時區
      const dayStops = stops.filter(s => localDateKey(new Date(s.starts_at).getTime(), s.timezone) === targetDay)
      const refTz =
        dayStops[dayStops.length - 1]?.timezone ??
        stops[stops.length - 1]?.timezone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone
      const daySchedule = dayStops.map(s => ({
        id: s.id,
        startsAt: new Date(s.starts_at).getTime(),
        endsAt: new Date(s.ends_at).getTime(),
        locked: s.locked,
      }))
      // 空日的預設開場：當地早上九點
      const fallback = wallInputToUtcMs(`${targetDay}T09:00`, refTz)
      if (lastInsertedEndRef.current > 0) {
        // router.refresh() 尚未把新列帶回 props 前，用上次成功寫入的結束時間墊底，避免連續加入算出相同時段
        daySchedule.push({ id: '__pending__', startsAt: lastInsertedEndRef.current - 1, endsAt: lastInsertedEndRef.current, locked: false })
      }
      const slot = nextDefaultSlot(daySchedule, fallback)

      let timezone = 'UTC'
      try {
        timezone = tzlookup(p.lat, p.lng)
      } catch {
        // 海上或極端座標查不到時區時保持 UTC
      }

      const supabase = createClient()
      const { error } = await supabase.from('stops').insert({
        trip_id: trip.id,
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        place_id: p.placeId,
        is_custom: p.isCustom,
        timezone,
        starts_at: new Date(slot.startsAt).toISOString(),
        ends_at: new Date(slot.endsAt).toISOString(),
      })
      if (error) {
        setNotice({
          kind: 'error',
          text: error.code === '23514' ? '加入失敗：名稱長度或數值不符限制' : '加入停留點失敗，請稍後再試',
        })
        return false
      }
      lastInsertedEndRef.current = slot.endsAt
      setNotice(null)
      setCameraTarget({ lat: p.lat, lng: p.lng }) // 鏡頭飛到剛加入的停留點
      router.refresh()
      return true
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 切換 Day：連動重置播放頭與加點基準，並清空選取（舊選取可能不在新的一天，側欄已過濾看不到編輯器）
  function changeDay(day: string) {
    setActiveDay(day)
    setSelectedId(null)
    setPlayheadMs(null)
    lastInsertedEndRef.current = 0
  }

  // 側欄只顯示當前 Day 的停留點，編號沿用當日順序
  const activeDayStops = filterDayStops(stops, activeDay)

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-y-auto border-r p-3">
          {apiKey && !stopsError && (
            <PlaceSearch
              onPick={p => addStop({ ...p, isCustom: false })}
              onError={text => setNotice({ kind: 'error', text })}
              disabled={busy}
            />
          )}
          {draftPin && (
            <form
              className="flex gap-1 rounded border p-2"
              onSubmit={async e => {
                e.preventDefault()
                const name = draftName.trim()
                if (!name) return
                const ok = await addStop({ name, lat: draftPin.lat, lng: draftPin.lng, placeId: null, isCustom: true })
                if (ok) {
                  setDraftPin(null)
                  setDraftName('')
                }
              }}
            >
              <input
                className="min-w-0 flex-1 rounded border p-1 text-sm"
                placeholder="自訂地點名稱"
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                autoFocus
                maxLength={200}
              />
              <button className="rounded bg-foreground px-2 text-sm text-background" type="submit" disabled={busy}>
                加入
              </button>
              <button className="rounded border px-2 text-sm" type="button" onClick={() => setDraftPin(null)}>
                取消
              </button>
            </form>
          )}
          {notice && (
            <p className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
          )}
          <ul className="flex flex-col gap-2">
            {activeDayStops.map((stop, i) => (
              <li
                key={stop.id}
                className={`rounded border p-2 ${selectedId === stop.id ? 'border-blue-500' : ''}`}
              >
                <button
                  type="button"
                  className="block w-full cursor-pointer text-left"
                  onClick={() => {
                    const selecting = selectedId !== stop.id
                    setSelectedId(selecting ? stop.id : null)
                    if (selecting) setCameraTarget({ lat: stop.lat, lng: stop.lng }) // 點側欄 → 鏡頭帶過去
                  }}
                >
                  <span className="mr-1 text-xs text-gray-400">{i + 1}.</span>
                  <span className="mr-1 text-xs text-gray-400">
                    {formatLocalTime(new Date(stop.starts_at).getTime(), stop.timezone)}
                  </span>
                  <span className="font-medium">{stop.name}</span>
                </button>
                {selectedId === stop.id && (
                  <StopEditor
                    key={stop.id}
                    stop={stop}
                    currency={trip.currency}
                    onDeleted={() => setSelectedId(null)}
                  />
                )}
              </li>
            ))}
            {activeDayStops.length === 0 && (
              <li className="text-sm text-gray-500">
                {stopsError ? '停留點讀取失敗，請重新整理再試' : '還沒有停留點，用上方搜尋加入第一個景點'}
              </li>
            )}
          </ul>
        </aside>
        <div className="min-h-0 flex-1">
          {apiKey ? (
            <Map
              defaultCenter={center}
              defaultZoom={12}
              mapId="DEMO_MAP_ID" // TODO(deploy): 正式環境需換專屬 Map ID
              gestureHandling="greedy"
              disableDefaultUI={false}
              onContextmenu={e => {
                if (stopsError) return
                const latLng = e.detail.latLng
                if (latLng) setDraftPin({ lat: latLng.lat, lng: latLng.lng })
              }}
            >
              {stops.map(stop => {
                // 地圖標記照樣渲染全行程，但編號與配色改為「當日視角」：當日 = 紅底 + 當日編號，他日 = 灰底無編號
                const dayIdx = activeDayStops.findIndex(s => s.id === stop.id)
                const inActiveDay = dayIdx >= 0
                return (
                  <AdvancedMarker
                    key={stop.id}
                    position={{ lat: stop.lat, lng: stop.lng }}
                    onClick={() => {
                      // 只有點到不同 Day 的停留點才切換：同日點擊維持播放頭與加點基準不被重置
                      const day = localDateKey(new Date(stop.starts_at).getTime(), stop.timezone)
                      if (day !== activeDay) changeDay(day)
                      setSelectedId(stop.id)
                    }}
                    title={stop.name}
                  >
                    <Pin
                      background={selectedId === stop.id ? '#2563eb' : inActiveDay ? '#ef4444' : '#d1d5db'}
                      glyphColor="#fff"
                      borderColor="#fff"
                    >
                      {inActiveDay ? <span className="text-xs font-bold">{dayIdx + 1}</span> : null}
                    </Pin>
                  </AdvancedMarker>
                )
              })}
              {draftPin && (
                <AdvancedMarker position={draftPin}>
                  <Pin background="#9ca3af" glyphColor="#fff" borderColor="#fff" />
                </AdvancedMarker>
              )}
              <CameraFollow target={cameraTarget} />
            </Map>
          ) : (
            <div className="flex h-full items-center justify-center text-gray-500">
              尚未設定 NEXT_PUBLIC_GOOGLE_MAPS_API_KEY，地圖無法顯示
            </div>
          )}
        </div>
      </div>
      <Timeline
        stops={stops}
        dayKeys={tripDayKeys(trip.start_date, trip.end_date)}
        activeDay={activeDay}
        onDayChange={changeDay}
        selectedId={selectedId}
        onSelect={id => {
          setSelectedId(id)
          const s = stops.find(x => x.id === id)
          if (s) setCameraTarget({ lat: s.lat, lng: s.lng })
        }}
        playheadMs={playheadMs}
        onPlayheadChange={setPlayheadMs}
      />
    </div>
  )

  // APIProvider 需包住整個側欄 + 地圖：PlaceSearch（側欄）與 Map 都要用 useMapsLibrary/APIProviderContext，
  // 若只包地圖那一側，PlaceSearch 會拿不到 context（React context 不會跨兄弟節點），gmp-select 永遠不會註冊。
  return apiKey ? (
    <APIProvider
      apiKey={apiKey}
      onError={() => setNotice({ kind: 'error', text: 'Google 地圖載入失敗，請檢查金鑰設定與網路' })}
    >
      {content}
    </APIProvider>
  ) : (
    content
  )
}
