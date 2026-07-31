'use client'

import { useEffect, useRef } from 'react'
import { useMap, useMapsLibrary } from '@vis.gl/react-google-maps'

type PlacePick = {
  name: string
  lat: number
  lng: number
  placeId: string
}

export default function PlaceSearch({
  onPick,
  onError,
  disabled = false,
}: {
  onPick: (p: PlacePick) => void
  onError?: (text: string) => void
  disabled?: boolean
}) {
  const places = useMapsLibrary('places')
  const map = useMap()
  const containerRef = useRef<HTMLDivElement>(null)
  const elementRef = useRef<google.maps.places.PlaceAutocompleteElement | null>(null)
  const onPickRef = useRef(onPick)
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onPickRef.current = onPick
  })

  useEffect(() => {
    onErrorRef.current = onError
  })

  useEffect(() => {
    if (!places || !containerRef.current) return
    const container = containerRef.current
    const el = new places.PlaceAutocompleteElement()
    el.style.width = '100%'
    elementRef.current = el
    container.appendChild(el)

    const handler = async (event: google.maps.places.PlacePredictionSelectEvent) => {
      const place = event.placePrediction.toPlace()
      try {
        await place.fetchFields({ fields: ['displayName', 'location', 'id'] })
      } catch {
        onErrorRef.current?.('地點資料取得失敗，請再試一次')
        return
      }
      if (!place.location) return
      onPickRef.current({
        name: place.displayName ?? '未命名地點',
        lat: place.location.lat(),
        lng: place.location.lng(),
        placeId: place.id,
      })
      el.value = '' // 連續加入多個景點：選取後清空輸入框
    }
    el.addEventListener('gmp-select', handler)
    const errHandler = () => onErrorRef.current?.('地點搜尋服務發生錯誤，請稍後再試')
    el.addEventListener('gmp-error', errHandler)
    return () => {
      // @types/google.maps 未對 removeEventListener 重載 gmp-select，僅此處收窄轉型
      el.removeEventListener('gmp-select', handler as unknown as EventListener)
      el.removeEventListener('gmp-error', errHandler)
      elementRef.current = null
      container.removeChild(el)
    }
  }, [places])

  useEffect(() => {
    if (elementRef.current) elementRef.current.disabled = disabled
  }, [disabled, places])

  // 搜尋偏好綁定地圖視野：地圖移到哪，建議清單就優先找哪附近
  // （否則 Google 用 IP 位置偏好，人在台灣搜日本景點的排序會很差）
  useEffect(() => {
    if (!map) return
    const applyBias = () => {
      const el = elementRef.current
      const bounds = map.getBounds()
      if (el && bounds) el.locationBias = bounds
    }
    applyBias()
    const listener = map.addListener('idle', applyBias)
    return () => listener.remove()
  }, [map, places])

  return <div ref={containerRef} className="p-2" />
}
