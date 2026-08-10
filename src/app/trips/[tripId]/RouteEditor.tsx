'use client'

import { useEffect, useRef, useState } from 'react'
import { ControlPosition, MapControl, useMap } from '@vis.gl/react-google-maps'
import { createClient } from '@/lib/supabase/client'
import { MAX_CUSTOM_PATH_POINTS, parseCustomPath } from '@/lib/domain/routePath'
import type { LatLng } from '@/lib/domain/polyline'

/** 編輯中的路徑樣式：比一般路線粗、飽和度高，讓它明顯是「正在編輯的那一條」。
 *  #dc2626 是播放紅線的色，但兩者不會同時出現（進入編輯模式會先停止播放），不衝突。 */
const EDIT_STROKE = { strokeColor: '#dc2626', strokeOpacity: 0.9, strokeWeight: 4, zIndex: 20 }

type Notice = { kind: 'error' | 'success'; text: string } | null

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
  legId, lockToken, fromPos, toPos, initialCustomPath, onClose,
}: {
  legId: string
  /** 樂觀鎖用的 legs.updated_at，語義同 LegEditor */
  lockToken: string
  fromPos: LatLng
  toPos: LatLng
  initialCustomPath: unknown
  onClose: () => void
}) {
  const map = useMap()
  const polylineRef = useRef<google.maps.Polyline | null>(null)
  // 中間點數（不含頭尾）。由 MVCArray 事件單向同步過來，只供工具列顯示與按鈕啟用判斷
  const [waypointCount, setWaypointCount] = useState(0)
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!map) return
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

    const listeners: google.maps.MapsEventListener[] = [
      path.addListener('insert_at', syncCount),
      path.addListener('remove_at', syncCount),
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
    }
    // 只在切換交通段或地圖實例變動時重建；initialCustomPath/端點刻意不入 deps——
    // 它們是「進入編輯模式當下的快照」，編輯期間 props 若因 router.refresh() 變動也不該
    // 把使用者正在畫的內容洗掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, legId])

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
      // 去掉頭尾——只存中間轉折點
      const waypoints = all.slice(1, -1).map(ll => [ll.lat(), ll.lng()])
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
        setNotice({ kind: 'error', text: '儲存失敗，請稍後再試（你畫的內容還在）' })
        return
      }
      if ((data ?? []).length === 0) {
        setNotice({ kind: 'error', text: '這段交通已被其他人變更，請重新載入頁面後再畫' })
        return
      }
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
        <button
          type="button"
          className="rounded border px-2 py-1 disabled:opacity-40"
          disabled={saving}
          onClick={onClose}
        >
          取消
        </button>
        {notice && (
          <span className={notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}>{notice.text}</span>
        )}
      </div>
    </MapControl>
  )
}
