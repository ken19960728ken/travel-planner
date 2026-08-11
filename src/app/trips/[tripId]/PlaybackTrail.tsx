'use client'

import { useEffect, useRef } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { pathSlice, type LatLng } from '@/lib/domain/polyline'

/** 播放漸進紅線：已完成的段落畫整條、進行中段落畫到目前位置（pathSlice）。
 *  疊在 RoutePolylines 的模式色細線上方（zIndex 高一層），紅 #dc2626、寬 4。
 *  每秒更新一次 path——重用同一個 Polyline 實例 setPath，不整批重建（重建會閃爍）。
 *
 *  2026-08-11：進行中段落由單一條改成**陣列**——分頭行動時甲乙可能同時各走一段，
 *  只畫一條會讓另一個人的紅線整段消失。實例數只在段數改變時才重建（同上「重建會閃爍」）。 */
export default function PlaybackTrail({
  completedPaths, currentSegments, active,
}: {
  /** 本日已走完的各段路徑 */
  completedPaths: LatLng[][]
  /** 進行中的段落與各自進度；空陣列 = 所有軌道都在停留中或缺料 */
  currentSegments: { path: LatLng[]; progress: number }[]
  active: boolean
}) {
  const map = useMap()
  const doneRef = useRef<google.maps.Polyline[]>([])
  const currentRef = useRef<google.maps.Polyline[]>([])

  useEffect(() => {
    if (!map || !active) return
    const style = { strokeColor: '#dc2626', strokeOpacity: 0.9, strokeWeight: 4, zIndex: 10 }
    doneRef.current = completedPaths.map(p => new google.maps.Polyline({ map, path: p, ...style }))
    return () => {
      doneRef.current.forEach(o => o.setMap(null))
      doneRef.current = []
    }
  }, [map, active, completedPaths])

  // 進行中的線另開一顆 effect，deps 只看「段數」：段數不變時重用實例逐秒 setPath（不閃爍），
  // 段數改變（分頭開始/結束）才重建。與上面的 completedPaths effect 分開，避免互相拖累。
  const currentCount = active ? currentSegments.length : 0
  useEffect(() => {
    if (!map || currentCount === 0) return
    const style = { strokeColor: '#dc2626', strokeOpacity: 0.9, strokeWeight: 4, zIndex: 10 }
    currentRef.current = Array.from({ length: currentCount }, () => new google.maps.Polyline({ map, path: [], ...style }))
    return () => {
      currentRef.current.forEach(o => o.setMap(null))
      currentRef.current = []
    }
  }, [map, currentCount])

  useEffect(() => {
    currentRef.current.forEach((line, i) => {
      const seg = currentSegments[i]
      line.setPath(seg ? pathSlice(seg.path, seg.progress) : [])
    })
  }, [currentSegments])

  return null
}
