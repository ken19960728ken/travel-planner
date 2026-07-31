'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { APIProvider, Map } from '@vis.gl/react-google-maps'
import { createClient } from '@/lib/supabase/client'
import { nextDefaultSlot } from '@/lib/domain/slot'
import PlaceSearch from './PlaceSearch'
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

export default function TripView({ trip, stops }: { trip: Trip; stops: Stop[] }) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const center = stops.length > 0 ? { lat: stops[0].lat, lng: stops[0].lng } : FALLBACK_CENTER

  async function addStop(p: { name: string; lat: number; lng: number; placeId: string | null; isCustom: boolean }) {
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
      setErrorMsg('加入停留點失敗，請稍後再試')
      return
    }
    setErrorMsg('')
    router.refresh()
  }

  const content = (
    <div className="flex min-h-0 flex-1">
      <aside className="w-80 shrink-0 overflow-y-auto border-r p-3">
        {apiKey && (
          <PlaceSearch onPick={p => addStop({ ...p, isCustom: false })} />
        )}
        {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
        <ul className="flex flex-col gap-2">
          {stops.map(stop => (
            <li
              key={stop.id}
              onClick={() => setSelectedId(stop.id)}
              className={`cursor-pointer rounded border p-2 ${selectedId === stop.id ? 'border-blue-500' : ''}`}
            >
              <span className="font-medium">{stop.name}</span>
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
          />
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
