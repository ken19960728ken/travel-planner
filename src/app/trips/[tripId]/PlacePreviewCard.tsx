'use client'

import { useEffect, useRef, useState } from 'react'
import tzlookup from '@photostructure/tz-lookup'
import { localWeekMinute } from '@/lib/domain/tz'
import { isOpenNow, type OpeningPeriod } from '@/lib/domain/openNow'
import { isRatableCategory, priceLevelLabel, googleMapsSearchUrl } from '@/lib/domain/placePreview'

// Enterprise 批次（rating/userRatingCount/priceLevel/regularOpeningHours）分頁生命週期記憶體快取：
// 同一個 place 在同一次瀏覽中重複預覽（例如取消後再選回同一景點）不必重打。宣告在模組作用域，
// 跨元件重新掛載存活，但重新整理頁面或關閉分頁就消失——純記憶體，嚴禁改成 localStorage /
// sessionStorage / IndexedDB 或任何寫入硬碟的持久化：Google Maps Platform 服務條款只允許永久保存
// place_id、經緯度可存 30 天，名稱／評分／營業時間等豐富資料一律不得倉儲（addStop 也只寫
// name/lat/lng/place_id 到 DB，見該處註解）。
// openNow 刻意不快取「布林值」本身——本質易變，快取久了會顯示過期的營業狀態；改快取 periods
// 原始資料，每次命中快取都用「當下時間」重新算 isOpenNow，兩全其美：Enterprise 欄位不必重抓，
// 但營業狀態永遠即時。
const MAX_CACHE_ENTRIES = 200
const placeDetailCache = new Map<string, CachedPlaceDetail>()

type CachedPlaceDetail = {
  rating: number | null
  userRatingCount: number | null
  priceLevel: google.maps.places.PriceLevelString | null
  periods: OpeningPeriod[] | null // null = 無營業時間資料
}

function cacheDetail(placeId: string, detail: CachedPlaceDetail) {
  if (!placeDetailCache.has(placeId) && placeDetailCache.size >= MAX_CACHE_ENTRIES) {
    // 簡單 FIFO：Map 保證插入順序，直接砍最舊一筆，不做額外的 LRU 記帳
    const oldestKey = placeDetailCache.keys().next().value
    if (oldestKey !== undefined) placeDetailCache.delete(oldestKey)
  }
  placeDetailCache.set(placeId, detail)
}

function extractPeriods(hours: google.maps.places.OpeningHours | null | undefined): OpeningPeriod[] | null {
  if (!hours) return null
  return hours.periods.map(p => ({
    openDay: p.open.day,
    openMinutes: p.open.hour * 60 + p.open.minute,
    closeDay: p.close?.day ?? null,
    closeMinutes: p.close ? p.close.hour * 60 + p.close.minute : null,
  }))
}

function computeOpenNow(periods: OpeningPeriod[] | null, lat: number, lng: number): boolean | null {
  if (!periods) return null
  let tz = 'UTC'
  try {
    tz = tzlookup(lat, lng)
  } catch {
    // 海上或極端座標查不到時區時保持 UTC（與 TripView.addStop 的既有 fallback 一致）
  }
  const { day, minutes } = localWeekMinute(Date.now(), tz)
  return isOpenNow(periods, day, minutes)
}

type PlaceDetail = {
  rating: number | null
  userRatingCount: number | null
  priceLevel: google.maps.places.PriceLevelString | null
  openNow: boolean | null
}

type DetailStatus = 'idle' | 'loading' | 'loaded' | 'error'

/** 搜尋預覽卡片：選中地點先預覽再決定要不要加入行程，不寫 DB。
 *  評分/營業時間/價位等 Enterprise 資料只活在本元件 state（含上面的模組快取），卸載即消失——
 *  onAdd 只會把使用者編輯後的名稱交給父層的 addStop，絕不把這些欄位帶出這個元件。
 *  onSaveCandidate（存入備選）同樣只交出使用者編輯後的名稱字串，一樣禁止把 detail/place 的
 *  Enterprise 欄位帶出這個元件。 */
export default function PlacePreviewCard({
  place,
  initialName,
  lat,
  lng,
  busy,
  onAdd,
  onSaveCandidate,
  onCancel,
}: {
  place: google.maps.places.Place
  initialName: string
  lat: number
  lng: number
  busy: boolean
  onAdd: (name: string) => Promise<boolean>
  onSaveCandidate?: (name: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [name, setName] = useState(initialName)
  const [detail, setDetail] = useState<PlaceDetail | null>(null)
  const [detailStatus, setDetailStatus] = useState<DetailStatus>('idle')
  const cancelledRef = useRef(false)
  // 防止自動抓取被重複觸發（見下方 effect）：一旦啟動就不再重置，呼應 TripView 現有 syncedRef
  // 防 React Strict Mode 開發模式「掛載→卸載→再掛載」合成流程的同一手法
  const autoStartedRef = useRef(false)

  // 開發模式 React Strict Mode 會對同一個 fiber 合成一次「掛載→卸載→再掛載」來檢驗 cleanup：
  // setup 內重置為 false、cleanup 設回 true，才能正確反映「目前是否仍掛載」（官方文件的
  // ignore-flag 範例寫法）；若只在 cleanup 設 true 不重置，ref 會卡死在 true，讓真正掛載後的
  // fetch 結果被誤判成「已卸載」而靜默丟棄。
  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
    }
  }, [])

  async function loadDetail() {
    if (detailStatus === 'loading' || detailStatus === 'loaded') return
    const placeId = place.id
    const cached = placeDetailCache.get(placeId)
    if (cached) {
      setDetail({ ...cached, openNow: computeOpenNow(cached.periods, lat, lng) })
      setDetailStatus('loaded')
      return
    }
    setDetailStatus('loading')
    try {
      const { place: fetched } = await place.fetchFields({
        fields: ['rating', 'userRatingCount', 'priceLevel', 'regularOpeningHours'],
      })
      const periods = extractPeriods(fetched.regularOpeningHours)
      const toCache: CachedPlaceDetail = {
        rating: fetched.rating ?? null,
        userRatingCount: fetched.userRatingCount ?? null,
        priceLevel: fetched.priceLevel ?? null,
        periods,
      }
      cacheDetail(placeId, toCache)
      if (cancelledRef.current) return
      setDetail({ ...toCache, openNow: computeOpenNow(periods, lat, lng) })
      setDetailStatus('loaded')
    } catch {
      if (!cancelledRef.current) setDetailStatus('error')
    }
  }

  const ratable = isRatableCategory(place.types ?? [], place.primaryType ?? null)

  useEffect(() => {
    if (!ratable || autoStartedRef.current) return
    // 同步鎖在 setState 之前就卡住：Strict Mode 合成的「掛載→卸載→再掛載」會讓這個 effect 本體
    // 跑兩次，若沒有這個同步 ref 守衛，兩次都會各自排一個 loadDetail 微任務，變成同一個地點
    // 打兩次 Enterprise 批次（多花錢也有競態風險）。ref 在此同步設定，第二次執行時直接短路。
    autoStartedRef.current = true
    // 透過 .then() 延後呼叫（呼應官方 fetch-in-effect 範例的 fetchBio(person).then(...) 寫法）：
    // loadDetail 命中模組快取時會在零個 await 內同步 setState，直接在 effect 本體呼叫會被
    // react-hooks/set-state-in-effect 判定為「effect 內同步 setState」而擋下；包一層 .then()
    // 補上一個微任務邊界即可滿足規則，行為不變（只是把第一次呼叫挪到下一個微任務）
    void Promise.resolve().then(loadDetail)
    // 只在掛載當下判斷一次是否要自動抓：父層以遞增序號當 key，保證每次新選點都是全新掛載的
    // 實例，不會有「同一實例換分類」需要重跑的情況
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const summary = (() => {
    if (detailStatus !== 'loaded' || !detail) return null
    const parts: string[] = []
    if (detail.rating !== null) {
      const countText = detail.userRatingCount !== null ? `（${detail.userRatingCount.toLocaleString()}）` : ''
      parts.push(`⭐ ${detail.rating}${countText}`)
    }
    const priceLabel = priceLevelLabel(detail.priceLevel)
    if (priceLabel) parts.push(priceLabel)
    if (detail.openNow === true) parts.push('營業中')
    if (detail.openNow === false) parts.push('休息中')
    return parts.length > 0 ? parts.join(' · ') : null
  })()

  const mapsUrl = googleMapsSearchUrl(place.id, initialName)

  return (
    <div className="flex flex-col gap-1 rounded border p-2 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{initialName}</span>
        {summary && <span className="shrink-0 text-xs text-gray-500">{summary}</span>}
      </div>
      {((!ratable && detailStatus === 'idle') || detailStatus === 'error') && (
        // error 時也走這顆鈕重試：loadDetail 的早退守衛只擋 loading/loaded，'error' 會照常重新抓，
        // 不然白名單分類抓失敗（網路瞬斷/配額用盡）就卡死在錯誤文字，沒有任何出口（critic M-1）
        <button type="button" className="self-start text-xs text-gray-400 underline" onClick={() => void loadDetail()}>
          {detailStatus === 'error' ? '評分載入失敗，重試' : '查看評分'}
        </button>
      )}
      {detailStatus === 'loading' && <span className="text-xs text-gray-400">評分載入中…</span>}
      <form
        className="flex gap-1"
        onSubmit={e => {
          e.preventDefault()
          const trimmed = name.trim()
          if (!trimmed) return
          void onAdd(trimmed)
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border p-1 text-sm"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
          maxLength={200}
        />
        <button className="rounded bg-foreground px-2 text-sm text-background disabled:opacity-50" type="submit" disabled={busy}>
          加入行程
        </button>
        {onSaveCandidate && (
          <button
            className="rounded border px-2 text-sm disabled:opacity-50"
            type="button"
            disabled={busy}
            onClick={() => {
              const trimmed = name.trim()
              if (!trimmed) return
              void onSaveCandidate(trimmed)
            }}
          >
            存入備選
          </button>
        )}
        <button className="rounded border px-2 text-sm disabled:opacity-50" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </form>
      <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="self-start text-xs text-blue-600 underline">
        在 Google Maps 開啟
      </a>
    </div>
  )
}
