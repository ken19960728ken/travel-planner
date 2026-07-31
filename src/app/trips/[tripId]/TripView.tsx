'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { APIProvider, Map, AdvancedMarker, Pin, useMap } from '@vis.gl/react-google-maps'
import { createClient } from '@/lib/supabase/client'
import { nextDefaultSlot } from '@/lib/domain/slot'
import { formatLocalTime, localDateKey, wallInputToUtcMs } from '@/lib/domain/tz'
import { tripDayKeys, filterDayStops } from '@/lib/domain/days'
import { interpolatePosition } from '@/lib/domain/interpolate'
import PlaceSearch from './PlaceSearch'
import StopEditor from './StopEditor'
import Timeline, { dayWindow } from './Timeline'
import tzlookup from '@photostructure/tz-lookup'

export type Trip = {
  id: string
  title: string
  start_date: string
  end_date: string
  currency: string
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
}

const FALLBACK_CENTER = { lat: 25.034, lng: 121.5645 } // 台北 101，行程還沒有停留點時的預設視野
const PLAY_STEP_MS = 10 * 60 * 1000 // 播放中每秒推進的模擬時間

type Notice = { kind: 'error' | 'success'; text: string } | null

/** 鏡頭跟隨：target 變更時平移過去；視野太遠時拉近（需在 APIProvider 內才能拿到 map 實例） */
function CameraFollow({ target }: { target: { lat: number; lng: number } | null }) {
  const map = useMap()
  useEffect(() => {
    if (!map || !target) return
    map.panTo(target)
    if ((map.getZoom() ?? 0) < 12) map.setZoom(14)
  }, [map, target])
  return null
}

export default function TripView({
  trip,
  stops,
  stopsError,
}: {
  trip: Trip
  stops: Stop[]
  stopsError?: boolean
}) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  // 預設顯示行程第一天；Timeline 的 Day 分頁點擊會切換它
  const [activeDay, setActiveDay] = useState<string>(() => tripDayKeys(trip.start_date, trip.end_date)[0])
  const [playheadMs, setPlayheadMs] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const busyRef = useRef(false)
  const lastInsertedEndRef = useRef(0)
  const [draftPin, setDraftPin] = useState<{ lat: number; lng: number } | null>(null)
  const [draftName, setDraftName] = useState('')
  const [cameraTarget, setCameraTarget] = useState<{ lat: number; lng: number } | null>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const center = stops.length > 0 ? { lat: stops[0].lat, lng: stops[0].lng } : FALLBACK_CENTER

  // refresh 落地（真實列已涵蓋墊底基準）後歸零，讓後續預設時段計算回歸 props 真相
  useEffect(() => {
    if (stops.some(s => new Date(s.ends_at).getTime() >= lastInsertedEndRef.current)) {
      lastInsertedEndRef.current = 0
    }
  }, [stops])

  async function addStop(p: { name: string; lat: number; lng: number; placeId: string | null; isCustom: boolean }): Promise<boolean> {
    if (busyRef.current) return false
    if (stopsError) return false // 讀取失敗時基準不可信，關閉所有寫入入口（含草稿表單）
    busyRef.current = true
    setBusy(true)
    try {
      // Day-aware：只用當日既有停留點排定時段，避開「多日預設時段疊加」
      const targetDay = activeDay
      // 該日的參考時區：當日已有停留點用其時區，否則沿用全行程最後一個停留點的時區，再不然用瀏覽器時區
      const dayStops = stops.filter(s => localDateKey(new Date(s.starts_at).getTime(), s.timezone) === targetDay)
      const refTz =
        dayStops[dayStops.length - 1]?.timezone ??
        stops[stops.length - 1]?.timezone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone
      const daySchedule = dayStops.map(s => ({
        id: s.id,
        startsAt: new Date(s.starts_at).getTime(),
        endsAt: new Date(s.ends_at).getTime(),
        locked: s.locked,
      }))
      // 空日的預設開場：當地早上九點
      const fallback = wallInputToUtcMs(`${targetDay}T09:00`, refTz)
      if (lastInsertedEndRef.current > 0) {
        // router.refresh() 尚未把新列帶回 props 前，用上次成功寫入的結束時間墊底，避免連續加入算出相同時段
        daySchedule.push({ id: '__pending__', startsAt: lastInsertedEndRef.current - 1, endsAt: lastInsertedEndRef.current, locked: false })
      }
      const slot = nextDefaultSlot(daySchedule, fallback)

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
      lastInsertedEndRef.current = slot.endsAt
      setNotice(null)
      setCameraTarget({ lat: p.lat, lng: p.lng }) // 鏡頭飛到剛加入的停留點
      router.refresh()
      return true
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 時間軸拖曳平移提交：呼叫連鎖順延 RPC，後續未鎖定停留點原子化跟著移動（spec §6）
  async function moveStop(stopId: string, deltaMs: number) {
    if (busyRef.current || stopsError) return
    busyRef.current = true
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.rpc('cascade_shift_stops', {
        p_trip_id: trip.id,
        p_changed_stop_id: stopId,
        // RPC 的單位契約是秒；deltaMs 為毫秒，四捨五入換算（spec §8 記錄此單位差異）
        p_delta_seconds: Math.round(deltaMs / 1000),
      })
      if (error) {
        setNotice({ kind: 'error', text: '時間調整失敗，請稍後再試' })
        return
      }
      setNotice(null)
      setSelectedId(null) // 拖曳連鎖成功：關閉編輯器，避免舊值（starts_at/ends_at）殘留在表單裡被誤存回去覆寫連鎖結果
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 切換 Day：連動重置播放頭、播放狀態與加點基準，並清空選取（舊選取可能不在新的一天，側欄已過濾看不到編輯器）
  function changeDay(day: string) {
    setActiveDay(day)
    setSelectedId(null)
    setPlayheadMs(null)
    setPlaying(false)
    lastInsertedEndRef.current = 0
  }

  // 側欄只顯示當前 Day 的停留點，編號沿用當日順序
  const activeDayStops = filterDayStops(stops, activeDay)
  const win = dayWindow(activeDayStops)
  // 播放頭可能因資料變動（拖曳/刪除當日停留點後視窗縮小）落在目前視窗之外；顯示前一律夾回視窗內，
  // 避免地圖「我」標記與時間軸的滑桿/畫線互相矛盾
  const clampedPlayheadMs = playheadMs === null || !win ? null : Math.min(Math.max(playheadMs, win.start), win.end)

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
    setPlayheadMs(clamped + PLAY_STEP_MS > win.end ? win.start : clamped)
    setPlaying(true)
  }

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-y-auto border-r p-3">
          {apiKey && !stopsError && (
            <PlaceSearch
              onPick={p => addStop({ ...p, isCustom: false })}
              onError={text => setNotice({ kind: 'error', text })}
              disabled={busy}
            />
          )}
          {draftPin && (
            <form
              className="flex gap-1 rounded border p-2"
              onSubmit={async e => {
                e.preventDefault()
                const name = draftName.trim()
                if (!name) return
                const ok = await addStop({ name, lat: draftPin.lat, lng: draftPin.lng, placeId: null, isCustom: true })
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
              <button className="rounded border px-2 text-sm" type="button" onClick={() => setDraftPin(null)}>
                取消
              </button>
            </form>
          )}
          {notice && (
            <p className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
          )}
          <ul className="flex flex-col gap-2">
            {activeDayStops.map((stop, i) => (
              <li
                key={stop.id}
                className={`rounded border p-2 ${selectedId === stop.id ? 'border-blue-500' : ''}`}
              >
                <button
                  type="button"
                  className="block w-full cursor-pointer text-left"
                  onClick={() => {
                    const selecting = selectedId !== stop.id
                    setSelectedId(selecting ? stop.id : null)
                    if (selecting) setCameraTarget({ lat: stop.lat, lng: stop.lng }) // 點側欄 → 鏡頭帶過去
                  }}
                >
                  <span className="mr-1 text-xs text-gray-400">{i + 1}.</span>
                  <span className="mr-1 text-xs text-gray-400">
                    {formatLocalTime(new Date(stop.starts_at).getTime(), stop.timezone)}
                  </span>
                  <span className="font-medium">{stop.name}</span>
                </button>
                {selectedId === stop.id && (
                  <StopEditor
                    key={stop.id}
                    stop={stop}
                    currency={trip.currency}
                    onDeleted={() => setSelectedId(null)}
                  />
                )}
              </li>
            ))}
            {activeDayStops.length === 0 && (
              <li className="text-sm text-gray-500">
                {stopsError ? '停留點讀取失敗，請重新整理再試' : '還沒有停留點，用上方搜尋加入第一個景點'}
              </li>
            )}
          </ul>
        </aside>
        <div className="min-h-0 flex-1">
          {apiKey ? (
            <Map
              defaultCenter={center}
              defaultZoom={12}
              mapId="DEMO_MAP_ID" // TODO(deploy): 正式環境需換專屬 Map ID
              gestureHandling="greedy"
              disableDefaultUI={false}
              onContextmenu={e => {
                if (stopsError) return
                const latLng = e.detail.latLng
                if (latLng) setDraftPin({ lat: latLng.lat, lng: latLng.lng })
              }}
            >
              {stops.map(stop => {
                // 地圖標記照樣渲染全行程，但編號與配色改為「當日視角」：當日 = 紅底 + 當日編號，他日 = 灰底無編號
                const dayIdx = activeDayStops.findIndex(s => s.id === stop.id)
                const inActiveDay = dayIdx >= 0
                return (
                  <AdvancedMarker
                    key={stop.id}
                    position={{ lat: stop.lat, lng: stop.lng }}
                    onClick={() => {
                      // 只有點到不同 Day 的停留點才切換：同日點擊維持播放頭與加點基準不被重置
                      const day = localDateKey(new Date(stop.starts_at).getTime(), stop.timezone)
                      if (day !== activeDay) changeDay(day)
                      setSelectedId(stop.id)
                    }}
                    title={stop.name}
                  >
                    <Pin
                      background={selectedId === stop.id ? '#2563eb' : inActiveDay ? '#ef4444' : '#d1d5db'}
                      glyphColor="#fff"
                      borderColor="#fff"
                    >
                      {inActiveDay ? <span className="text-xs font-bold">{dayIdx + 1}</span> : null}
                    </Pin>
                  </AdvancedMarker>
                )
              })}
              {draftPin && (
                <AdvancedMarker position={draftPin}>
                  <Pin background="#9ca3af" glyphColor="#fff" borderColor="#fff" />
                </AdvancedMarker>
              )}
              {clampedPlayheadMs !== null && (() => {
                const pos = interpolatePosition(
                  activeDayStops.map(s => ({
                    id: s.id,
                    lat: s.lat,
                    lng: s.lng,
                    startsAt: new Date(s.starts_at).getTime(),
                    endsAt: new Date(s.ends_at).getTime(),
                  })),
                  clampedPlayheadMs,
                )
                return pos ? (
                  // anchorLeft/Top 置中：預設值 "-50%"/"-100%" 是底部中央（比照 Pin 針尖）。
                  // anchorLeft/anchorTop 是「錨點相對內容左上角的位移」，CENTER 要位移 -50%/-50%
                  // （不是 +50%，那會把錨點移到內容的右下角外側，偏移更大，見 AdvancedMarkerAnchorPoint.CENTER 的官方換算）。
                  // 圓點沒有針尖，需明確置中錨點，否則會系統性偏移半個標記高度
                  <AdvancedMarker position={pos} title="目前時刻位置" anchorLeft="-50%" anchorTop="-50%">
                    <div className="h-4 w-4 rounded-full border-2 border-white bg-orange-500 shadow" />
                  </AdvancedMarker>
                ) : null
              })()}
              <CameraFollow target={cameraTarget} />
            </Map>
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
        onDayChange={changeDay}
        selectedId={selectedId}
        onSelect={id => {
          setSelectedId(id)
          const s = stops.find(x => x.id === id)
          if (s) setCameraTarget({ lat: s.lat, lng: s.lng })
        }}
        playheadMs={playheadMs}
        onPlayheadChange={setPlayheadMs}
        onMove={moveStop}
        busy={busy}
        playing={playing}
        onTogglePlay={togglePlay}
      />
    </div>
  )

  // APIProvider 需包住整個側欄 + 地圖：PlaceSearch（側欄）與 Map 都要用 useMapsLibrary/APIProviderContext，
  // 若只包地圖那一側，PlaceSearch 會拿不到 context（React context 不會跨兄弟節點），gmp-select 永遠不會註冊。
  return apiKey ? (
    <APIProvider
      apiKey={apiKey}
      onError={() => setNotice({ kind: 'error', text: 'Google 地圖載入失敗，請檢查金鑰設定與網路' })}
    >
      {content}
    </APIProvider>
  ) : (
    content
  )
}
