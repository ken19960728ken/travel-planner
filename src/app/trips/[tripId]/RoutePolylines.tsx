'use client'

import { useEffect } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { decodePolyline, greatCirclePoints } from '@/lib/domain/polyline'
import type { Leg, Stop } from './TripView'

// 2026-08-04 總審 m-6：CIE ΔE（sRGB→XYZ→Lab 歐氏距離，方法同 categoryUi.ts）全配對掃描結果——
// 五色彼此 pairwise 最小 ΔE 37.3（transit vs flight）；五色對全部保留色（六桶分類色 + #2563eb 選取 +
// #9ca3af 草稿針 + #f59e0b 選中備選 + #f97316 播放頭 + #dc2626 紅線）最小 ΔE 20.3（custom vs
// other #52525b），零 exact 碰撞。此前版本 transit=#2563eb 與「選取」exact 碰撞（ΔE=0）、
// walking/flight 曾挪用 sight/lodging 的六桶色，本輪一併換掉。色相對應：transit 深藍、walking 深綠、
// driving 琥珀棕（為了與 food #7c2d12 拉開距離，比一般「橘」更偏黃棕）、flight 深紫、custom 石板灰
const MODE_COLOR: Record<Leg['mode'], string> = {
  transit: '#1e3a8a', walking: '#166534', driving: '#a16207', flight: '#6b21a8', custom: '#1e293b',
}

/** 選中日的交通段路線：有 polyline（Google 衍生）解碼實線；無 polyline 者（flight／manual／無資料的
 *  transit）畫大圓弧虛線。google.maps.Polyline 非 React 元件，用 effect 管生命週期，cleanup 全量移除。 */
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
