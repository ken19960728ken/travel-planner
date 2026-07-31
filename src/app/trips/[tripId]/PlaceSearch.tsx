'use client'

import { useEffect, useRef } from 'react'
import { useMapsLibrary } from '@vis.gl/react-google-maps'

type PlacePick = {
  name: string
  lat: number
  lng: number
  placeId: string
}

export default function PlaceSearch({ onPick }: { onPick: (p: PlacePick) => void }) {
  const places = useMapsLibrary('places')
  const containerRef = useRef<HTMLDivElement>(null)
  const onPickRef = useRef(onPick)

  useEffect(() => {
    onPickRef.current = onPick
  })

  useEffect(() => {
    if (!places || !containerRef.current) return
    const container = containerRef.current
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = new (places as any).PlaceAutocompleteElement()
    el.style.width = '100%'
    container.appendChild(el)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = async (event: any) => {
      const place = event.placePrediction.toPlace()
      await place.fetchFields({ fields: ['displayName', 'location', 'id'] })
      if (!place.location) return
      onPickRef.current({
        name: place.displayName ?? '未命名地點',
        lat: place.location.lat(),
        lng: place.location.lng(),
        placeId: place.id,
      })
    }
    el.addEventListener('gmp-select', handler)
    return () => {
      el.removeEventListener('gmp-select', handler)
      container.removeChild(el)
    }
  }, [places])

  return <div ref={containerRef} className="p-2" />
}
