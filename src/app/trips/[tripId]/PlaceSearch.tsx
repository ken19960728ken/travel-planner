'use client'

import { useEffect, useRef } from 'react'
import { useMap, useMapsLibrary } from '@vis.gl/react-google-maps'

// 搜尋選中先預覽不寫入 DB：帶出 place 物件本身（而非拆散成純資料），讓 PlacePreviewCard
// 需要時能對同一個 Place 實例再 fetchFields 一次抓 Enterprise 批次（評分/營業時間等）
export type PlacePick = {
  place: google.maps.places.Place
  name: string
  lat: number
  lng: number
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
    let el: google.maps.places.PlaceAutocompleteElement
    try {
      el = new places.PlaceAutocompleteElement()
    } catch {
      // I-2：金鑰缺 Places (New) 權限等情況下這裡已知會拋出；攔下改走既有的降級提示路徑，避免這個
      // useEffect 內的例外冒泡到最近的 error boundary，把整個行程頁打崩（原本沒有 try/catch 時就是
      // 這樣：只有地圖區塊有 boundary，PlaceSearch 位在側欄，例外會一路冒泡到 Next 的路由層預設崩潰頁）
      onErrorRef.current?.('地點搜尋服務目前無法使用')
      return
    }
    el.style.width = '100%'
    elementRef.current = el
    container.appendChild(el)

    const handler = async (event: google.maps.places.PlacePredictionSelectEvent) => {
      const place = event.placePrediction.toPlace()
      try {
        // types/primaryType 與 displayName 同層或更低（Pro），不升計費級別；供 PlacePreviewCard
        // 判斷評分白名單。rating/priceLevel 等 Enterprise 欄位刻意不在此抓，留給預覽卡片視情況再抓
        await place.fetchFields({ fields: ['displayName', 'location', 'id', 'types', 'primaryType'] })
      } catch {
        onErrorRef.current?.('地點資料取得失敗，請再試一次')
        return
      }
      if (!place.location) return
      onPickRef.current({
        place,
        name: place.displayName ?? '未命名地點',
        lat: place.location.lat(),
        lng: place.location.lng(),
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
