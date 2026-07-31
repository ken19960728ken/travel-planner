'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { APIProvider, Map, AdvancedMarker, Pin, useMap } from '@vis.gl/react-google-maps'
import { createClient } from '@/lib/supabase/client'
import { nextDefaultSlot } from '@/lib/domain/slot'
import PlaceSearch from './PlaceSearch'
import StopEditor from './StopEditor'
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

export default function TripView({ trip, stops }: { trip: Trip; stops: Stop[] }) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const [draftPin, setDraftPin] = useState<{ lat: number; lng: number } | null>(null)
  const [draftName, setDraftName] = useState('')
  const [cameraTarget, setCameraTarget] = useState<{ lat: number; lng: number } | null>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const center = stops.length > 0 ? { lat: stops[0].lat, lng: stops[0].lng } : FALLBACK_CENTER

  async function addStop(p: { name: string; lat: number; lng: number; placeId: string | null; isCustom: boolean }): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    try {
      const schedule = stops.map(s => ({
        id: s.id,
        startsAt: new Date(s.starts_at).getTime(),
        endsAt: new Date(s.ends_at).getTime(),
        locked: s.locked,
      }))
      // 空行程的預設開場：出發日早上九點（瀏覽器時區推定，Plan 3 隨時間軸精算為當地時區）
      const fallback = new Date(`${trip.start_date}T09:00:00`).getTime()
      const slot = nextDefaultSlot(schedule, fallback)

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
        setNotice({ kind: 'error', text: '加入停留點失敗，請稍後再試' })
        return false
      }
      setNotice(null)
      setCameraTarget({ lat: p.lat, lng: p.lng }) // 鏡頭飛到剛加入的停留點
      router.refresh()
      return true
    } finally {
      setBusy(false)
    }
  }

  const content = (
    <div className="flex min-h-0 flex-1">
      <aside className="w-80 shrink-0 overflow-y-auto border-r p-3">
        {apiKey && (
          <PlaceSearch onPick={p => addStop({ ...p, isCustom: false })} disabled={busy} />
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
          {stops.map((stop, i) => (
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
          {stops.length === 0 && <li className="text-sm text-gray-500">還沒有停留點，用上方搜尋加入第一個景點</li>}
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
              const latLng = e.detail.latLng
              if (latLng) setDraftPin({ lat: latLng.lat, lng: latLng.lng })
            }}
          >
            {stops.map((stop, i) => (
              <AdvancedMarker
                key={stop.id}
                position={{ lat: stop.lat, lng: stop.lng }}
                onClick={() => setSelectedId(stop.id)}
                title={stop.name}
              >
                <Pin
                  background={selectedId === stop.id ? '#2563eb' : '#ef4444'}
                  glyphColor="#fff"
                  borderColor="#fff"
                >
                  <span className="text-xs font-bold">{i + 1}</span>
                </Pin>
              </AdvancedMarker>
            ))}
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
  )

  // APIProvider 需包住整個側欄 + 地圖：PlaceSearch（側欄）與 Map 都要用 useMapsLibrary/APIProviderContext，
  // 若只包地圖那一側，PlaceSearch 會拿不到 context（React context 不會跨兄弟節點），gmp-select 永遠不會註冊。
  return apiKey ? <APIProvider apiKey={apiKey}>{content}</APIProvider> : content
}
