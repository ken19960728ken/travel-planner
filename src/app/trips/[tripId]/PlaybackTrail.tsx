'use client'

import { useEffect, useRef } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { pathSlice, type LatLng } from '@/lib/domain/polyline'

/** 播放漸進紅線：已完成的段落畫整條、進行中段落畫到目前位置（pathSlice）。
 *  疊在 RoutePolylines 的模式色細線上方（zIndex 高一層），紅 #dc2626、寬 4。
 *  每秒更新一次 path——重用同一個 Polyline 實例 setPath，不整批重建（重建會閃爍）。 */
export default function PlaybackTrail({
  completedPaths, currentPath, progress, active,
}: {
  /** 本日已走完的各段路徑（依時間順序） */
  completedPaths: LatLng[][]
  /** 進行中段落的完整路徑；null = 目前在停留中或缺料 */
  currentPath: LatLng[] | null
  progress: number
  active: boolean
}) {
  const map = useMap()
  const doneRef = useRef<google.maps.Polyline[]>([])
  const currentRef = useRef<google.maps.Polyline | null>(null)

  useEffect(() => {
    if (!map || !active) return
    const style = { strokeColor: '#dc2626', strokeOpacity: 0.9, strokeWeight: 4, zIndex: 10 }
    doneRef.current = completedPaths.map(p => new google.maps.Polyline({ map, path: p, ...style }))
    currentRef.current = new google.maps.Polyline({ map, path: [], ...style })
    return () => {
      doneRef.current.forEach(o => o.setMap(null))
      doneRef.current = []
      currentRef.current?.setMap(null)
      currentRef.current = null
    }
  }, [map, active, completedPaths])

  useEffect(() => {
    if (!currentRef.current) return
    currentRef.current.setPath(currentPath ? pathSlice(currentPath, progress) : [])
  }, [currentPath, progress])

  return null
}
