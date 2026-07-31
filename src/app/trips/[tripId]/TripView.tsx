'use client'

import { useEffect, useRef, useState } from 'react'
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
      const schedule = stops.map(s => ({
        id: s.id,
        startsAt: new Date(s.starts_at).getTime(),
        endsAt: new Date(s.ends_at).getTime(),
        locked: s.locked,
      }))
      // 空行程的預設開場：出發日早上九點（瀏覽器時區推定，Plan 3 隨時間軸精算為當地時區）
      const fallback = new Date(`${trip.start_date}T09:00:00`).getTime()
      if (lastInsertedEndRef.current > 0) {
        // router.refresh() 尚未把新列帶回 props 前，用上次成功寫入的結束時間墊底，避免連續加入算出相同時段
        schedule.push({ id: '__pending__', startsAt: lastInsertedEndRef.current - 1, endsAt: lastInsertedEndRef.current, locked: false })
      }
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

  const content = (
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
          {stops.length === 0 && (
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
