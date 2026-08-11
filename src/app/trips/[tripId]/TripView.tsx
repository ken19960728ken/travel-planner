'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { APIProvider, Map, AdvancedMarker, Pin, useMap } from '@vis.gl/react-google-maps'
import { createClient } from '@/lib/supabase/client'
import { defaultSlotForDay, stayMsForCategory } from '@/lib/domain/slot'
import { formatLocalTime, localDateKey } from '@/lib/domain/tz'
import { tripDayKeys, filterDayStops } from '@/lib/domain/days'
import { interpolatePosition, segmentAt } from '@/lib/domain/interpolate'
import { pathPosition, type LatLng } from '@/lib/domain/polyline'
import { parseCustomPath, resolveRoutePath } from '@/lib/domain/routePath'
import { adjacentPairs } from '@/lib/domain/legSync'
import { pendingShiftResolved, type PendingShift } from '@/lib/domain/schedule'
import type { StopCategory } from '@/lib/domain/placeCategory'
import PlaceSearch, { type PlacePick } from './PlaceSearch'
import PlacePreviewCard from './PlacePreviewCard'
import StopEditor from './StopEditor'
import LegEditor from './LegEditor'
import Timeline, { dayWindow } from './Timeline'
import SectionErrorBoundary from './SectionErrorBoundary'
import { shouldPanCamera } from './cameraGeometry'
import { buildDayView } from './dayView'
import { MODE_ICON, legDurationText, isNoTransitData } from './legUi'
import CandidatesPanel, { type Candidate } from './CandidatesPanel'
import RouteEditor from './RouteEditor'
import CostSummary from './CostSummary'
import { CATEGORY_PIN_HEX, CATEGORY_ICON } from './categoryUi'
import { normalizeCategory } from '@/lib/domain/placeCategory'
import RoutePolylines from './RoutePolylines'
import PlaybackTrail from './PlaybackTrail'
import tzlookup from '@photostructure/tz-lookup'
import TripRealtime, { type PresencePeer } from './TripRealtime'

export type Trip = {
  id: string
  title: string
  start_date: string
  end_date: string
  currency: string
  /** Task 8：分享頁重用此型別，但資料來自 get_shared_trip RPC 白名單，不含 share_token
   *  （白名單本就刻意不收，撤銷憑證不能送給匿名訪客）——宣告為可選讓兩種資料來源都能通過型別檢查 */
  share_token?: string
  /** 參與人名冊。**刻意宣告為 unknown**：資料來自 DB 與分享 RPC，形狀不可信，強迫所有消費端
   *  必須先過 `parseRoster`（src/lib/domain/participants.ts）。同 Leg.custom_path 的理由。
   *  另一層原因：分享 RPC 的投影刻意少了 user_id（不能給匿名訪客），與 DB 的形狀本就不同，
   *  宣告成具體型別會讓兩個來源之一必然說謊。 */
  participants: unknown
}

export type Stop = {
  id: string
  name: string
  lat: number
  lng: number
  place_id: string | null
  is_custom: boolean
  timezone: string
  starts_at: string
  ends_at: string
  locked: boolean
  notes: string | null
  estimated_cost: number | null
  category: StopCategory
  /** 誰會去。null ＝ 全員。**刻意宣告為 unknown**，一律先過 `resolveStopParticipants`
   *  （src/lib/domain/participants.ts）——那裡集中處理 null、未知 id、全部無效三種情況。 */
  participant_ids: unknown
}

export type Leg = {
  id: string
  from_stop_id: string
  to_stop_id: string
  mode: 'transit' | 'walking' | 'driving' | 'flight' | 'custom'
  duration_minutes: number | null
  distance_meters: number | null
  polyline: string | null
  /** 使用者手繪的路徑（中間轉折點，jsonb `[[lat,lng],...]`）。**刻意宣告為 unknown**：資料來自 DB
   *  與分享 RPC，形狀不可信，強迫所有消費端必須先過 `parseCustomPath`（src/lib/domain/routePath.ts）
   *  再使用，避免重演 Realtime presence 那種「信任遠端資料形狀導致整頁崩潰」的事故（spec §8 C-1）。 */
  custom_path: unknown
  detail: unknown
  source: 'auto' | 'manual'
  stale: boolean
  departs_at: string | null
  arrives_at: string | null
  estimated_cost: number | null
  updated_at: string
}

/** 編輯模式下用來停用必填 callback prop 的空函式（傳 undefined 會壞型別）。 */
const NOOP = () => {}

const FALLBACK_CENTER = { lat: 25.034, lng: 121.5645 } // 台北 101，行程還沒有停留點時的預設視野
/** 地圖樣式 ID。`DEMO_MAP_ID` 是 Google 給文件範例用的，官方明載不可用於正式環境、也不支援
 *  Cloud Styling；未設環境變數時沿用它，行為與先前完全相同。正式 Map ID 的建立步驟見
 *  docs/guides/gcp-setup.md（建好後在 Vercel 設 NEXT_PUBLIC_GOOGLE_MAP_ID 並重新部署即可，
 *  不需要改程式碼）。AdvancedMarker 需要 mapId 才能運作，故不可為空字串。 */
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || 'DEMO_MAP_ID'
const PLAY_STEP_MS = 10 * 60 * 1000 // 播放中每秒推進的模擬時間
const PLAYBACK_MAX_ZOOM = 15 // 起播 fitBounds 的縮放上限：單點/近距離日程會被拉到最大縮放，需夾住
/** 換段取景的縮放上限（分 mode）：步行段 fitBounds 天然拉到 18-19，夾 16 保留街廓脈絡；
 *  其餘沿用整日取景的 15。flight 遠距離 fitBounds 天然落在 6-9，上限實際不生效，統一寫上避免特例 */
const SEGMENT_MAX_ZOOM: Record<Leg['mode'], number> = {
  walking: 16, transit: 15, driving: 15, flight: 15, custom: 15,
}
const SYNC_RETRY_MS = 1_500 // I-3：sync 回報 pending/incomplete 時的續跑間隔
const MAX_SYNC_ROUNDS = 6 // I-3：續跑回合上限（配合 I-2 的 in-flight guard），避免無金鑰環境無限重試
// M-1 逾時保險：拖曳偏移預覽最多維持這麼久。RPC + router.refresh() 正常在 1-2 秒內落地，
// 5 秒足以涵蓋慢速網路；超過就代表落地值對不上 client baseline（協作者同時改了同一點），
// 此時寧可讓色塊跳回真值，也不要長期顯示不存在的時間
const PENDING_SHIFT_TIMEOUT_MS = 5_000

type Notice = { kind: 'error' | 'success'; text: string } | null

/** 鏡頭跟隨：target 變更時平移過去；視野太遠時拉近（需在 APIProvider 內才能拿到 map 實例）。
 *  I-1（審查更正）：播放中（playing=true）不做「視野太遠就拉近」——PlaybackCamera 已用 fitBounds
 *  收好整段視野；若使用者這時點側欄或時間軸的停留點觸發這裡的 setCameraTarget，被拉到 zoom 14 會讓
 *  下一個播放 tick 的位移暴增，重演瞬移灰塊（可達路徑：Timeline 停留點色塊的 onSelect 對 playing
 *  沒有任何閘門）。panTo 本身仍照常執行——使用者點擊是明確意圖，只是播放中不跟著硬拉縮放。 */
function CameraFollow({ target, playing }: { target: { lat: number; lng: number } | null; playing: boolean }) {
  const map = useMap()
  useEffect(() => {
    if (!map || !target) return
    map.panTo(target)
    if (!playing && (map.getZoom() ?? 0) < 12) map.setZoom(14)
  }, [map, target, playing])
  return null
}

/** 播放鏡頭（M-7，2026-08-01 產品拍板：**起播定格全景，不是逐幀跟著橘點跑**）：起播時用
 *  fitBounds 把當日整段路線收進視野一次，之後鏡頭原則上不動，橘點自己在畫面內移動；只有橘點跑出
 *  視窗中央 70% 安全區（例如單日跨距超過容器、或使用者手動平移過鏡頭）才會 panTo 追上去。
 *  這是刻意的產品行為（使用者在 N-4 review 明確選擇「定格全景」而非「鏡頭貼著橘點跑」），
 *  邊緣閘門是安全網——不要因為「九州這種日程通常不會觸發」就拿掉，沒有它，遠距離或使用者平移過的
 *  日程會回到瞬移灰塊的舊 bug。
 *  相依取 lat/lng 數值而非位置物件——物件字面量每次 render 都是新參照，會讓 effect 每輪重跑。
 *  M-6（跨分支提醒）：Google 官方文件記載地圖容器 `display:none` 時 fitBounds 讀到 0x0 尺寸、
 *  不會做任何事——若 mobile 版面把地圖面板用 `hidden` class 藏起來，這裡的 fitBounds 會靜默失效，
 *  合併前請檢查手機版面下播放是否仍會收整段視野。 */
function PlaybackCamera({
  lat, lng, active, bounds, daySessionKey, segmentFitKey, segmentPath, segmentMaxZoom,
}: {
  lat: number | null
  lng: number | null
  active: boolean
  /** 當日停留點的原始座標陣列（未化簡成 min/max）：TripView 每次 render 都會重新 map() 出新參照，
   *  故不放進下面 effect 的 deps，改用 ref 讀最新值（同 L468 playheadMsRef 的作法：ref 寫入也要放進
   *  effect 裡，不能在 render 期間直接賦值，否則違反 react-hooks/refs） */
  bounds: { lat: number; lng: number }[] | null
  /** `${activeDay}:${播放 session 序號}`（2026-08-04 總審 M-3）：判斷整日 fitBounds 該不該重來的
   *  依據。序號只在「從頭開始播放」時遞增（TripView 的 togglePlay），暫停後恢復不遞增——同一
   *  session 已經 fit 過整日全景就不再重複，鏡頭留在暫停當下的位置（可能已被分段取景收到某段路線），
   *  不會彈回全景。切 Day 因為 key 前綴帶 activeDay，天然視為新 session */
  daySessionKey: string
  /** travel 段才有值（`travel:${fromStopId}`），stay 段為 null：分段取景只在交通段觸發一次
   *  fitBounds，停留期間鏡頭不動（2026-08-03 設計拍板 (a)）。deps 只看這個 key，同一段內 progress
   *  逐秒變動不得觸發 refit */
  segmentFitKey: string | null
  /** 進行中交通段的完整路徑：travel 段才有值，缺料（地面段沒有 polyline）由呼叫端退回兩點直線 */
  segmentPath: { lat: number; lng: number }[] | null
  /** 該段 mode 對應的 fitBounds 縮放上限（SEGMENT_MAX_ZOOM） */
  segmentMaxZoom: number
}) {
  const map = useMap()
  const boundsRef = useRef(bounds)
  useEffect(() => {
    boundsRef.current = bounds
  }, [bounds])
  // M-2：跟下面的跟隨 effect 同樣依賴 active，起播那個 commit 兩者會接連執行；跟隨 effect
  // 若接著讀 map.getBounds() 可能拿到 fitBounds 套用前的舊視窗（見下方 C-1 說明的同一個啟發式
  // 時序問題），在舊座標系下誤判邊緣、跟 fitBounds 的動畫互搶。用這個旗標讓跟隨 effect 那輪跳過一次。
  const justFittedRef = useRef(false)
  // 2026-08-04 總審 M-3：記錄「已經 fit 過整日全景」的 session key，暫停恢復（daySessionKey 不變）
  // 時跳過重 fit，只有真正的新 session（從頭播放或切 Day）才收一次全景
  const fittedSessionRef = useRef<string | null>(null)
  // 起播時（active 由 false→true）把當日整段收進視野，取代原本「zoom<12 才拉近單點」的邏輯——
  // 遠距離日程（如福岡→鹿兒島 200km）不會再被單點 setZoom(14) 強拉到超出容器涵蓋範圍。
  // 這裡用逐點 extend 建構 LatLngBounds 而非在呼叫端 Math.min/max 化簡座標，是因為 Math.min/max
  // 在跨 180 度經線時會算出反向（過大）的框；extend 交給 Google 官方實作正確處理，且只能在
  // google.maps 腳本已載入後呼叫（map 非 null 時保證已載入），render 期間（含 SSR）不能碰 google 全域
  useEffect(() => {
    if (!map || !active) return
    // maxZoom 夾制放在 session 守門之外、只要 active 就套用（複審 🔵-4/5）：
    // (a) dev 的 StrictMode 雙跑會 setup→cleanup→setup，第二次 setup 因 session 已記錄而跳過 fit——
    //     若夾制也在守門內，cleanup 清掉的 maxZoom 就沒人補回，fitBounds 的延遲套用可能逃過夾制；
    // (b) 暫停恢復（跳過 fit 的路徑）也一樣要把 cleanup 清掉的 maxZoom 補回，維持「播放中一律夾住」語義
    map.setOptions({ maxZoom: PLAYBACK_MAX_ZOOM })
    if (fittedSessionRef.current !== daySessionKey) {
      const b = boundsRef.current
      if (b && b.length > 0) {
        // C-1（審查更正，race-free 修復）：原本 fitBounds 後立刻 getZoom() 判斷要不要夾縮放上限，
        // 但 @types/google.maps 的 fitBounds 文件明載「是否套用動畫由內部啟發式決定」——呼叫後立刻讀到
        // 的可能是套用前的舊值。用「按播放前的 zoom」去判斷「fitBounds 之後該不該夾」是競態、行為不可
        // 決定（實測：使用者先手動放大到 z17 再播放 → 誤讀舊值 17 → 才誤觸發夾成 15，但若舊 zoom 本來
        // 就 <15 則完全不會觸發，該夾的單點/近距離日程反而夾不到）。改用 maxZoom 選項讓 fitBounds 在
        // 套用當下就不會超過上限，沒有「事後讀值」這個步驟，天生不會有時序競態。
        const latLngBounds = new google.maps.LatLngBounds()
        for (const p of b) latLngBounds.extend(p)
        map.fitBounds(latLngBounds, 60)
        justFittedRef.current = true
        fittedSessionRef.current = daySessionKey
      }
    }
    // cleanup 與「這輪是否真的 fit 了」無關，一律註冊：M-3 讓 fit 可能被跳過（同一 session 暫停恢復），
    // 但 maxZoom 的還原不能跟著被跳過，否則分段取景（下面 effect）在跳過整日 fit 的 session 中設過的
    // maxZoom 會在暫停後卡住手動縮放（審查 Task 4 Step 3 的既有壓力點 #3，M-3 不得使其回歸）
    return () => {
      // active 轉 false（暫停/停止）時還原，不永久限制使用者手動縮放
      map.setOptions({ maxZoom: null })
    }
  }, [map, active, daySessionKey])
  // 分段取景（2026-08-03 設計拍板）：播放推進到 travel 段時，以該段完整路徑 fitBounds 一次
  // （瞬間切換，不做連續縮放——zoom 6↔16 的過渡動畫會穿越大量中間層級圖磚，是灰塊事故溫床）。
  // stay 段 segmentFitKey 為 null，不動鏡頭（維持前一段的框，設計拍板 (a)）。
  // deps 只看 segmentFitKey：同一段內 progress 逐秒變動不得觸發 refit。
  // path/maxZoom 用 ref 讀最新值（同 boundsRef 模式——陣列參照每 render 都新）
  const segmentPathRef = useRef(segmentPath)
  const segmentMaxZoomRef = useRef(segmentMaxZoom)
  useEffect(() => {
    segmentPathRef.current = segmentPath
    segmentMaxZoomRef.current = segmentMaxZoom
  }, [segmentPath, segmentMaxZoom])
  useEffect(() => {
    if (!map || !active || !segmentFitKey) return
    const path = segmentPathRef.current
    if (!path || path.length === 0) return
    map.setOptions({ maxZoom: segmentMaxZoomRef.current })
    const b = new google.maps.LatLngBounds()
    for (const p of path) b.extend(p)
    map.fitBounds(b, 60)
    justFittedRef.current = true
  }, [map, active, segmentFitKey])
  useEffect(() => {
    if (!map || !active || lat === null || lng === null) return
    if (justFittedRef.current) {
      justFittedRef.current = false
      return
    }
    // 邊緣閘門（純函式抽到 cameraGeometry.ts 方便單元測試，含跨 180 度經線的 M-1 修復）：點還在
    // 目前視窗中央 70% 區域內就不動鏡頭，避免每個取樣點都 panTo 一次造成掃視感；真的要出邊界才動，
    // 動的時候仍是平滑 panTo（非瞬移）
    const rawBounds = map.getBounds()
    const viewport = rawBounds
      ? {
          ne: { lat: rawBounds.getNorthEast().lat(), lng: rawBounds.getNorthEast().lng() },
          sw: { lat: rawBounds.getSouthWest().lat(), lng: rawBounds.getSouthWest().lng() },
        }
      : null
    if (!shouldPanCamera({ lat, lng }, viewport)) return
    map.panTo({ lat, lng })
  }, [map, active, lat, lng])
  return null
}

/** 「改回自動計算」鈕（審查 M-1：轉存/手動段沒有自動復原路徑，堵死路）——以 UPDATE 轉回 auto 空殼（不是
 *  DELETE）：相鄰時 legSync 判 neverComputed 原地重算，不相鄰時 estimatedCost 已清為 null 走 removeAuto
 *  自然收斂，兩態皆閉環。同一顆元件用在脫離段區塊與正常交通列的 manual 段兩處，行為單一來源保持一致。 */
function RevertToAutoButton({ legId, onChanged }: { legId: string; onChanged: () => void }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function revert() {
    if (busy) return
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from('legs')
        .update({
          // mode 一併重設：flight/custom 不在 sync 的 AUTO_MODES，留著會變成永遠算不出的殭屍段
          source: 'auto', mode: 'transit', stale: false, estimated_cost: null,
          duration_minutes: null, computed_at: null, departs_at: null, arrives_at: null,
        })
        .eq('id', legId)
        .eq('source', 'manual')
      if (!error) {
        onChanged()
        router.refresh()
      }
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-700">
        會清除此段的手動內容與花費，並改用大眾運輸自動計算
        <button type="button" className="rounded bg-amber-600 px-1 text-white disabled:opacity-50" disabled={busy} onClick={revert}>
          確認
        </button>
        <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={busy} onClick={() => setConfirming(false)}>
          取消
        </button>
      </span>
    )
  }
  return (
    <button type="button" className="rounded border px-1 text-amber-700 disabled:opacity-50" disabled={busy} onClick={() => setConfirming(true)}>
      改回自動計算
    </button>
  )
}

/** 側欄「已脫離順序的交通段」區塊的一列（Important-2 根治）：配對脫離後仍保留資料，
 *  不提供編輯（脫離段沒有時間基準，編輯無意義），只給刪除與改回自動計算兩個出口。 */
function DetachedLegRow({
  leg, fromStop, toStop, currency, canEdit, onChanged,
}: {
  leg: Leg
  fromStop: Stop
  toStop: Stop
  currency: string
  /** viewer 隱藏刪除／改回自動計算鈕——資料仍可見（唯讀不是不能看），只是不給寫入出口 */
  canEdit: boolean
  onChanged: () => void
}) {
  const router = useRouter()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  async function remove() {
    if (busy) return
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from('legs').delete().eq('id', leg.id)
      if (!error) {
        onChanged()
        router.refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded border border-dashed p-2 text-xs">
      <p>
        {MODE_ICON[leg.mode]} {fromStop.name} → {toStop.name}
      </p>
      <p className="text-gray-500">
        {leg.departs_at && leg.arrives_at && (
          <>
            {formatLocalTime(new Date(leg.departs_at).getTime(), fromStop.timezone)}
            –{formatLocalTime(new Date(leg.arrives_at).getTime(), toStop.timezone)}{' '}
          </>
        )}
        {legDurationText(leg)}
        {leg.estimated_cost !== null && ` · ${currency} ${leg.estimated_cost}`}
      </p>
      <p className="text-amber-700">⚠️ 已脫離行程順序，資料保留</p>
      {canEdit && (
        <div className="mt-1 flex items-center gap-2">
          {confirmDelete ? (
            <>
              <button type="button" className="rounded bg-red-600 px-2 text-white disabled:opacity-50" disabled={busy} onClick={remove}>
                確認刪除
              </button>
              <button type="button" className="rounded border px-2 disabled:opacity-50" disabled={busy} onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className="rounded border px-2 text-red-600 disabled:opacity-50" disabled={busy} onClick={() => setConfirmDelete(true)}>
              刪除
            </button>
          )}
          <RevertToAutoButton legId={leg.id} onChanged={onChanged} />
        </div>
      )}
    </li>
  )
}

export default function TripView({
  trip,
  stops,
  stopsError,
  legs,
  canEdit,
  currentUserId,
  displayName,
  autoPlay = false,
  candidates,
  candidatesError,
}: {
  trip: Trip
  stops: Stop[]
  stopsError?: boolean
  legs: Leg[]
  /** Task 5：viewer 唯讀化——page.tsx 查 trip_members role 算出，false 時隱藏全部編輯入口且不打 sync */
  canEdit: boolean
  /** Task 11：目前登入者的 id/顯示名稱，供 TripRealtime 忽略自己的寫入事件與 presence track。
   *  canEdit=false（viewer/分享頁）不掛載 TripRealtime 時不會用到，宣告為可選讓分享頁沿用既有呼叫方式 */
  currentUserId?: string
  displayName?: string
  /** Task 8（spec §5「分享連結預設進播放模式」）：分享頁掛載時直接進播放模式。惰性 useState 初始化
   *  （避免 set-state-in-effect lint——本專案已兩度踩過），不開額外 effect */
  autoPlay?: boolean
  /** 備選地點清單（由 page.tsx 併發查詢帶入） */
  candidates: Candidate[]
  candidatesError?: boolean
}) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null)
  /** 正在手繪路徑的交通段 id；非 null 即為「路徑編輯模式」。這是一個**模式**而非啟發式判斷——
   *  編輯期間地圖的其他互動一律停用，避免與畫線的點擊/拖曳搶手勢（手機能用的關鍵，設計文件 §4）。 */
  const [routeEditingLegId, setRouteEditingLegId] = useState<string | null>(null)
  /** 剛存下的手繪路徑（C-1 樂觀覆寫，比照 pendingShift 的樣式）：router.refresh() 落地前，
   *  props 的 leg.custom_path 還是舊值。少了這層，「存檔後立刻再進編輯器」會讀到空的路徑，
   *  再存一次就把剛畫的整條蓋掉——審查實測過的靜默資料遺失。props 追上後於 render 期比對清除。 */
  const [pendingCustomPath, setPendingCustomPath] =
    useState<{ legId: string; value: [number, number][] | null } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  // Task 11：Realtime 斷線狀態與在線成員——TripRealtime 是純邏輯元件，透過這兩個回呼把狀態交回
  // TripView 渲染（presence 頭像、斷線橫幅）與接線（寫入入口關閉，見下方 writesBlocked）
  const [disconnected, setDisconnected] = useState(false)
  const [peers, setPeers] = useState<PresencePeer[]>([])
  // 既有「讀取失敗即關閉寫入入口」通道（stopsError）與斷線暫停編輯共用同一條通道，不另造一套：
  // 兩者都代表「目前的本地基準不可信任/收不到旁人變動」，關閉寫入入口的理由相同
  const writesBlocked = Boolean(stopsError) || disconnected
  // M-1：拖曳提交（cascade_shift_stops RPC）成功到 refresh 落地間的過渡偏移預覽；moveStop 於 RPC 前設定，
  // 下面的 render 期比對觀察 stops 落地後清空（pendingShiftResolved），傳給 Timeline 算色塊 offset
  const [pendingShift, setPendingShift] = useState<PendingShift | null>(null)
  // 逾時保險用（見 moveStop）：generation 讓後到的拖曳作廢前一次計時器
  const shiftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shiftGenerationRef = useRef(0)
  // 卸載時清掉未觸發的計時器：React 19 已移除「unmounted component setState」警告，不清也不會有
  // console 噪音，但沒必要留一個最多 5 秒的 closure 在背景
  useEffect(() => () => {
    if (shiftTimerRef.current) clearTimeout(shiftTimerRef.current)
  }, [])
  // 預設顯示行程第一天；Timeline 的 Day 分頁點擊會切換它
  const [activeDay, setActiveDay] = useState<string>(() => tripDayKeys(trip.start_date, trip.end_date)[0])
  // autoPlay 初始值以第一天視窗推導：視窗不存在（行程還沒有停留點）則保持暫停，播放頭留 null
  const [playheadMs, setPlayheadMs] = useState<number | null>(() => {
    if (!autoPlay) return null
    const win = dayWindow(filterDayStops(stops, tripDayKeys(trip.start_date, trip.end_date)[0]))
    return win ? win.start : null
  })
  const [playing, setPlaying] = useState(() => {
    if (!autoPlay) return false
    return dayWindow(filterDayStops(stops, tripDayKeys(trip.start_date, trip.end_date)[0])) !== null
  })
  const busyRef = useRef(false)
  // 日別化（R-4）：原本只存 endsAt 數字，安全性完全依賴「addStop 永遠用 activeDay」這個前提。
  // 備選庫的「拼入行程」允許指定任意日期後該前提消失——把第 3 天的墊底基準拿去算第 1 天，
  // 會產出離譜時段。改帶 day 後，defaultSlotForDay 只在同日才套用墊底。
  const lastInsertedEndRef = useRef<{ day: string; endsAt: number } | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [draftPin, setDraftPin] = useState<{ lat: number; lng: number } | null>(null)
  const [draftName, setDraftName] = useState('')
  // 搜尋預覽（先看再決定加不加入，不寫 DB）：與 draftPin 互斥同一時間只顯示一張卡，視覺概念一致
  // （同一套灰 Pin + 名稱輸入 + 加入/取消），seq 遞增只為了讓每次新選點都強制重新掛載
  // PlacePreviewCard（換掉舊卡的內部 state，不留痕跡）
  const [searchPreview, setSearchPreview] = useState<(PlacePick & { seq: number }) | null>(null)
  const previewSeqRef = useRef(0)
  const [cameraTarget, setCameraTarget] = useState<{ lat: number; lng: number } | null>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const center = stops.length > 0 ? { lat: stops[0].lat, lng: stops[0].lng } : FALLBACK_CENTER

  // refresh 落地（真實列已涵蓋墊底基準）後歸零，讓後續預設時段計算回歸 props 真相。
  // 日別化後只比對「同一天」的停留點——別天的列即使結束時間更晚，也不代表這天的墊底已落地。
  useEffect(() => {
    const pending = lastInsertedEndRef.current
    if (!pending) return
    const landed = stops.some(
      s =>
        localDateKey(new Date(s.starts_at).getTime(), s.timezone) === pending.day &&
        new Date(s.ends_at).getTime() >= pending.endsAt,
    )
    if (landed) lastInsertedEndRef.current = null
  }, [stops])

  // M-1：pendingShift 落地偵測——被拖點的 starts_at 追上 baseline+delta 後清空，讓 Timeline 的色塊
  // offset 回歸 props 真相。不開新 effect 直接 setState（同下方 M-7 selectedLegId 清理踩過的
  // set-state-in-effect lint），改用 React 官方文件「Adjusting state when a prop changes」的
  // useState 追蹤前一輪 stops＋render 期間比對樣式——只在 stops 參照真的變動那一輪才比對一次
  const [prevStopsForShift, setPrevStopsForShift] = useState(stops)
  if (prevStopsForShift !== stops) {
    setPrevStopsForShift(stops)
    if (
      pendingShift &&
      pendingShiftResolved(pendingShift, stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime() })))
    ) {
      setPendingShift(null)
    }
  }

  // C-1 樂觀覆寫的清除：props 的 legs 追上剛存的值之後就不再需要覆寫。用「同一個 legs 參照只比對
  // 一次」的既有樣式（同上方 prevStopsForShift），不開 effect 直接 setState。
  const [prevLegsForPath, setPrevLegsForPath] = useState(legs)
  if (prevLegsForPath !== legs) {
    setPrevLegsForPath(legs)
    if (pendingCustomPath) {
      const landed = legs.find(l => l.id === pendingCustomPath.legId)
      // 比對「清洗後的點數與內容」而非原始 jsonb——DB 回來的是 number[][]，本地是 tuple，
      // 直接比參照或 JSON 字串都不可靠
      const landedPath = landed ? parseCustomPath(landed.custom_path) : []
      const expected = pendingCustomPath.value ?? []
      const same =
        landed !== undefined &&
        landedPath.length === expected.length &&
        landedPath.every((p, i) => p.lat === expected[i][0] && p.lng === expected[i][1])
      // leg 消失（協作者刪掉）也一併清除，避免永久掛著
      if (same || landed === undefined) setPendingCustomPath(null)
    }
  }

  const syncedRef = useRef(false)
  const syncInFlightRef = useRef(false) // I-2：同時只跑一個 in-flight sync 請求
  const legsRef = useRef(legs)
  legsRef.current = legs // 續跑鏈的 setTimeout 閉包會捕捉舊 render 的 legs，比對一律讀 ref 取當下值
  const syncQueuedRef = useRef(false) // I-2：in-flight 期間又有新觸發，併成一次補跑（不逐一排隊）
  const syncRoundRef = useRef(0) // I-3：續跑回合數，使用者觸發的全新 sync 會歸零，只有續跑本身遞增
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // I-3：續跑計時器
  const syncNoticeShownRef = useRef(false) // S-1：連線失敗提示只跳一次，避免每輪續跑都打擾使用者
  useEffect(() => {
    // Task 5：canEdit 為 false（viewer）時直接跳過，且不標記 syncedRef——若使用者在同一分頁內被
    // 升級為 editor（canEdit 由 false 轉 true 觸發這個 effect 重跑），仍能補上這一次掛載同步；
    // 已經同步過一次後 syncedRef 才鎖住，不會反覆觸發
    if (!canEdit || syncedRef.current) return
    syncedRef.current = true
    void syncLegs()
    return () => {
      // I-3：unmount 時清掉排隊中的續跑計時器，避免對已卸載的元件觸發後續 setState
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
    // syncLegs 透過 closure 讀最新 props/state，不需要讓這個 effect 隨它重跑（M-5）；canEdit 是唯一
    // 需要主動觀察的依賴
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit])

  // 交通段同步：結構比對 + 自動計算都在 server（金鑰不落 client）。
  // 失敗靜默：外部服務失敗不能阻止編輯（spec §6），下次寫入或重新整理會再試（HTTP 非 2xx 例外，S-1 跳一次提示）。
  // isRetry=true 代表這是 I-3 排程的續跑，不重置回合額度；使用者操作觸發的呼叫一律 isRetry=false（全新額度）。
  async function syncLegs(isRetry = false) {
    // Task 5（Important-4 根治核心）：viewer 從一開始就不打 sync——DB 的 is_trip_editor 早已擋下寫入
    // 與這支端點（403），但 client 仍主動觸發就會踩到 S-1「交通段暫時無法計算」的誤導提示；
    // canEdit 由 server 查 trip_members role 算出，直接在源頭掐掉，掛載 effect 與所有寫入後觸發點天然失效
    if (!canEdit) return
    if (syncInFlightRef.current) {
      syncQueuedRef.current = true // I-2：coalescing——已有請求在跑，這次觸發併入下一次補跑
      return
    }
    if (!isRetry) syncRoundRef.current = 0
    syncInFlightRef.current = true
    try {
      const res = await fetch(`/api/trips/${trip.id}/legs/sync`, { method: 'POST' })
      if (!res.ok) {
        // 403 防線二：canEdit 理論上已擋在上面，但角色可能在同一分頁 session 中被 owner 調整（尚未 refresh）；
        // 403 是權限問題不是暫時性故障，靜默處理，不套用 S-1 的錯誤提示（那段文案專指外部服務失敗）
        if (res.status === 403) return
        if (!syncNoticeShownRef.current) {
          syncNoticeShownRef.current = true
          setNotice({ kind: 'error', text: '交通段暫時無法計算' }) // S-1
        }
        return
      }
      const j: { changed?: boolean; legCount?: number; pending?: number; incomplete?: boolean } = await res.json()
      // C-1：legCount 對不上目前 props 拿到的 legs 筆數，即使這次 sync 自己沒有結構異動
      // （changed=false）也代表 client 的快照落後於 DB（例如併發 sync 已建立該 leg），一樣要 refresh
      if (j.changed || j.legCount !== legsRef.current.length) router.refresh()
      if ((j.pending ?? 0) > 0 || j.incomplete) {
        if (syncRoundRef.current < MAX_SYNC_ROUNDS) {
          syncRoundRef.current += 1
          syncTimerRef.current = setTimeout(() => void syncLegs(true), SYNC_RETRY_MS) // I-3：續跑
        }
      }
    } catch {
      // 網路失敗：交通段維持現狀，不打擾使用者
    } finally {
      syncInFlightRef.current = false
      if (syncQueuedRef.current) {
        syncQueuedRef.current = false
        // 補跑取代任何已排的續跑計時器，避免同時有兩條路徑各自觸發下一次 syncLegs
        if (syncTimerRef.current) {
          clearTimeout(syncTimerRef.current)
          syncTimerRef.current = null
        }
        void syncLegs() // 視為新一輪使用者觸發，回合額度重置
      }
    }
  }

  async function addStop(p: {
    name: string
    lat: number
    lng: number
    placeId: string | null
    isCustom: boolean
    category: StopCategory
    /** 目標日；省略時為當前 Day。備選庫的「拼入行程」會指定任意日期 */
    targetDay?: string
  }): Promise<boolean> {
    // Task 5：目前所有呼叫點都已被 canEdit 閘門擋住（PlaceSearch/草稿表單皆不渲染），這裡補一層與
    // syncLegs 對齊的防線二，避免日後新增呼叫點時繞過閘門
    if (!canEdit) return false
    if (busyRef.current) return false
    if (writesBlocked) return false // 讀取失敗或 Realtime 斷線時基準不可信/收不到旁人變動，關閉所有寫入入口（含草稿表單）
    busyRef.current = true
    setBusy(true)
    try {
      // 日別預設時段計算已抽成純函式（含 refTz 三段 fallback、空日當地 09:00、pending 墊底且只在同日套用）
      const targetDay = p.targetDay ?? activeDay
      const slot = defaultSlotForDay(
        stops,
        targetDay,
        lastInsertedEndRef.current,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        stayMsForCategory(p.category),
      )

      let timezone = 'UTC'
      try {
        timezone = tzlookup(p.lat, p.lng)
      } catch {
        // 海上或極端座標查不到時區時保持 UTC
      }

      const supabase = createClient()
      const { error } = await supabase.from('stops').insert({
        trip_id: trip.id,
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        place_id: p.placeId,
        is_custom: p.isCustom,
        category: p.category,
        timezone,
        starts_at: new Date(slot.startsAt).toISOString(),
        ends_at: new Date(slot.endsAt).toISOString(),
      })
      if (error) {
        setNotice({
          kind: 'error',
          text: error.code === '23514' ? '加入失敗：名稱長度或數值不符限制' : '加入停留點失敗，請稍後再試',
        })
        return false
      }
      lastInsertedEndRef.current = { day: targetDay, endsAt: slot.endsAt }
      setNotice(null)
      setCameraTarget({ lat: p.lat, lng: p.lng }) // 鏡頭飛到剛加入的停留點
      // M-5：滿日加點時 defaultSlotForDay 可能把時段推過午夜落到隔日，activeDay 需跟隨實際落地日，
      // 否則使用者在原本那天看不到剛加的點。selectedId 一併重置——地圖標記的選取態不分日
      // （下方 stops.map 全量渲染），沒清掉會在別天的停留點上留一顆藍框選取（規格原文未列，但屬
      // 同一組視覺狀態，一併收斂，見下方 TripView 的地圖 Pin borderColor/scale）。
      // 不歸零 lastInsertedEndRef：連續加點的墊底基準要跨日延續。
      const landedDay = localDateKey(slot.startsAt, timezone)
      if (landedDay !== activeDay) {
        setActiveDay(landedDay)
        setSelectedId(null)
        setSelectedLegId(null)
        setPlayheadMs(null)
        setPlaying(false)
      }
      void syncLegs()
      router.refresh()
      return true
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /** 存入備選：不寫 stops、不佔時間軸，只把地點收進 trip_candidates 待日後決定。
   *  三重閘門與 addStop 對齊（canEdit 防線二、busyRef 同步 guard 防連點、writesBlocked 讀取失敗/斷線即關閉寫入）。 */
  async function saveCandidate(name: string, category: StopCategory): Promise<boolean> {
    if (!canEdit) return false
    if (busyRef.current) return false
    if (writesBlocked) return false
    if (!searchPreview) return false
    busyRef.current = true
    setBusy(true)
    try {
      const supabase = createClient()
      // 六欄，一個都不能多：created_by / created_at / id 不在欄位級 INSERT 白名單內，帶了會 42501
      const { error } = await supabase.from('trip_candidates').insert({
        trip_id: trip.id,
        name,
        lat: searchPreview.lat,
        lng: searchPreview.lng,
        place_id: searchPreview.place.id ?? '',
        category,
      })
      if (error) {
        // 錯誤碼翻成人話：使用者看到「23505」不知道那是什麼意思
        const text =
          error.code === '23505'
            ? '這個地點已在備選清單'
            : error.code === '23514'
              ? '名稱長度不符限制'
              : error.message?.includes('candidate_limit_reached')
                ? '備選已達上限 100 筆，請先拼入行程或刪除'
                : '存入備選失敗，請稍後再試'
        setNotice({ kind: 'error', text })
        return false // 失敗時保留預覽卡，讓使用者能改名重試
      }
      setSearchPreview(null)
      setNotice({ kind: 'success', text: '已存入備選 ✓' })
      router.refresh()
      return true
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /** 拼入行程：備選 → 正式停留點（移轉語意，不是複製）。
   *  刻意「先建後刪」而非原子交易：反序（先刪後建）若建立失敗會直接丟失使用者資料，
   *  這個方向最壞情況只是備選殘留、可手動刪除，永不丟資料（fail-safe）。 */
  async function promoteCandidate(c: Candidate, day: string): Promise<boolean> {
    const ok = await addStop({
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      placeId: c.place_id,
      isCustom: false,
      // 沿用備選自己的分類：使用者存入備選時已經確認過一次，拼入行程不該把它重設回 other
      category: c.category,
      targetDay: day,
    })
    if (!ok) return false // addStop 已設好 notice

    const supabase = createClient()
    const { error } = await supabase.from('trip_candidates').delete().eq('id', c.id)
    if (error) {
      setNotice({ kind: 'error', text: '已加入行程，但備選未移除，請手動刪除' })
    }

    // M-5：切日與播放/選取狀態重置已改由 addStop 內部統一處理（其算出的 landedDay 才是真正落地的那天——
    // 目標日已滿時 defaultSlotForDay 會推過午夜落到隔日，此處若仍用呼叫時的 day 覆寫，會在滿日情境下
    // 覆蓋回錯的日期）；這裡不重複判斷，避免兩份邏輯互踩
    setSelectedCandidateId(null)
    router.refresh()
    return true
  }

  // 時間軸拖曳平移提交：呼叫連鎖順延 RPC，後續未鎖定停留點原子化跟著移動（spec §6）
  async function moveStop(stopId: string, deltaMs: number) {
    // Task 5：目前唯一呼叫點是 Timeline 的 onMove，已由 `canEdit ? moveStop : undefined` 收口，這裡補
    // 防線二，避免日後新增呼叫點時繞過閘門（與 syncLegs/addStop 對齊）
    if (!canEdit) return
    if (busyRef.current) {
      // M-3：busy 期間的拖曳提交原本靜默 return，使用者不知道為何沒反應；明確告知後再擋下
      setNotice({ kind: 'error', text: '另一項操作進行中，請稍候再拖曳' })
      return
    }
    if (writesBlocked) return // 讀取失敗或 Realtime 斷線時，寫入入口本來就整組關閉，維持靜默
    busyRef.current = true
    setBusy(true)
    try {
      // M-1：baseline 取自 RPC 呼叫當下（位移發生前）被拖點的 starts_at，語義對齊 RPC 的
      // v_changed_start；設定 pendingShift 後，RPC 成功到 refresh 落地前，Timeline 用它算出哪些
      // 色塊該加上 deltaMs 預覽，消除這段過渡期的回彈
      const changedStop = stops.find(s => s.id === stopId)
      if (changedStop) {
        setPendingShift({ changedStopId: stopId, deltaMs, baselineStartMs: new Date(changedStop.starts_at).getTime() })
        // 逾時保險（審查 Major）：pendingShiftResolved 只認得出「已落地」與「被拖點消失」，認不出
        // 「client baseline 與 server 讀到的 v_changed_start 不同」——協作者在 RPC 視窗內動過同一個
        // 點就會這樣，落地值永遠對不上。沒有這道保險，時間軸會長期顯示不存在的時間且只能靠重新整理。
        // 用 generation 讓後到的拖曳作廢前一次的計時器，避免舊 timer 清掉新的 pendingShift。
        const generation = ++shiftGenerationRef.current
        if (shiftTimerRef.current) clearTimeout(shiftTimerRef.current)
        shiftTimerRef.current = setTimeout(() => {
          if (shiftGenerationRef.current === generation) setPendingShift(null)
        }, PENDING_SHIFT_TIMEOUT_MS)
      }
      const supabase = createClient()
      const { error } = await supabase.rpc('cascade_shift_stops', {
        p_trip_id: trip.id,
        p_changed_stop_id: stopId,
        // RPC 的單位契約是秒；deltaMs 為毫秒，四捨五入換算（spec §8 記錄此單位差異）
        p_delta_seconds: Math.round(deltaMs / 1000),
      })
      if (error) {
        setNotice({ kind: 'error', text: '時間調整失敗，請稍後再試' })
        setPendingShift(null) // 失敗不會有 refresh 落地可觀察，預覽偏移須主動清空，否則永久卡在偏移位置
        return
      }
      setNotice(null)
      setSelectedId(null) // 拖曳連鎖成功：關閉編輯器，避免舊值（starts_at/ends_at）殘留在表單裡被誤存回去覆寫連鎖結果
      void syncLegs()
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 切換 Day：連動重置播放頭、播放狀態，並清空選取（舊選取可能不在新的一天，側欄已過濾看不到編輯器）
  function changeDay(day: string) {
    setActiveDay(day)
    setSelectedId(null)
    setSelectedLegId(null)
    setPlayheadMs(null)
    setPlaying(false)
    // 加點基準不再於此歸零：ref 已帶 day，defaultSlotForDay 只在同日才套用墊底，跨日天然無效。
    // 保留歸零反而會讓「promote 到他日後切回原本那天」失去仍然有效的墊底基準。
  }

  const dayKeys = tripDayKeys(trip.start_date, trip.end_date)
  const selectedCandidate = candidates.find(c => c.id === selectedCandidateId) ?? null
  // 側欄只顯示當前 Day 的停留點，編號沿用當日順序
  const activeDayStops = filterDayStops(stops, activeDay)

  // leg 歸屬「from 停留點所屬日」：後繼者取全行程順序，跨夜段顯示在出發日末尾（M-4）
  // 用 globalThis.Map：本檔已從 @vis.gl/react-google-maps import 了元件 Map，會遮蔽內建建構子
  // （Task 3：宣告上移到 activeDayStops 之後，供下方分段推導使用——純常量推導，只依賴 stops/legs
  //  props，上移不改變任何既有語義，中間沒有其他程式碼在此之前用到它們）
  // useMemo（非普通宣告，2026-08-04 總審 M-2）：下面 routeLegs 的 useMemo 把 nextByStopId 列進
  // deps，若這裡每次 render 都給新的 Map 參照，routeLegs 會跟著每次 render（含每秒播放 tick）重建
  // 新陣列，RoutePolylines 收到新的 legs prop 參照又會觸發它內部 effect 全量拆建 overlays——
  // 只在 stops 真的變動時才重建，理由與下面 stopById 相同
  const nextByStopId = useMemo(
    () => new globalThis.Map(
      adjacentPairs(stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime() })))
        .map(([f, t]) => [f.id, t.id]),
    ),
    [stops],
  )
  // useMemo（非普通宣告）：下面 travelPath 的 useMemo 把 stopById 列進 deps，若這裡每次 render 都給
  // 新的 Map 參照，travelPath 會跟著每秒重算、失去「長 polyline 不逐秒重解」的 memo 效果（本來就是
  // 這顆 memo 存在的目的）；只在 stops 真的變動時才重建
  const stopById = useMemo(() => new globalThis.Map(stops.map(s => [s.id, s])), [stops])
  const legByPair = new globalThis.Map(legs.map(l => [`${l.from_stop_id}→${l.to_stop_id}`, l]))
  // Task 11：TripRealtime 的 DELETE 冪等比對用——本地已知 id 集合，只在 stops/legs 參照真的變動時重建
  const stopIdSet = useMemo(() => new Set(stops.map(s => s.id)), [stops])
  const legIdSet = useMemo(() => new Set(legs.map(l => l.id)), [legs])

  // 選中日地圖路線只畫「仍在行程順序中」的段：配對脫離（插入停留點/調整順序後）的 legs 不該畫上地圖，
  // 否則 flight 脫離段會畫成橫跨畫面、與正常段無法區分的紫色弧虛線（側欄 807 行的 detachedLegs 用同一
  // 相鄰性判準 nextByStopId.get(from)===to 定義脫離段，這裡對齊）。deps 只用穩定的 legs/stops/activeDay/
  // nextByStopId（皆已是 props 或上面的 memo），播放 tick 期間不變 → routeLegs 參照不變 → RoutePolylines
  // 的 legs prop 不換新參照 → 其內部 effect 不會每秒重跑、全量拆建 overlays（2026-08-04 總審 M-2）
  const routeLegs = useMemo(() => {
    const activeDayStopIds = new Set(filterDayStops(stops, activeDay).map(s => s.id))
    return legs.filter(l => activeDayStopIds.has(l.from_stop_id) && nextByStopId.get(l.from_stop_id) === l.to_stop_id)
  }, [legs, stops, activeDay, nextByStopId])

  // 正在手繪路徑的那一段（含其起訖停留點座標，供 RouteEditor 與圖釘高亮使用）
  const editingLegRaw = routeEditingLegId ? (legs.find(l => l.id === routeEditingLegId) ?? null) : null
  // C-1：refresh 落地前用剛存下的值覆寫，避免「存完立刻再進編輯器」讀到舊的空路徑
  const editingLeg =
    editingLegRaw && pendingCustomPath?.legId === editingLegRaw.id
      ? { ...editingLegRaw, custom_path: pendingCustomPath.value }
      : editingLegRaw
  const editingFrom = editingLeg ? stopById.get(editingLeg.from_stop_id) : undefined
  const editingTo = editingLeg ? stopById.get(editingLeg.to_stop_id) : undefined
  /** 編輯模式是否**實際生效**（審查 M-3）。所有互動閘門一律讀這個衍生布林，不讀 routeEditingLegId
   *  ——協作者刪掉停留點會 FK cascade 掉 leg，此時 RouteEditor 卸載但 id 還留著；閘門若讀 id
   *  就會把地圖永久鎖死（實測：右鍵開不了草稿、圖釘淡化、沒有任何出口可按取消，只能重新整理）。
   *  讀衍生布林則 leg 一消失閘門就自動解除，殘留 id 無害。
   *
   *  ⚠️ **這個條件必須與下方 RouteEditor 的掛載條件逐字相同**（審查 N-1，實測復現）：第一版漏了
   *  `canEdit && !writesBlocked`，於是權限被降級（owner 把 editor 改成 viewer）或 Realtime 斷線時，
   *  RouteEditor 卸載而閘門續留——播放鈕還提示「畫路徑中，請先儲存或取消」，但畫面上根本沒有
   *  可以儲存或取消的東西。同一種鎖死換個入口又回來。兩處讀同一個布林才不會再分岔。 */
  const routeEditing =
    canEdit && !writesBlocked &&
    editingLeg !== null && editingFrom !== undefined && editingTo !== undefined

  const win = dayWindow(activeDayStops)
  // 播放頭可能因資料變動（拖曳/刪除當日停留點後視窗縮小）落在目前視窗之外；顯示前一律夾回視窗內，
  // 避免地圖「我」標記與時間軸的滑桿/畫線互相矛盾
  const clampedPlayheadMs = playheadMs === null || !win ? null : Math.min(Math.max(playheadMs, win.start), win.end)
  // posStops 抽成共用：播放位置（interpolatePosition）與分段判定（segmentAt）同吃一份，不各自 map 一次
  const posStops = activeDayStops.map(s => ({
    id: s.id,
    lat: s.lat,
    lng: s.lng,
    startsAt: new Date(s.starts_at).getTime(),
    endsAt: new Date(s.ends_at).getTime(),
  }))
  // 播放位置提到 component body：地圖「我」標記與 PlaybackCamera（M-7 鏡頭跟隨）共用同一份，不各算一次
  const playheadPos = clampedPlayheadMs === null ? null : interpolatePosition(posStops, clampedPlayheadMs)

  // 當前播放分段：stay（停留中）或 travel（交通中）。travel 時查對應 leg 取 mode 與 polyline，
  // 位置沿路線取位（有 polyline 走實路徑、flight 走大圓弧、其餘直線），取代單純兩點直線內插
  const segment = clampedPlayheadMs === null ? null : segmentAt(posStops, clampedPlayheadMs)
  // travel 段的識別 key：下面 segmentKey（completedPaths 的 memo key）與呼叫 PlaybackCamera 的
  // segmentFitKey prop 共用同一份拼接，不在兩處各自手打 `travel:${fromStopId}`（2026-08-04 總審建議）
  const travelFitKey = segment?.kind === 'travel' ? `travel:${segment.fromStopId}` : null
  const travelLeg =
    segment?.kind === 'travel' ? (legByPair.get(`${segment.fromStopId}→${segment.toStopId}`) ?? null) : null
  // 路徑解碼在 render body 每秒發生一次，長 polyline 需 memo（key：leg id + 座標端點）。
  // 優先序（手繪 → Google → flight 大圓弧 → null）收斂在 resolveRoutePath，與 RoutePolylines
  // 及下方 completedPaths 共用同一份語義，不各寫一份而漂移
  const travelPath = useMemo(() => {
    if (!travelLeg) return null
    const from = stopById.get(travelLeg.from_stop_id)
    const to = stopById.get(travelLeg.to_stop_id)
    if (!from || !to) return null
    return resolveRoutePath(travelLeg, { lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng })
  }, [travelLeg, stopById])
  const travelPos = segment?.kind === 'travel' && travelPath ? pathPosition(travelPath, segment.progress) : null
  const playheadDisplayPos = travelPos ?? playheadPos // travelPos 缺料時退回既有直線內插

  // 進行中交通段的完整路徑：PlaybackCamera 分段取景（Task 4）與 PlaybackTrail 進行中紅線（Task 3）
  // 共用同一份，避免兩處各自重複同一段 fallback（缺 polyline 的地面段退回兩點直線，與
  // playheadDisplayPos 的直線內插語義一致）
  const currentTravelPath =
    segment?.kind === 'travel'
      ? (travelPath ??
          (() => {
            const f = stopById.get(segment.fromStopId)
            const t = stopById.get(segment.toStopId)
            return f && t ? [{ lat: f.lat, lng: f.lng }, { lat: t.lat, lng: t.lng }] : null
          })())
      : null

  // 播放鏡頭 fitBounds 用的當日停留點座標（M-7 修復）：只傳原始點陣列，不在這裡用 Math.min/max 化簡成
  // min/max——跨 180 度經線時 min/max 會反向算出錯誤的框。真正安全的 LatLngBounds 建構（逐點 extend）
  // 只能在 google.maps 腳本載入後執行，這裡是 render 期間（含 SSR）碰不到 google 全域，故挪到
  // PlaybackCamera 的 effect 裡處理
  const playbackBounds = activeDayStops.length > 0 ? activeDayStops.map(s => ({ lat: s.lat, lng: s.lng })) : null

  // 已走完的段落路徑：當日順序中，結束時刻早於當前分段起點的每一段。逐秒重算浪費（每段路徑固定），
  // memo key 取「當前所在分段的識別」——換段才重算
  // travelFitKey! 安全：這個分支已由 segment.kind !== 'stay'（PlaybackSegment 只有 stay/travel 兩種）
  // 縮限到 segment.kind === 'travel'，travelFitKey 的判斷式與此同條件，保證非 null
  const segmentKey =
    segment === null ? 'none' : segment.kind === 'stay' ? `stay:${segment.stopId}` : travelFitKey!
  const completedPaths = useMemo(() => {
    if (clampedPlayheadMs === null) return []
    const ordered = [...posStops].sort((a, b) => a.startsAt - b.startsAt)
    const out: LatLng[][] = []
    for (let i = 0; i < ordered.length - 1; i++) {
      const from = ordered[i]
      const to = ordered[i + 1]
      if (to.startsAt > clampedPlayheadMs) break // 這段還沒走完（含進行中——由 currentPath 負責）
      const leg = legByPair.get(`${from.id}→${to.id}`)
      const fromPos = { lat: from.lat, lng: from.lng }
      const toPos = { lat: to.lat, lng: to.lng }
      // 與 travelPath／RoutePolylines 共用 resolveRoutePath（2026-08-10：此處原本是第二份重複的
      // fallback 實作，未走 travelPath，加手繪路徑時一併收斂，避免三份語義各自漂移）
      out.push((leg ? resolveRoutePath(leg, fromPos, toPos) : null) ?? [fromPos, toPos])
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 逐秒變動的 clampedPlayheadMs 刻意不入 deps，換段（segmentKey）才需要重算
  }, [segmentKey, activeDay, stops, legs])

  // interval callback 需要「最新」playheadMs 但不能把它放進 effect deps（每次都變會重開計時器），故用 ref 讀取
  const playheadMsRef = useRef(playheadMs)
  useEffect(() => {
    playheadMsRef.current = playheadMs
  }, [playheadMs])

  // 播放中：每秒將播放頭推進 10 分鐘；超出當日視窗尾端、或當日視窗已不存在（停留點被刪除/移走）即自動停止。
  // 滑桿本身以 min/max 限制在視窗內（見 Timeline），只有這裡的自動推進會超出，故一併在此判斷，
  // 避免另開一個「監看 playheadMs 變化」的 effect 在其函式體內直接呼叫 setState（觸發連鎖渲染的 lint 錯誤）。
  // tick 前先把 playheadMs 夾回當下視窗再推進：若播放中途視窗變動（拖曳/刪除當日停留點）導致舊值落在視窗外，
  // 也能自行收斂回視窗內，不必等使用者手動介入。
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const prev = playheadMsRef.current
      const tickWin = dayWindow(filterDayStops(stops, activeDay))
      if (prev === null || !tickWin) {
        setPlaying(false)
        return
      }
      const clamped = Math.min(Math.max(prev, tickWin.start), tickWin.end)
      const next = clamped + PLAY_STEP_MS
      if (next > tickWin.end) {
        setPlaying(false)
        return
      }
      playheadMsRef.current = next
      setPlayheadMs(next)
    }, 1000)
    return () => clearInterval(timer)
  }, [playing, stops, activeDay])

  // 播放 session 序號（2026-08-04 總審 M-3）：只在「從頭開始播放」（播放頭原本是 null，或即將
  // wrap 回視窗起點）時遞增，暫停後恢復（播放頭停在原地繼續）不遞增。傳給 PlaybackCamera 的
  // daySessionKey（`${activeDay}:${序號}`）讓它判斷整日 fitBounds 該不該重來——同一 session 已經
  // fit 過全景，暫停恢復時鏡頭應該留在原地（可能已被分段取景收到某段路線），不是彈回全景。
  // 切 Day 天然是新 session，不需要在 changeDay/promoteCandidate 額外遞增：key 的 activeDay
  // 前綴本身就會換掉
  const playSessionRef = useRef(0)

  // 播放/暫停切換：暫停中按下才可能開始播放。起播時一律把播放頭夾回目前視窗內，
  // 已在（或超過）視窗尾端則歸零到視窗起點——不論播放頭是初次設定、還是資料變動後落在視窗外，
  // 畫面都立刻對齊即將播放的位置，不必等下一次 tick 才收斂。
  function togglePlay() {
    if (playing) {
      setPlaying(false)
      return
    }
    if (!win) return
    const clamped = playheadMs === null ? win.start : Math.min(Math.max(playheadMs, win.start), win.end)
    const wrapped = clamped + PLAY_STEP_MS > win.end
    if (playheadMs === null || wrapped) playSessionRef.current += 1
    setPlayheadMs(wrapped ? win.start : clamped)
    setPlaying(true)
  }

  // Important-2 根治：配對脫離（插入停留點/調整順序）的 legs 不再出現在上面的正常交通列（legByPair
  // 命中不到），過去因此從畫面消失；改收進側欄專屬區塊，過濾出 from 停留點屬 activeDay 者（歸屬規則同 M-4）
  const detachedLegs = legs
    .filter(l => nextByStopId.get(l.from_stop_id) !== l.to_stop_id)
    .filter(l => activeDayStops.some(s => s.id === l.from_stop_id))

  // Important-3 根治：Timeline 連接條與側欄交通列的「趕不上」警示同讀這份單一計算來源（審查 M-4）
  const dayView = buildDayView(activeDayStops, stops, legs)

  // M-7：selectedLegId 若指向已從 legs 消失的段（結構同步移除/重建），清空選取避免殘留 dangling id。
  // 不開新 effect 直接 setState（同 line 296 註解提到的 set-state-in-effect lint），改用 React 官方文件
  // 「Adjusting state when a prop changes」的 useState 追蹤前一輪值＋render 期間比對樣式——
  // 只在 legs 參照真的變動那一輪才比對一次
  const [prevLegs, setPrevLegs] = useState(legs)
  if (prevLegs !== legs) {
    setPrevLegs(legs)
    if (selectedLegId !== null && !legs.some(l => l.id === selectedLegId)) setSelectedLegId(null)
  }

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Task 11：viewer/分享頁（canEdit=false）不掛載——唯讀者用手動刷新即可，省 anon realtime 授權面
          （spec §6 Step 3）。TripRealtime 是純邏輯元件，presence/斷線狀態透過回呼交回這裡渲染 */}
      {canEdit && currentUserId && displayName && (
        <TripRealtime
          tripId={trip.id}
          userId={currentUserId}
          displayName={displayName}
          stopIds={stopIdSet}
          legIds={legIdSet}
          onDisconnectedChange={setDisconnected}
          onPeersChange={setPeers}
        />
      )}
      {disconnected && (
        <p className="border-b bg-amber-50 p-2 text-sm text-amber-700">
          ⚠️ 連線中斷，他人改動暫時看不到，編輯功能已暫停
        </p>
      )}
      {peers.length > 0 && (
        <div className="flex items-center gap-1 border-b p-2">
          {peers.map(p => (
            <span
              key={p.userId}
              title={p.displayName}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white"
            >
              {/* C-1 止血第二層防禦：peers 在 TripRealtime 已過型別守衛，這裡是渲染端再退一步，
                  即使上游守衛日後被誤改壞也不會讓整頁崩潰 */}
              {(p.displayName || '?').slice(0, 1)}
            </span>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* 手機（< md）上下堆疊：側欄改滿寬、上限 38vh 內部捲動（overflow-y-auto 已存在），
            讓 flex-1 的地圖區塊自動吃下剩餘高度，不需要另外幫地圖寫死高度（見下方地圖容器）。
            桌機（md 以上）維持原本 320px 固定寬側欄 + 左右並排，外觀與行為完全不變。 */}
        <aside className="max-h-[38vh] w-full overflow-y-auto border-b p-3 md:max-h-none md:w-80 md:shrink-0 md:border-b-0 md:border-r">
          {/* !routeEditing（審查 M-5）：畫路徑期間側欄的寫入入口一律收起——避免使用者在畫線中途
              加停留點／改時間，那些操作會改動正在編輯那段的起訖點，讓畫到一半的路徑語義破碎 */}
          {canEdit && apiKey && !writesBlocked && !routeEditing && (
            <PlaceSearch
              onPick={p => {
                previewSeqRef.current += 1
                setDraftPin(null) // 互斥：新的搜尋預覽取代地圖右鍵草稿，避免兩張卡同時掛著
                setDraftName('')
                setSearchPreview({ ...p, seq: previewSeqRef.current })
                setCameraTarget({ lat: p.lat, lng: p.lng }) // 鏡頭飛過去，落地圖預覽釘見下方 AdvancedMarker
              }}
              onError={text => setNotice({ kind: 'error', text })}
              disabled={busy}
            />
          )}
          {canEdit && searchPreview && !writesBlocked && !routeEditing && (
            <PlacePreviewCard
              key={searchPreview.seq}
              place={searchPreview.place}
              initialName={searchPreview.name}
              initialCategory={searchPreview.category}
              lat={searchPreview.lat}
              lng={searchPreview.lng}
              busy={busy}
              onAdd={async (name, category) => {
                const ok = await addStop({
                  name,
                  lat: searchPreview.lat,
                  lng: searchPreview.lng,
                  placeId: searchPreview.place.id,
                  isCustom: false,
                  category,
                })
                if (ok) setSearchPreview(null) // 成功後清掉預覽；失敗維持原樣讓使用者能重試
                return ok
              }}
              onSaveCandidate={saveCandidate}
              onCancel={() => setSearchPreview(null)}
            />
          )}
          {canEdit && draftPin && !writesBlocked && !routeEditing && (
            <form
              className="flex gap-1 rounded border p-2"
              onSubmit={async e => {
                e.preventDefault()
                const name = draftName.trim()
                if (!name) return
                // 地圖右鍵自訂地點沒有 Google 分類資料可推導，一律歸類 other
                const ok = await addStop({ name, lat: draftPin.lat, lng: draftPin.lng, placeId: null, isCustom: true, category: 'other' })
                if (ok) {
                  setDraftPin(null)
                  setDraftName('')
                }
              }}
            >
              <input
                className="min-w-0 flex-1 rounded border p-1 text-sm"
                placeholder="自訂地點名稱"
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                autoFocus
                maxLength={200}
              />
              <button className="rounded bg-foreground px-2 text-sm text-background" type="submit" disabled={busy}>
                加入
              </button>
              <button
                className="rounded border px-2 text-sm"
                type="button"
                onClick={() => {
                  setDraftPin(null)
                  setDraftName('')
                }}
              >
                取消
              </button>
            </form>
          )}
          {notice && (
            <p className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
          )}
          <ul className="flex flex-col gap-2">
            {activeDayStops.map((stop, i) => {
              const next = stopById.get(nextByStopId.get(stop.id) ?? '')
              const leg = next ? legByPair.get(`${stop.id}→${next.id}`) : undefined
              const crossDay = Boolean(next && !activeDayStops.some(s => s.id === next.id))
              // Important-3 根治：趕不上警示——命中 dayView.tightPairs 時，兩個數值取自對應的
              // warning 物件（非重新計算），gapMinutes 可能是小數，顯示前四捨五入
              const tightWarning = next
                ? dayView.warnings.find(
                    (w): w is Extract<typeof w, { type: 'transit_too_tight' }> =>
                      w.type === 'transit_too_tight' && w.fromStopId === stop.id && w.toStopId === next.id,
                  )
                : undefined
              return (
                <Fragment key={stop.id}>
                  <li
                    className={`rounded border p-2 ${selectedId === stop.id ? 'border-blue-500' : ''}`}
                  >
                    <button
                      type="button"
                      className="block w-full cursor-pointer text-left"
                      onClick={() => {
                        const selecting = selectedId !== stop.id
                        setSelectedId(selecting ? stop.id : null)
                        // 畫路徑中不移鏡頭（審查 N-3，實測位移 134px）：選取本身無害，但把畫布
                        // 從使用者手下移走，跟停用播放鈕要防的是同一種傷害
                        if (selecting && !routeEditing) setCameraTarget({ lat: stop.lat, lng: stop.lng })
                      }}
                    >
                      <span className="mr-1 text-xs text-gray-400">{i + 1}.</span>
                      <span className="mr-1 text-xs text-gray-400">
                        {formatLocalTime(new Date(stop.starts_at).getTime(), stop.timezone)}
                      </span>
                      <span className="mr-1">{CATEGORY_ICON[normalizeCategory(stop.category)]}</span>
                      <span className="font-medium">{stop.name}</span>
                    </button>
                    {/* M-3（critic 審查）：writesBlocked 走同一條 canEdit 通道——斷線/讀取失敗時整顆
                        編輯器連同任何已開啟的「確認刪除」狀態一併卸載，寫入路徑物理上不可能被觸發，
                        不需要在 StopEditor 內部另加守衛 */}
                    {canEdit && !writesBlocked && !routeEditing && selectedId === stop.id && (
                      <StopEditor
                        key={stop.id}
                        stop={stop}
                        currency={trip.currency}
                        onDeleted={() => setSelectedId(null)}
                        onChanged={() => void syncLegs()}
                      />
                    )}
                  </li>
                  {leg && next && (
                    <li className="pl-5 text-xs">
                      <button
                        type="button"
                        aria-pressed={selectedLegId === leg.id}
                        className={`cursor-pointer ${
                          tightWarning ? 'text-red-600' : selectedLegId === leg.id ? 'font-medium text-blue-600' : 'text-gray-500'
                        }`}
                        onClick={() => setSelectedLegId(selectedLegId === leg.id ? null : leg.id)}
                      >
                        {MODE_ICON[leg.mode]} {legDurationText(leg)}
                        {/* 已自訂路徑標記：讓使用者一眼看出哪幾段動過手繪，不必逐段點開確認 */}
                        {parseCustomPath(leg.custom_path).length > 0 && ' ✏️'}
                        {leg.estimated_cost !== null && ` · ${trip.currency} ${leg.estimated_cost}`}
                        {crossDay && ` → ${localDateKey(new Date(next.starts_at).getTime(), next.timezone).slice(5)} ${next.name}`}
                        {leg.stale && ' ⚠️ 前後行程變動過，可能過期'}
                        {tightWarning &&
                          // gapMinutes < requiredMinutes 恆成立（detectConflicts 的判定條件），四捨五入可能把
                          // 44.6 分進位成 45 分，顯示出「45 分＜45 分」自相矛盾的句子；改用無條件捨去，
                          // floor(gap) < requiredMinutes 對整數 requiredMinutes 永遠成立，不等式恆自洽
                          // M-3：isNoTransitData 段的 requiredMinutes 是步行估算而非大眾運輸班次時間，
                          // 警示文案需明確標註，否則像九州這種 Routes API 不支援大眾運輸的地區會整條
                          // 時間軸誤報趕不上
                          ` ⚠ 趕不上：空檔 ${Math.floor(tightWarning.gapMinutes)} 分＜交通 ${tightWarning.requiredMinutes} 分${
                            isNoTransitData(leg) ? '（步行估算）' : ''
                          }`}
                      </button>
                      {canEdit && !writesBlocked && !routeEditing && leg.source === 'manual' && (
                        <span className="ml-1">
                          <RevertToAutoButton legId={leg.id} onChanged={() => void syncLegs()} />
                        </span>
                      )}
                      {canEdit && !writesBlocked && !routeEditing && selectedLegId === leg.id && (
                        <LegEditor
                          key={leg.id}
                          leg={leg}
                          fromStop={stop}
                          toStop={next}
                          currency={trip.currency}
                          onChanged={() => void syncLegs()}
                          onDrawPath={() => {
                            // 播放與畫線搶同一個地圖，不可並存（設計文件 §4 邊界情況）
                            setPlaying(false)
                            setRouteEditingLegId(leg.id)
                          }}
                        />
                      )}
                    </li>
                  )}
                </Fragment>
              )
            })}
            {activeDayStops.length === 0 && (
              <li className="text-sm text-gray-500">
                {stopsError
                  ? '停留點讀取失敗，請重新整理再試'
                  : canEdit
                    ? '還沒有停留點，用上方搜尋加入第一個景點'
                    : '這個行程還沒有停留點'}
              </li>
            )}
          </ul>
          {/* 花費分類摘要（Plan 7 Task 8 的元件，此處掛載）：全行程七桶，不只當日 */}
          <CostSummary
            stops={stops.map(s => ({ category: normalizeCategory(s.category), estimatedCost: s.estimated_cost }))}
            legs={legs.map(l => ({ estimatedCost: l.estimated_cost }))}
            currency={trip.currency}
          />
          {detachedLegs.length > 0 && (
            <details className="mt-2 rounded border p-2" open>
              <summary className="cursor-pointer text-sm font-medium">
                已脫離順序的交通段（{detachedLegs.length}）
              </summary>
              <ul className="mt-2 flex flex-col gap-2">
                {detachedLegs.map(l => {
                  const from = stopById.get(l.from_stop_id)
                  const to = stopById.get(l.to_stop_id)
                  if (!from || !to) return null
                  return (
                    <DetachedLegRow
                      key={l.id}
                      leg={l}
                      fromStop={from}
                      toStop={to}
                      currency={trip.currency}
                      canEdit={canEdit && !writesBlocked && !routeEditing}
                      onChanged={() => void syncLegs()}
                    />
                  )
                })}
              </ul>
            </details>
          )}
          <CandidatesPanel
            candidates={candidates}
            loadError={Boolean(candidatesError)}
            canEdit={canEdit && !writesBlocked && !routeEditing}
            busy={busy}
            dayKeys={dayKeys}
            activeDay={activeDay}
            selectedCandidateId={selectedCandidateId}
            onFocus={c => {
              // 不清 searchPreview / draftPin：三者語義不同（備選是已存的、預覽是待決定的、
              // 草稿是自訂地點），同時存在不衝突
              setSelectedCandidateId(c.id)
              setCameraTarget({ lat: c.lat, lng: c.lng })
            }}
            onPromote={promoteCandidate}
          />
        </aside>
        {/* min-h-[160px]（僅手機）：側欄在極短螢幕上被壓到接近 0 時，地圖仍保有可用的最小高度，
            不會整個被擠到看不見；md:min-h-0 還原成桌機原本的值，避免這個安全下限在桌機的極端矮視窗
            （例如瀏覽器被縮到很矮）改變原本「地圖可以被壓到 0」的行為，確保桌機零變化。
            flex-1 本身在 row（桌機）與 col（手機）兩種方向下都會自動吃下側欄以外的剩餘空間，
            兩種斷點共用同一組 flex-1，不需要另外寫死 vh 高度。 */}
        <div className="min-h-[160px] flex-1 md:min-h-0">
          {apiKey ? (
            <SectionErrorBoundary message="地圖載入失敗（可能是金鑰或網路問題），行程資料仍可正常編輯">
              <Map
                defaultCenter={center}
                defaultZoom={12}
                mapId={MAP_ID}
                // 手勢策略決策（手機版面陷阱）：改成上下堆疊後地圖橫跨全寬，若維持會捲頁的單指手勢，
                // 使用者想滑向下方時間軸/側欄會被地圖吃掉。這裡選 (b) 而非 (a) cooperative：
                // 本頁殼層本來就是 h-screen 固定版面、不存在「頁面捲動」這件事（page.tsx 的 <main>
                // 用 h-screen，TripView 外層是 min-h-0 flex-1）——桌機原本就沒有整頁捲動、只有側欄
                // 自己的 overflow-y-auto。手機版把地圖用 flex-1 限制在剩餘高度內、側欄補上 max-h-[38vh]
                // 上限捲動，三個區塊（側欄／地圖／時間軸）在同一個螢幕內各自可見、各自捲動，本來就不需要
                // 使用者「滑過地圖」才能看到下一段內容，因此不必犧牲地圖雙指以外的手勢；也順帶避開了
                // 依視窗寬度切換 gestureHandling 需要在 client 用 JS 判斷寬度、可能造成 SSR/hydration
                // 不一致的風險（純 CSS 斷點即可解決，不需要 JS 介入）。桌機行為原封不動。
                gestureHandling="greedy"
                disableDefaultUI={false}
                onContextmenu={e => {
                  // 路徑編輯模式停用：編輯期間地圖屬於畫線，不該同時開自訂地點草稿（設計文件 §4）
                  if (!canEdit || writesBlocked || routeEditing) return
                  const latLng = e.detail.latLng
                  if (latLng) {
                    setSearchPreview(null) // 互斥：右鍵開自訂草稿時取代掉搜尋預覽
                    setDraftPin({ lat: latLng.lat, lng: latLng.lng })
                  }
                }}
              >
                {stops.map(stop => {
                  // 地圖標記照樣渲染全行程，但編號與配色改為「當日視角」：當日 = 紅底 + 當日編號，他日 = 灰底無編號
                  const dayIdx = activeDayStops.findIndex(s => s.id === stop.id)
                  const inActiveDay = dayIdx >= 0
                  // 路徑編輯模式：其他圖釘淡化縮小讓出視覺焦點，但**正在編輯那一段的起訖兩點高亮**
                  // ——使用者要知道自己在從哪畫到哪（需求方選擇「淡化保留」而非全部隱藏，理由是
                  // 保有方向感、不會畫完才發現跟鄰段對不起來）
                  const isRouteEndpoint =
                    editingLeg !== null && (stop.id === editingLeg.from_stop_id || stop.id === editingLeg.to_stop_id)
                  const dimmedPin = routeEditing && !isRouteEndpoint
                  return (
                    <AdvancedMarker
                      key={stop.id}
                      position={{ lat: stop.lat, lng: stop.lng }}
                      onClick={() => {
                        // 路徑編輯模式停用（設計文件 §4）：此處原本沒有任何閘門，編輯時點到圖釘會
                        // 切換日期、把正在畫的那一段整個換掉
                        if (routeEditing) return
                        // 只有點到不同 Day 的停留點才切換：同日點擊維持播放頭與加點基準不被重置
                        const day = localDateKey(new Date(stop.starts_at).getTime(), stop.timezone)
                        if (day !== activeDay) changeDay(day)
                        setSelectedId(stop.id)
                      }}
                      title={stop.name}
                    >
                      {/* 狀態 × 分類雙重編碼（Plan 7 Task 6）：background 讓給分類色之後，原本靠它
                          承載的「選取／當日／他日」三態必須換載體——選取改用藍框、當日他日改用大小與
                          序號。序號是既有的順序資訊，不可因為改配色就弄丟。 */}
                      <Pin
                        background={CATEGORY_PIN_HEX[normalizeCategory(stop.category)]}
                        glyphColor="#fff"
                        borderColor={
                          isRouteEndpoint ? '#dc2626' : selectedId === stop.id ? '#2563eb' : '#fff'
                        }
                        scale={
                          isRouteEndpoint ? 1.3 : dimmedPin ? 0.5 : selectedId === stop.id ? 1.3 : inActiveDay ? 1.0 : 0.7
                        }
                      >
                        {inActiveDay && !dimmedPin ? <span className="text-xs font-bold">{dayIdx + 1}</span> : null}
                      </Pin>
                    </AdvancedMarker>
                  )
                })}
                {canEdit && !writesBlocked && !routeEditing && draftPin && (
                  <AdvancedMarker position={draftPin}>
                    <Pin background="#9ca3af" glyphColor="#fff" borderColor="#fff" />
                  </AdvancedMarker>
                )}
                {/* 選中的備選（橘）：與草稿/預覽的灰、停留點的紅/藍/灰區隔。
                    viewer 也看得到——點名稱聚焦是純讀取行為，不是寫入出口 */}
                {selectedCandidate && (
                  <AdvancedMarker position={{ lat: selectedCandidate.lat, lng: selectedCandidate.lng }} title={selectedCandidate.name}>
                    <Pin background="#f59e0b" glyphColor="#fff" borderColor="#fff" />
                  </AdvancedMarker>
                )}
                {canEdit && !writesBlocked && !routeEditing && searchPreview && (
                  <AdvancedMarker position={{ lat: searchPreview.lat, lng: searchPreview.lng }}>
                    <Pin background="#9ca3af" glyphColor="#fff" borderColor="#fff" />
                  </AdvancedMarker>
                )}
                {playheadDisplayPos && (
                  // anchorLeft/Top 置中：預設值 "-50%"/"-100%" 是底部中央（比照 Pin 針尖）。
                  // anchorLeft/anchorTop 是「錨點相對內容左上角的位移」，CENTER 要位移 -50%/-50%
                  // （不是 +50%，那會把錨點移到內容的右下角外側，偏移更大，見 AdvancedMarkerAnchorPoint.CENTER 的官方換算）。
                  // 圓點沒有針尖，需明確置中錨點，否則會系統性偏移半個標記高度
                  <AdvancedMarker position={playheadDisplayPos} title="目前時刻位置" anchorLeft="-50%" anchorTop="-50%">
                    {travelLeg && travelLeg.mode === 'flight' ? (
                      // SVG 飛機（emoji ✈️ 是 U+2708+FE0F，跨平台朝向不一且會退化黑白字元；SVG 朝向可控）。
                      // viewBox 內機頭朝上（北），rotate 直接用方位角。填色沿用 RoutePolylines 的 flight 色
                      // （#6b21a8，2026-08-04 總審 m-6 的 ΔE 重掃結果，見 RoutePolylines.tsx 註解）
                      <svg
                        width="28" height="28" viewBox="0 0 24 24"
                        style={{ transform: `rotate(${Math.round(travelPos?.headingDeg ?? 0)}deg)` }}
                        className="drop-shadow"
                      >
                        <path
                          d="M12 2 L14 9 L21 12 L14 13.5 L14 19 L16 21.5 L12 20 L8 21.5 L10 19 L10 13.5 L3 12 L10 9 Z"
                          fill="#6b21a8" stroke="#fff" strokeWidth="1"
                        />
                      </svg>
                    ) : travelLeg && travelLeg.mode !== 'custom' ? (
                      // 地面模式：emoji 徽章不旋轉（旋轉的行人/列車違反直覺）。🚇🚶🚗 預設 emoji 呈現，無 FE0F 問題
                      <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-white text-base shadow">
                        {MODE_ICON[travelLeg.mode]}
                      </div>
                    ) : (
                      <div className="h-4 w-4 rounded-full border-2 border-white bg-orange-500 shadow" />
                    )}
                  </AdvancedMarker>
                )}
                <RoutePolylines
                  legs={routeLegs}
                  stops={stops}
                  selectedLegId={selectedLegId}
                  dimmed={routeEditing}
                  // m-3：正在編輯的那段不重複畫——舊路徑會以 dimmed 疊在編輯線底下，按「清除全部」
                  // 後它還留著，容易讓人以為沒清掉；而且那條線也會吃掉落在它上面的點擊
                  hiddenLegId={routeEditing ? routeEditingLegId : null}
                />
                {/* 讀同一個 routeEditing（審查 N-1）——它已內含 canEdit && !writesBlocked（M-4：
                    畫路徑是寫入動作，斷線期間不得寫 DB）。後三項是 TypeScript 的型別窄化需要，
                    語義上與 routeEditing 完全重疊，不會造成兩處條件分岔。 */}
                {routeEditing && editingLeg && editingFrom && editingTo && (
                  <RouteEditor
                    // key 讓換一段編輯時整顆重建，內部 effect 的 legId deps 不必再處理跨段殘留
                    key={editingLeg.id}
                    legId={editingLeg.id}
                    lockToken={editingLeg.updated_at}
                    fromPos={{ lat: editingFrom.lat, lng: editingFrom.lng }}
                    toPos={{ lat: editingTo.lat, lng: editingTo.lng }}
                    initialCustomPath={editingLeg.custom_path}
                    onClose={() => setRouteEditingLegId(null)}
                    onSaved={value => setPendingCustomPath({ legId: editingLeg.id, value })}
                  />
                )}
                <PlaybackTrail
                  completedPaths={completedPaths}
                  currentPath={currentTravelPath}
                  progress={segment?.kind === 'travel' ? segment.progress : 0}
                  // 2026-08-04 總審 m-4 拍板：紅線的存續改綁「播放頭是否有值」而非「是否正在播放」——
                  // 暫停就是為了看路線，線消失是反直覺的；拖曳 Timeline 播放頭（未按播放）也該同步顯示。
                  // 只有切 Day（playheadMs 歸 null，clampedPlayheadMs 隨之為 null）才清除
                  active={clampedPlayheadMs !== null}
                />
                <CameraFollow target={cameraTarget} playing={playing} />
                <PlaybackCamera
                  lat={playheadDisplayPos?.lat ?? null}
                  lng={playheadDisplayPos?.lng ?? null}
                  active={playing}
                  bounds={playbackBounds}
                  daySessionKey={`${activeDay}:${playSessionRef.current}`}
                  segmentFitKey={playing ? travelFitKey : null}
                  segmentPath={currentTravelPath}
                  segmentMaxZoom={SEGMENT_MAX_ZOOM[travelLeg?.mode ?? 'custom']}
                />
              </Map>
            </SectionErrorBoundary>
          ) : (
            <div className="flex h-full items-center justify-center text-gray-500">
              尚未設定 NEXT_PUBLIC_GOOGLE_MAPS_API_KEY，地圖無法顯示
            </div>
          )}
        </div>
      </div>
      <Timeline
        key={activeDay} // Day 切換即重掛：內部唯一 state（drag）天然歸零，避免切 Day 後拖曳卡死（不用 effect 清 state，踩過 set-state-in-effect lint 錯誤）
        stops={stops}
        dayKeys={tripDayKeys(trip.start_date, trip.end_date)}
        activeDay={activeDay}
        onDayChange={routeEditing ? NOOP : changeDay}
        selectedId={selectedId}
        onSelect={id => {
          setSelectedId(id)
          if (routeEditing) return // 同 N-3：編輯中不移鏡頭
          const s = stops.find(x => x.id === id)
          if (s) setCameraTarget({ lat: s.lat, lng: s.lng })
        }}
        playheadMs={playheadMs}
        onPlayheadChange={ms => {
          // 暫停態手動拖曳播放頭 = 新的播放起點（複審 🟡-1）：bump session 讓下次起播重收整日全景，
          // 否則鏡頭會卡在前一段的街廓級取景。播放中拖曳不 bump——daySessionKey 在 E1 deps 裡，
          // 播放中 bump 會讓每次拖動都彈回整日全景（複審明示的天真寫法陷阱）
          if (!playing) playSessionRef.current += 1
          setPlayheadMs(ms)
        }}
        // Task 11：斷線時 onMove 一併收回（不只在 moveStop 內部靜默 return）——否則 Timeline 會出現
        // 拖曳預覽但提交不了的半互動狀態，與 Task 5 對 viewer 的既有處理一致
        onMove={canEdit && !writesBlocked && !routeEditing ? moveStop : undefined}
        busy={busy}
        pendingShift={pendingShift}
        playing={playing}
        // 編輯模式停用（審查 M-5）：播放中 PlaybackCamera 會 fitBounds/panTo，鏡頭會在使用者畫線時自己跑掉。
        // 這三個是必填 prop，故傳 no-op 而非 undefined（傳 undefined 會壞型別）
        onTogglePlay={routeEditing ? NOOP : togglePlay}
        dayView={dayView}
        selectedLegId={selectedLegId}
        onSelectLeg={routeEditing ? NOOP : setSelectedLegId}
        interactionsDisabled={routeEditing}
      />
    </div>
  )

  // APIProvider 需包住整個側欄 + 地圖：PlaceSearch（側欄）與 Map 都要用 useMapsLibrary/APIProviderContext，
  // 若只包地圖那一側，PlaceSearch 會拿不到 context（React context 不會跨兄弟節點），gmp-select 永遠不會註冊。
  // I-2：這裡再包一層 SectionErrorBoundary（保留在 APIProvider 內——這樣觸發後 retry 只需要重新渲染
  // content，不必連 APIProvider 一起卸載重掛，不用重新跑一次 Maps 腳本載入）。跟 <Map> 那顆內層
  // boundary 是兩顆獨立的 boundary：地圖本身壞了先被內層接住（側欄與時間軸不受影響，維持原本的窄
  // 範圍承諾）；PlaceSearch 這種位在側欄、跟地圖同層兄弟節點的例外，結構上只有這顆外層才接得到，
  // 觸發時整個 content（側欄+地圖+時間軸）會被取代，是比 Next 預設全頁崩潰頁更好的防禦性最後防線。
  return apiKey ? (
    <APIProvider
      apiKey={apiKey}
      onError={() => setNotice({ kind: 'error', text: 'Google 地圖載入失敗，請檢查金鑰設定與網路' })}
    >
      <SectionErrorBoundary message="行程頁部分內容載入失敗，可能是暫時性問題，請按重試或重新整理頁面">
        {content}
      </SectionErrorBoundary>
    </APIProvider>
  ) : (
    content
  )
}
