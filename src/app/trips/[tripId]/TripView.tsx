'use client'

import { useState } from 'react'
import { APIProvider, Map } from '@vis.gl/react-google-maps'

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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const center = stops.length > 0 ? { lat: stops[0].lat, lng: stops[0].lng } : FALLBACK_CENTER

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-80 shrink-0 overflow-y-auto border-r p-3">
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
          <APIProvider apiKey={apiKey}>
            <Map
              defaultCenter={center}
              defaultZoom={12}
              mapId="DEMO_MAP_ID" // TODO(deploy): 正式環境需換專屬 Map ID
              gestureHandling="greedy"
              disableDefaultUI={false}
            />
          </APIProvider>
        ) : (
          <div className="flex h-full items-center justify-center text-gray-500">
            尚未設定 NEXT_PUBLIC_GOOGLE_MAPS_API_KEY，地圖無法顯示
          </div>
        )}
      </div>
    </div>
  )
}
