'use client'

import { useEffect } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { decodePolyline, greatCirclePoints } from '@/lib/domain/polyline'
import type { Leg, Stop } from './TripView'

// walking/flight 改用 #16a34a/#8b5cf6（非 #059669/#7c3aed）：後兩者是 categoryUi.ts 的六桶分類色
// （sight/lodging），若挪用會讓地圖同時出現「景點分類色」與「路線色」撞成同一個色碼，違反保留色約束
const MODE_COLOR: Record<Leg['mode'], string> = {
  transit: '#2563eb', walking: '#16a34a', driving: '#d97706', flight: '#8b5cf6', custom: '#6b7280',
}

/** 選中日的交通段路線：有 polyline（Google 衍生）解碼實線；無 polyline（flight/manual）畫大圓弧虛線。
 *  google.maps.Polyline 非 React 元件，用 effect 管生命週期，cleanup 全量移除。 */
export default function RoutePolylines({
  legs, stops, selectedLegId,
}: {
  legs: Leg[]
  stops: Stop[]
  selectedLegId: string | null
}) {
  const map = useMap()

  useEffect(() => {
    if (!map) return
    const stopById = new Map(stops.map(s => [s.id, s]))
    const overlays: google.maps.Polyline[] = []
    for (const leg of legs) {
      const from = stopById.get(leg.from_stop_id)
      const to = stopById.get(leg.to_stop_id)
      if (!from || !to) continue
      const decoded = leg.polyline ? decodePolyline(leg.polyline) : null
      overlays.push(new google.maps.Polyline({
        map,
        path: decoded ?? greatCirclePoints({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }),
        strokeColor: MODE_COLOR[leg.mode],
        // 虛線：主線透明 + repeat icon（Google Maps 官方 dashed line 做法）
        strokeOpacity: decoded ? 0.75 : 0,
        strokeWeight: leg.id === selectedLegId ? 5 : 3,
        ...(decoded ? {} : {
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.6, strokeColor: MODE_COLOR[leg.mode], scale: 3 }, offset: '0', repeat: '14px' }],
        }),
      }))
    }
    return () => overlays.forEach(o => o.setMap(null))
  }, [map, legs, stops, selectedLegId])

  return null
}
