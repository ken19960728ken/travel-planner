'use client'

import { useEffect } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { greatCirclePoints } from '@/lib/domain/polyline'
import { parseCustomPath, resolveRoutePath } from '@/lib/domain/routePath'
import { isNoTransitData } from './legUi'
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

/** 「無大眾運輸資料」且使用者未手繪時的路線色（設計文件 §7）。Google 對日本 transit 回的是
 *  **純步行路線**，卻被畫得跟真實交通路線一模一樣——使用者無從得知那是走路的。灰虛線讓它
 *  一眼可辨。灰是既有 custom 模式色 #1e293b 的近親，語義相通（「不確定實際怎麼走」），
 *  不新增保留色、不需重跑 ΔE 掃描。 */
const WALKING_FALLBACK_COLOR = '#6b7280'

/** 選中日的交通段路線。路徑優先序由 `resolveRoutePath` 單一來源決定（使用者手繪 → Google
 *  polyline → flight 大圓弧 → 兩點大圓弧兜底），與播放的三個消費點共用同一份語義。
 *  google.maps.Polyline 非 React 元件，用 effect 管生命週期，cleanup 全量移除。
 *
 *  `dimmed`：手繪路徑編輯模式下，其他段落淡化保留（需求方選擇——保有方向感，不會畫完才發現
 *  跟鄰段對不起來），但不可點擊、不搶視覺焦點。 */
export default function RoutePolylines({
  legs, stops, selectedLegId, dimmed = false,
}: {
  legs: Leg[]
  stops: Stop[]
  selectedLegId: string | null
  dimmed?: boolean
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
      const fromPos = { lat: from.lat, lng: from.lng }
      const toPos = { lat: to.lat, lng: to.lng }
      const resolved = resolveRoutePath(leg, fromPos, toPos)
      // 實線 vs 虛線的判準是「這條線代表真實走法嗎」：手繪路徑與 Google 路線是實線；
      // 無資料兜底的大圓弧、以及步行 fallback 都用虛線表示「不確定」
      const hasCustom = parseCustomPath(leg.custom_path).length > 0
      const walkingFallback = !hasCustom && isNoTransitData(leg)
      const solid = resolved !== null && !walkingFallback
      const color = walkingFallback ? WALKING_FALLBACK_COLOR : MODE_COLOR[leg.mode]
      overlays.push(new google.maps.Polyline({
        map,
        path: resolved ?? greatCirclePoints(fromPos, toPos),
        strokeColor: color,
        // 虛線：主線透明 + repeat icon（Google Maps 官方 dashed line 做法）
        strokeOpacity: solid ? (dimmed ? 0.25 : 0.75) : 0,
        strokeWeight: leg.id === selectedLegId ? 5 : 3,
        ...(solid ? {} : {
          icons: [{
            icon: {
              path: 'M 0,-1 0,1',
              strokeOpacity: dimmed ? 0.2 : walkingFallback ? 0.5 : 0.6,
              strokeColor: color,
              scale: 3,
            },
            offset: '0',
            repeat: '14px',
          }],
        }),
      }))
    }
    return () => overlays.forEach(o => o.setMap(null))
  }, [map, legs, stops, selectedLegId, dimmed])

  return null
}
