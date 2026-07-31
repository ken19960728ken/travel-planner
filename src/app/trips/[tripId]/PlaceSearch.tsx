'use client'

import { useEffect, useRef } from 'react'
import { useMapsLibrary } from '@vis.gl/react-google-maps'

type PlacePick = {
  name: string
  lat: number
  lng: number
  placeId: string
}

export default function PlaceSearch({
  onPick,
  disabled = false,
}: {
  onPick: (p: PlacePick) => void
  disabled?: boolean
}) {
  const places = useMapsLibrary('places')
  const containerRef = useRef<HTMLDivElement>(null)
  const elementRef = useRef<google.maps.places.PlaceAutocompleteElement | null>(null)
  const onPickRef = useRef(onPick)

  useEffect(() => {
    onPickRef.current = onPick
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
      await place.fetchFields({ fields: ['displayName', 'location', 'id'] })
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
    return () => {
      // @types/google.maps 未對 removeEventListener 重載 gmp-select，僅此處收窄轉型
      el.removeEventListener('gmp-select', handler as unknown as EventListener)
      elementRef.current = null
      container.removeChild(el)
    }
  }, [places])

  useEffect(() => {
    if (elementRef.current) elementRef.current.disabled = disabled
  }, [disabled])

  return <div ref={containerRef} className="p-2" />
}
