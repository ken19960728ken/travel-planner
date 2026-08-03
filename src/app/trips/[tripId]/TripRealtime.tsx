'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Tables } from '@/lib/supabase/database.types'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

const REFRESH_DEBOUNCE_MS = 500 // Task 11 Step 1：連續事件合併成一次 refresh，避免刷新風暴

// 只取用到的欄位；DELETE payload（見下方 handleRowEvent）在 RLS 啟用時即使 replica identity 為 full
// 也只剩 PK（官方文件 postgres-changes.mdx 明載），故 updated_by 只在 INSERT/UPDATE 保證存在
type StopChange = Pick<Tables<'stops'>, 'id' | 'updated_by'>
type LegChange = Pick<Tables<'legs'>, 'id' | 'updated_by'>

/** stops/legs 共用事件處理：INSERT/UPDATE 忽略自己的寫入（避免與自己的寫入路徑疊成雙重刷新）；
 *  DELETE 不套 RLS、不能 filter，會收到其他行程的刪除事件，payload.old 僅含 PK——只信本地 id 集合
 *  命中才 refresh，未命中靜默忽略，絕不信 payload 的其他欄位（spec §8）。 */
function handleRowEvent<T extends { id?: string; updated_by?: string | null }>(
  payload: RealtimePostgresChangesPayload<T>,
  currentUserId: string,
  knownIds: Set<string>,
  scheduleRefresh: () => void,
) {
  if (payload.eventType === 'DELETE') {
    const id = payload.old.id
    if (id && knownIds.has(id)) scheduleRefresh()
    return
  }
  if (payload.new.updated_by === currentUserId) return
  scheduleRefresh()
}

/** Task 11 Step 1：單一 channel `trip:{tripId}` 訂閱 stops/legs/trips 變更，debounce refresh。
 *  純邏輯元件（不渲染畫面）——TripView 只做掛載與旗標接線（spec 分工）。 */
export default function TripRealtime({
  tripId,
  userId,
  stopIds,
  legIds,
}: {
  tripId: string
  userId: string
  /** 本地已知的 stops/legs id 集合，供 DELETE 事件的冪等比對。用 ref 讀最新值——stops/legs 資料變動
   *  不需要重建 channel（見下方 effect 的 deps），否則每次寫入都會斷線重連 */
  stopIds: Set<string>
  legIds: Set<string>
}) {
  const router = useRouter()
  const stopIdsRef = useRef(stopIds)
  const legIdsRef = useRef(legIds)
  useEffect(() => {
    stopIdsRef.current = stopIds
  }, [stopIds])
  useEffect(() => {
    legIdsRef.current = legIds
  }, [legIds])

  useEffect(() => {
    const supabase = createClient()
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retriesLeft = 3
    let cancelled = false
    let currentChannel: ReturnType<typeof supabase.channel> | null = null

    function scheduleRefresh() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    // 實測發現：本地 Realtime 引擎（v2.113.4）在兩個 client 幾乎同時 join 同一 topic 時，
    // 偶發讓其中一條 postgres_changes 綁定（隨機命中 stops/legs/trips 任一張表）在 phx_reply 之後
    // 非同步收到 `system` extension=postgres_changes status=error 訊息（"invalid column for filter X"，
    // X 為該綁定實際存在且有權限的欄位）——channel 本身仍回報 SUBSCRIBED，但該綁定完全收不到後續事件，
    // 且不影響其他綁定。研判為引擎內部 subscription_check_filters trigger 在併發註冊下的競態瑕疵
    // （已用 pg_catalog.has_column_privilege 手動重現該檢查邏輯，欄位與權限本身皆正確，非本檔案的
    // filter 語法錯誤）。緩解：收到此類 system 錯誤時整條 channel 拆掉重建（供 3 次重試，指數退避），
    // 全新的 join 極高機率避開這次競態視窗（spec §8 已記錄殘留風險）。
    function mount() {
      const channel = supabase
        .channel(`trip:${tripId}`, { config: {} })
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'stops', filter: `trip_id=eq.${tripId}` },
          (payload: RealtimePostgresChangesPayload<StopChange>) =>
            handleRowEvent(payload, userId, stopIdsRef.current, scheduleRefresh),
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'legs', filter: `trip_id=eq.${tripId}` },
          (payload: RealtimePostgresChangesPayload<LegChange>) =>
            handleRowEvent(payload, userId, legIdsRef.current, scheduleRefresh),
        )
        // trips 無 updated_by 欄位，無法比對自己的寫入；本分頁目前唯一的 client 端 trips 寫入路徑是
        // MembersPanel 的 regenerate_share_token RPC（自己已呼叫 router.refresh()），這裡頂多重複一次
        // 無害的 refresh。只訂 UPDATE：DELETE 不能 filter 且 trips 無可信欄位可辨別是否為本行程，
        // 行程本身被刪除時使用者下一次 refresh 會被 RLS 導向 404，不需要額外處理
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${tripId}` },
          () => scheduleRefresh(),
        )
        .on('system', {}, payload => {
          if (payload?.extension !== 'postgres_changes' || payload?.status !== 'error') return
          if (cancelled || retriesLeft <= 0) return
          retriesLeft -= 1
          void supabase.removeChannel(channel)
          retryTimer = setTimeout(() => {
            if (!cancelled) currentChannel = mount()
          }, 300 * (4 - retriesLeft))
        })

      channel.subscribe()

      return channel
    }

    currentChannel = mount()

    return () => {
      cancelled = true
      if (debounceTimer) clearTimeout(debounceTimer)
      if (retryTimer) clearTimeout(retryTimer)
      if (currentChannel) void supabase.removeChannel(currentChannel)
    }
    // tripId/userId 變動才需要重建 channel（換行程/身分）；stopIds/legIds 用 ref 讀最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, userId])

  return null
}
