'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ControlPosition, MapControl, useMap } from '@vis.gl/react-google-maps'
import { createClient } from '@/lib/supabase/client'
import { MAX_CUSTOM_PATH_POINTS, parseCustomPath } from '@/lib/domain/routePath'
import type { LatLng } from '@/lib/domain/polyline'

/** 編輯中的路徑樣式：比一般路線粗、飽和度高，讓它明顯是「正在編輯的那一條」。
 *  #dc2626 是播放紅線的色，但兩者不會同時出現（進入編輯模式會先停止播放），不衝突。 */
const EDIT_STROKE = { strokeColor: '#dc2626', strokeOpacity: 0.9, strokeWeight: 4, zIndex: 20 }

type Notice = { kind: 'error' | 'success'; text: string } | null

/** 座標收斂到 6 位小數（約 0.1 公尺）。見 save() 的說明與 migration 20260810000000 的字元上限。 */
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6

/** 手繪交通路徑編輯器（設計文件 §4）。
 *
 *  **只存中間轉折點**：地圖上畫的是 `[起點停留點, ...中間點, 終點停留點]`，但儲存時去掉頭尾兩點。
 *  渲染時再由 `withEndpoints` 接回停留點「目前」的位置——停留點被拖到別處時路徑自動重接。
 *
 *  **Polyline 建立一次、之後就地改 path**（deps 不含目前路徑）：每次加點就重建會讓 Google 的
 *  編輯控制點與拖曳中的狀態消失，也會閃爍（同 PlaybackTrail 的教訓）。資料流是單向的
 *  「Polyline 的 MVCArray → React state」，不反向用 state 去 setPath，否則會與 Google 內部的
 *  編輯行為互相打架。
 *
 *  `editable: true` 由 Google 原生提供頂點拖曳**與線段中央控制點插入新點**（官方：控制點顯示於
 *  「vertices and on each segment」），觸控裝置同樣可用——這是手機能畫的基礎，不需自寫手勢。 */
export default function RouteEditor({
  legId, lockToken, fromPos, toPos, initialCustomPath, onClose, onSaved,
}: {
  legId: string
  /** 樂觀鎖用的 legs.updated_at，語義同 LegEditor */
  lockToken: string
  fromPos: LatLng
  toPos: LatLng
  initialCustomPath: unknown
  onClose: () => void
  /** 存檔成功後回報實際寫入的值，供 TripView 樂觀覆寫——props 追上前不讓編輯器讀到舊值（C-1） */
  onSaved: (value: [number, number][] | null) => void
}) {
  const router = useRouter()
  const map = useMap()
  const polylineRef = useRef<google.maps.Polyline | null>(null)
  // 中間點數（不含頭尾）。由 MVCArray 事件單向同步過來，只供工具列顯示與按鈕啟用判斷
  const [waypointCount, setWaypointCount] = useState(0)
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null)
  /** 選取標記（設計 §4 承諾的「放大 + 紅框」）。用獨立的 Marker 疊在頂點上——Google 的 editable
   *  控制點外觀不可自訂，沒有這個標記使用者只能從按鈕是否啟用猜自己選到誰。 */
  const selectionMarkerRef = useRef<google.maps.Marker | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!map) return
    // 關掉 Google 的 POI 圖示點擊（實測必要）：不關的話點到餐廳/車站圖示會彈出 Google 原生的
    // 資訊視窗，它會蓋住地圖並吃掉後續點擊——實測連點三下只加得到第一個點。
    // 比照 PlaybackCamera 處理 maxZoom 的作法：進入時設、cleanup 還原，不影響編輯模式以外的行為。
    map.setOptions({ clickableIcons: false })
    const initial = parseCustomPath(initialCustomPath)
    const polyline = new google.maps.Polyline({
      map,
      editable: true,
      path: [fromPos, ...initial, toPos],
      ...EDIT_STROKE,
    })
    polylineRef.current = polyline
    const path = polyline.getPath()
    // 中間點數 = 總點數 - 頭尾兩點
    const syncCount = () => setWaypointCount(Math.max(0, path.getLength() - 2))
    syncCount()

    // 插點／刪點會讓既有頂點的索引整體位移——選取記的是索引，不清就會刪錯人（審查 M-1 實測：
    // 選取最右的 C，用原生控制點在 A、B 之間插一點，按刪除 → 被刪掉的是沒選取的 B）
    const syncAndClearSelection = () => {
      syncCount()
      setSelectedVertex(null)
    }

    const listeners: google.maps.MapsEventListener[] = [
      // 原生的「拖線段中央控制點插點」也會走 insert_at，這裡是唯一能擋住它越界的地方
      // （審查 M-2 實測：地圖點擊被正確擋在 100，改用原生控制點可插到 101/100，存檔才被 DB 擋下，
      // 而訊息卻叫使用者「稍後再試」——重試永遠不會成功）
      path.addListener('insert_at', (index: number) => {
        if (path.getLength() - 2 > MAX_CUSTOM_PATH_POINTS) {
          path.removeAt(index)
          setNotice({ kind: 'error', text: `轉折點已達上限 ${MAX_CUSTOM_PATH_POINTS} 個` })
          return
        }
        syncAndClearSelection()
      }),
      path.addListener('remove_at', syncAndClearSelection),
      path.addListener('set_at', syncCount),
      // 輕點頂點 → 選取（電腦與手機同一套操作；右鍵在手機不存在，故不用右鍵刪除）。
      // event.vertex 只在點到頂點時有值，點線段本身為 undefined
      polyline.addListener('click', (e: google.maps.PolyMouseEvent) => {
        setSelectedVertex(typeof e.vertex === 'number' ? e.vertex : null)
      }),
      // 點地圖空白處 → 在末端（終點停留點之前）插入新點
      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return
        const current = polyline.getPath()
        if (current.getLength() - 2 >= MAX_CUSTOM_PATH_POINTS) {
          setNotice({ kind: 'error', text: `轉折點已達上限 ${MAX_CUSTOM_PATH_POINTS} 個` })
          return
        }
        setNotice(null)
        current.insertAt(current.getLength() - 1, e.latLng)
      }),
    ]

    return () => {
      listeners.forEach(l => l.remove())
      polyline.setMap(null)
      polylineRef.current = null
      map.setOptions({ clickableIcons: true })
    }
    // 只在切換交通段或地圖實例變動時重建；initialCustomPath/端點刻意不入 deps——
    // 它們是「進入編輯模式當下的快照」，編輯期間 props 若因 router.refresh() 變動也不該
    // 把使用者正在畫的內容洗掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, legId])

  // 選取標記跟著 selectedVertex 走。分離成獨立 effect（不與建構 effect 混在一起），比照
  // PlaybackTrail 的「建構 + 更新」兩層樣式
  useEffect(() => {
    selectionMarkerRef.current?.setMap(null)
    selectionMarkerRef.current = null
    const polyline = polylineRef.current
    if (!map || !polyline || selectedVertex === null) return
    const pos = polyline.getPath().getAt(selectedVertex)
    if (!pos) return
    selectionMarkerRef.current = new google.maps.Marker({
      map,
      position: pos,
      clickable: false,
      zIndex: 30,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: '#dc2626',
        fillOpacity: 0.35,
        strokeColor: '#dc2626',
        strokeWeight: 2,
      },
    })
    return () => {
      selectionMarkerRef.current?.setMap(null)
      selectionMarkerRef.current = null
    }
  }, [map, selectedVertex])

  function deleteSelected() {
    const polyline = polylineRef.current
    if (!polyline || selectedVertex === null) return
    const path = polyline.getPath()
    // 頭尾是停留點，不可刪
    if (selectedVertex === 0 || selectedVertex === path.getLength() - 1) {
      setNotice({ kind: 'error', text: '起訖點由停留點決定，不能刪除' })
      return
    }
    path.removeAt(selectedVertex)
    setSelectedVertex(null)
    setNotice(null)
  }

  function clearAll() {
    const polyline = polylineRef.current
    if (!polyline) return
    const path = polyline.getPath()
    // 由後往前刪中間點，留下頭尾
    for (let i = path.getLength() - 2; i >= 1; i--) path.removeAt(i)
    setSelectedVertex(null)
    setNotice(null)
  }

  async function save() {
    const polyline = polylineRef.current
    if (!polyline || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const all = polyline.getPath().getArray()
      // 去掉頭尾——只存中間轉折點。座標收斂到 6 位小數（約 0.1 公尺，遠超畫線精度需求）：
      // ll.lat() 是全精度浮點（實測 33.53749013428124），單點約 40 字元、100 點逼近 4KB，
      // 會把 DB 的 4000 字元上限卡得太緊；收斂後 100 點約 2.4KB
      const waypoints: [number, number][] =
        all.slice(1, -1).map(ll => [round6(ll.lat()), round6(ll.lng())])
      // 0 個中間點 = 沒有自訂路徑，等同「還原成自動路線」（設計文件 §8）
      const value = waypoints.length > 0 ? waypoints : null
      const supabase = createClient()
      const { data, error } = await supabase
        .from('legs')
        .update({ custom_path: value })
        .eq('id', legId)
        .eq('updated_at', lockToken)
        .select('id')
      if (error) {
        // 23514 = check constraint。上限與資料量已在前端擋住，走到這裡代表有繞過路徑——
        // 給專屬文案，不要讓使用者去「稍後再試」一件永遠不會成功的事（審查 M-2）
        setNotice({
          kind: 'error',
          text: error.code === '23514'
            ? `路徑不符限制（最多 ${MAX_CUSTOM_PATH_POINTS} 個轉折點），請刪掉一些點再存`
            : '儲存失敗，請稍後再試（你畫的內容還在）',
        })
        return
      }
      if ((data ?? []).length === 0) {
        // 樂觀鎖 0 列多半不是真的被搶改（審查 m-1）：legs 有 legs_touch trigger，任何寫入都會 bump
        // updated_at——sync 續跑鏈與同分頁的 LegEditor 儲存都會在畫線期間推進它。舊文案叫使用者
        // 「重新載入頁面」等於丟掉正在畫的內容，是最糟的指示。改為先 refresh 讓 lockToken 追上，
        // 使用者再按一次即可成功；編輯模式與畫的內容都保留。
        router.refresh()
        setNotice({ kind: 'error', text: '資料剛更新過，請再按一次儲存（你畫的內容還在）' })
        return
      }
      // C-1（審查 Critical，實測資料遺失）：本專案其他寫入點都自己 refresh（LegEditor.write、
      // StopEditor、addStop），只有這裡原本靠 TripRealtime 的 500ms debounce 順風車。那段延遲就是
      // 覆蓋窗口——存完立刻再按「畫路徑」，編輯器讀到的是尚未更新的 props（空的），再存一次就把
      // 剛剛畫的整條蓋掉，且全程無警告。onSaved 讓 TripView 樂觀覆寫，refresh 補上權威值。
      onSaved(value)
      router.refresh()
      onClose()
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <MapControl position={ControlPosition.TOP_CENTER}>
      <div className="m-2 flex flex-wrap items-center gap-2 rounded bg-white/95 p-2 text-xs shadow">
        <span className="font-medium">畫路徑</span>
        <span className="text-gray-500">
          點地圖加點・拖點調整・拖線段中央插點（{waypointCount}/{MAX_CUSTOM_PATH_POINTS}）
        </span>
        <button
          type="button"
          className="rounded border px-2 py-1 disabled:opacity-40"
          disabled={selectedVertex === null || saving}
          onClick={deleteSelected}
        >
          刪除選取的點
        </button>
        <button
          type="button"
          className="rounded border px-2 py-1 disabled:opacity-40"
          disabled={waypointCount === 0 || saving}
          onClick={clearAll}
        >
          清除全部
        </button>
        <button
          type="button"
          className="rounded bg-foreground px-2 py-1 text-background disabled:opacity-40"
          disabled={saving}
          onClick={save}
        >
          儲存
        </button>
        {/* 取消鈕刻意不吃 saving（審查 m-5）：supabase-js 沒有 timeout，網路卡住時若連取消都停用，
            使用者既不能存也不能退，只剩重新整理一途。savingRef 已足以防重複送出。 */}
        <button type="button" className="rounded border px-2 py-1" onClick={onClose}>
          取消
        </button>
        {notice && (
          <span className={notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}>{notice.text}</span>
        )}
      </div>
    </MapControl>
  )
}
