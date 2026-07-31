'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { APIProvider, Map, AdvancedMarker, Pin, useMap } from '@vis.gl/react-google-maps'
import { createClient } from '@/lib/supabase/client'
import { nextDefaultSlot } from '@/lib/domain/slot'
import { formatLocalTime, localDateKey, wallInputToUtcMs } from '@/lib/domain/tz'
import { tripDayKeys, filterDayStops } from '@/lib/domain/days'
import { interpolatePosition } from '@/lib/domain/interpolate'
import { adjacentPairs } from '@/lib/domain/legSync'
import PlaceSearch from './PlaceSearch'
import StopEditor from './StopEditor'
import LegEditor from './LegEditor'
import Timeline, { dayWindow } from './Timeline'
import { MODE_ICON, legDurationText } from './legUi'
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

export type Leg = {
  id: string
  from_stop_id: string
  to_stop_id: string
  mode: 'transit' | 'walking' | 'driving' | 'flight' | 'custom'
  duration_minutes: number | null
  distance_meters: number | null
  polyline: string | null
  detail: unknown
  source: 'auto' | 'manual'
  stale: boolean
  departs_at: string | null
  arrives_at: string | null
  estimated_cost: number | null
  updated_at: string
}

const FALLBACK_CENTER = { lat: 25.034, lng: 121.5645 } // 台北 101，行程還沒有停留點時的預設視野
const PLAY_STEP_MS = 10 * 60 * 1000 // 播放中每秒推進的模擬時間
const SYNC_RETRY_MS = 1_500 // I-3：sync 回報 pending/incomplete 時的續跑間隔
const MAX_SYNC_ROUNDS = 6 // I-3：續跑回合上限（配合 I-2 的 in-flight guard），避免無金鑰環境無限重試

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
          source: 'auto', stale: false, estimated_cost: null,
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
        會清除此段的手動內容與花費
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
  leg, fromStop, toStop, currency, onChanged,
}: {
  leg: Leg
  fromStop: Stop
  toStop: Stop
  currency: string
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
    </li>
  )
}

export default function TripView({
  trip,
  stops,
  stopsError,
  legs,
}: {
  trip: Trip
  stops: Stop[]
  stopsError?: boolean
  legs: Leg[]
}) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null)
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

  const syncedRef = useRef(false)
  const syncInFlightRef = useRef(false) // I-2：同時只跑一個 in-flight sync 請求
  const legsRef = useRef(legs)
  legsRef.current = legs // 續跑鏈的 setTimeout 閉包會捕捉舊 render 的 legs，比對一律讀 ref 取當下值
  const syncQueuedRef = useRef(false) // I-2：in-flight 期間又有新觸發，併成一次補跑（不逐一排隊）
  const syncRoundRef = useRef(0) // I-3：續跑回合數，使用者觸發的全新 sync 會歸零，只有續跑本身遞增
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // I-3：續跑計時器
  const syncNoticeShownRef = useRef(false) // S-1：連線失敗提示只跳一次，避免每輪續跑都打擾使用者
  useEffect(() => {
    if (syncedRef.current) return
    syncedRef.current = true
    void syncLegs()
    return () => {
      // I-3：unmount 時清掉排隊中的續跑計時器，避免對已卸載的元件觸發後續 setState
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
    // 只在掛載時觸發一次；syncLegs 透過 closure 讀最新 props/state，不需要讓這個 effect
    // 隨依賴重跑（M-5）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 交通段同步：結構比對 + 自動計算都在 server（金鑰不落 client）。
  // 失敗靜默：外部服務失敗不能阻止編輯（spec §6），下次寫入或重新整理會再試（HTTP 非 2xx 例外，S-1 跳一次提示）。
  // isRetry=true 代表這是 I-3 排程的續跑，不重置回合額度；使用者操作觸發的呼叫一律 isRetry=false（全新額度）。
  async function syncLegs(isRetry = false) {
    if (syncInFlightRef.current) {
      syncQueuedRef.current = true // I-2：coalescing——已有請求在跑，這次觸發併入下一次補跑
      return
    }
    if (!isRetry) syncRoundRef.current = 0
    syncInFlightRef.current = true
    try {
      const res = await fetch(`/api/trips/${trip.id}/legs/sync`, { method: 'POST' })
      if (!res.ok) {
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
      void syncLegs()
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
      void syncLegs()
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
    setSelectedLegId(null)
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

  // leg 歸屬「from 停留點所屬日」：後繼者取全行程順序，跨夜段顯示在出發日末尾（M-4）
  // 用 globalThis.Map：本檔已從 @vis.gl/react-google-maps import 了元件 Map，會遮蔽內建建構子
  const nextByStopId = new globalThis.Map(
    adjacentPairs(stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime() })))
      .map(([f, t]) => [f.id, t.id]),
  )
  const stopById = new globalThis.Map(stops.map(s => [s.id, s]))
  const legByPair = new globalThis.Map(legs.map(l => [`${l.from_stop_id}→${l.to_stop_id}`, l]))

  // Important-2 根治：配對脫離（插入停留點/調整順序）的 legs 不再出現在上面的正常交通列（legByPair
  // 命中不到），過去因此從畫面消失；改收進側欄專屬區塊，過濾出 from 停留點屬 activeDay 者（歸屬規則同 M-4）
  const detachedLegs = legs
    .filter(l => nextByStopId.get(l.from_stop_id) !== l.to_stop_id)
    .filter(l => activeDayStops.some(s => s.id === l.from_stop_id))

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
            {activeDayStops.map((stop, i) => {
              const next = stopById.get(nextByStopId.get(stop.id) ?? '')
              const leg = next ? legByPair.get(`${stop.id}→${next.id}`) : undefined
              const crossDay = Boolean(next && !activeDayStops.some(s => s.id === next.id))
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
                        onChanged={() => void syncLegs()}
                      />
                    )}
                  </li>
                  {leg && next && (
                    <li className="pl-5 text-xs">
                      <button
                        type="button"
                        aria-pressed={selectedLegId === leg.id}
                        className={`cursor-pointer ${selectedLegId === leg.id ? 'font-medium text-blue-600' : 'text-gray-500'}`}
                        onClick={() => setSelectedLegId(selectedLegId === leg.id ? null : leg.id)}
                      >
                        {MODE_ICON[leg.mode]} {legDurationText(leg)}
                        {leg.estimated_cost !== null && ` · ${trip.currency} ${leg.estimated_cost}`}
                        {crossDay && ` → ${localDateKey(new Date(next.starts_at).getTime(), next.timezone).slice(5)} ${next.name}`}
                        {leg.stale && ' ⚠️ 前後行程變動過，可能過期'}
                      </button>
                      {leg.source === 'manual' && (
                        <span className="ml-1">
                          <RevertToAutoButton legId={leg.id} onChanged={() => void syncLegs()} />
                        </span>
                      )}
                      {selectedLegId === leg.id && (
                        <LegEditor
                          key={leg.id}
                          leg={leg}
                          fromStop={stop}
                          toStop={next}
                          currency={trip.currency}
                          onChanged={() => void syncLegs()}
                        />
                      )}
                    </li>
                  )}
                </Fragment>
              )
            })}
            {activeDayStops.length === 0 && (
              <li className="text-sm text-gray-500">
                {stopsError ? '停留點讀取失敗，請重新整理再試' : '還沒有停留點，用上方搜尋加入第一個景點'}
              </li>
            )}
          </ul>
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
                      onChanged={() => void syncLegs()}
                    />
                  )
                })}
              </ul>
            </details>
          )}
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
        legs={legs}
        selectedLegId={selectedLegId}
        onSelectLeg={setSelectedLegId}
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
