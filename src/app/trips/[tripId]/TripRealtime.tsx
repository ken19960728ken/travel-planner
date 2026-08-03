'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Tables } from '@/lib/supabase/database.types'
import type { RealtimePostgresChangesPayload, RealtimeChannel } from '@supabase/supabase-js'

const REFRESH_DEBOUNCE_MS = 500 // Task 11 Step 1：連續事件合併成一次 refresh，避免刷新風暴
// Minor（critic 審查）：純 trailing debounce 在旁人連續動作時，畫面要等對方停手才更新；
// 加 max-wait 確保連續事件下最多等 2 秒也會強制 flush 一次。
const REFRESH_MAX_WAIT_MS = 2000

export type PresencePeer = { userId: string; displayName: string }

// 只取用到的欄位；DELETE payload 的實測記錄見下方 handleRowEvent 註解
type StopChange = Pick<Tables<'stops'>, 'id'>
type LegChange = Pick<Tables<'legs'>, 'id'>

/** stops/legs 共用事件處理。
 *  INSERT/UPDATE 一律 refresh——不判斷「是否為自己的寫入」略過（critic 審查 Minor：舊版用
 *  `updated_by === currentUserId` 判斷，但 updated_by 是每「使用者」而非每「分頁」，同帳號開兩個
 *  分頁時會讓另一個分頁的旁人變動被誤判成自己而永遠不刷新——這是真正的資料新鮮度 bug，比起「自己
 *  的寫入路徑已呼叫過一次 router.refresh()，這裡再刷一次」的無感重複請求嚴重得多。刻意選擇接受
 *  重複 refresh 換取正確性）。
 *  DELETE 不套 RLS、不能 filter，payload.old 僅含 PK（實測：即使 stops/legs 的 replica identity
 *  是 full，RLS 啟用時 DELETE 的 old record 仍只剩主鍵——官方文件 postgres-changes.mdx 明載此為
 *  RLS + replica identity full 組合下的既定行為）——只信本地 id 集合命中才 refresh，未命中靜默
 *  忽略，絕不信 payload 的其他欄位（scratchpad/rt-delete-payload.mjs 已實測：本 schema 下同 topic
 *  的訂閱者不會收到「別的行程」的 DELETE payload——private channel 的 join 授權已把非成員整個擋在
 *  外面；id 集合比對仍保留作縱深防禦，不因單次實測結果而拿掉這層保護）。 */
function handleRowEvent<T extends { id?: string }>(
  payload: RealtimePostgresChangesPayload<T>,
  knownIds: Set<string>,
  scheduleRefresh: () => void,
) {
  if (payload.eventType === 'DELETE') {
    const id = payload.old.id
    if (id && knownIds.has(id)) scheduleRefresh()
    return
  }
  scheduleRefresh()
}

/** Task 11：單一 private channel `trip:{tripId}` 訂閱 stops/legs/trips 變更 + presence，debounce
 *  refresh。純邏輯元件（不渲染畫面）：presence 頭像與斷線橫幅由 TripView 依 onXxxChange 回呼自行
 *  渲染——TripView 只做掛載與旗標接線（spec 分工）。canEdit=false（viewer/分享頁）時 TripView
 *  不掛載本元件（spec §6 Step 3：唯讀者用手動刷新即可，省 anon realtime 授權面）。
 *
 *  C-1 Critical 根治（2026-08-04 critic 審查 + PoC 實證）：channel 改用 private:true，配合
 *  migration 20260805000000 在 realtime.messages 建的 RLS policy——未登入者與非成員現在連 join
 *  都會被拒絕，無法再偽造 presence payload 讓成員頁面崩潰（另見下方 presence sync 的型別守衛，
 *  屬第二層防禦）。 */
export default function TripRealtime({
  tripId,
  userId,
  displayName,
  stopIds,
  legIds,
  onDisconnectedChange,
  onPeersChange,
}: {
  tripId: string
  userId: string
  displayName: string
  /** 本地已知的 stops/legs id 集合，供 DELETE 事件的冪等比對。用 ref 讀最新值——stops/legs 資料變動
   *  不需要重建 channel（見下方 effect 的 deps），否則每次寫入都會斷線重連 */
  stopIds: Set<string>
  legIds: Set<string>
  onDisconnectedChange: (disconnected: boolean) => void
  onPeersChange: (peers: PresencePeer[]) => void
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
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retriesLeft = 3
    let cancelled = false
    let currentChannel: RealtimeChannel | null = null

    function flushRefresh() {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (maxWaitTimer) {
        clearTimeout(maxWaitTimer)
        maxWaitTimer = null
      }
      router.refresh()
    }
    function scheduleRefresh() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(flushRefresh, REFRESH_DEBOUNCE_MS)
      if (!maxWaitTimer) maxWaitTimer = setTimeout(flushRefresh, REFRESH_MAX_WAIT_MS)
    }

    // mount() 的結果透過這個 helper 交回 currentChannel：effect 已卸載（cancelled）時直接丟棄剛
    // 建好的 channel，避免卸載後仍留一條連線在背景（mount 內部有 await，subscribe 完成時卸載
    // 可能已經發生）。
    function adopt(promise: Promise<RealtimeChannel | null>) {
      void promise.then(ch => {
        if (cancelled) {
          if (ch) void supabase.removeChannel(ch)
          return
        }
        currentChannel = ch
      })
    }

    async function mount(): Promise<RealtimeChannel | null> {
      // M-2 Major 實測根因訂正（critic 審查 + scratchpad/rt-authrace2.mjs、rt-authrace3.mjs、
      // rt-browser-bindingerr.mjs）：@supabase/ssr 的 browser client 靠 onAuthStateChange 的
      // INITIAL_SESSION 事件（非同步）才呼叫 realtime.setAuth()；先前這裡的 useEffect 掛載當下就
      // 同步 subscribe，join 送出時 realtime client 還沒帶上使用者的 JWT，伺服器端會用 anon 角色
      // 驗證 filter 欄位權限——anon 對 stops/legs/trips 均無 grant，導致每個 filter 欄位都在 join
      // 後收到 system 層級的「invalid column for filter」錯誤。真實瀏覽器連續 6 次載入 100% 重現
      // 且固定是 trips/id（先前註解誤判為「本地引擎偶發競態、隨機命中任一張表」，已訂正）。
      // 修法：join 前主動 await setAuth() 取得目前 session 的 token（PoC 對照實驗：加上這行後
      // 4/4 zero error）。
      await supabase.realtime.setAuth()
      if (cancelled) return null

      const channel = supabase
        .channel(`trip:${tripId}`, { config: { private: true, presence: { key: userId } } })
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'stops', filter: `trip_id=eq.${tripId}` },
          (payload: RealtimePostgresChangesPayload<StopChange>) =>
            handleRowEvent(payload, stopIdsRef.current, scheduleRefresh),
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'legs', filter: `trip_id=eq.${tripId}` },
          (payload: RealtimePostgresChangesPayload<LegChange>) =>
            handleRowEvent(payload, legIdsRef.current, scheduleRefresh),
        )
        // trips 無 updated_by 欄位；只訂 UPDATE：DELETE 不能 filter 且 trips 無可信欄位可辨別是否
        // 為本行程，行程本身被刪除時使用者下一次 refresh 會被 RLS 導向 404，不需要額外處理
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'trips', filter: `id=eq.${tripId}` },
          () => scheduleRefresh(),
        )
        .on('presence', { event: 'sync' }, () => {
          // C-1 Critical 止血（critic 審查 + scratchpad/rt-presence-crash.mjs）：presence payload
          // 來自其他 client 端自行 track() 的內容，不受任何 schema 約束——舊版直接信任型別標註渲染，
          // 未登入攻擊者只要知道 tripId 就能 track 一筆缺 displayName 的 payload，讓所有正在編輯的
          // 成員頁面在 render 期對 undefined 呼叫 .slice() 而整頁崩潰。這裡逐欄型別守衛 + 20 字元
          // 長度上限（防超長字串塞爆頭像列）+ 依 userId 去重（同帳號多分頁避免重複 key/頭像）。
          // 根治見本檔 private:true 與 migration 20260805000000——未登入者現在連 join 都會被拒絕；
          // 這裡的守衛是額外一層防禦，即使某個已登入成員的 client 端有 bug 送出畸形 payload，也不會
          // 讓其他成員一起崩潰。
          const state = channel.presenceState<Record<string, unknown>>()
          const seen = new Set<string>()
          const peers: PresencePeer[] = []
          for (const p of Object.values(state).flat()) {
            if (typeof p.userId !== 'string' || typeof p.displayName !== 'string') continue
            if (p.userId === userId || seen.has(p.userId)) continue
            seen.add(p.userId)
            peers.push({ userId: p.userId, displayName: p.displayName.slice(0, 20) })
          }
          onPeersChange(peers)
        })
        .on('system', {}, payload => {
          // M-2 修正 auth 時序後這裡理論上不再觸發；保留為後備防線。retriesLeft 耗盡仍失敗時
          // 必須讓使用者知道——channel 這時仍回報 SUBSCRIBED，但某個綁定已經聾了，若不亮橫幅，
          // 使用者會在收不到旁人變更的情況下繼續編輯而不自知，這正好推翻 Step 3 斷線橫幅的設計
          // 目的（critic 審查 M-2：寧可誤報斷線，也不能靜默失聰）。
          if (payload?.extension !== 'postgres_changes' || payload?.status !== 'error') return
          if (cancelled) return
          if (retriesLeft <= 0) {
            onDisconnectedChange(true)
            return
          }
          retriesLeft -= 1
          void supabase.removeChannel(channel)
          retryTimer = setTimeout(() => {
            if (!cancelled) adopt(mount())
          }, 300 * (4 - retriesLeft))
        })

      // Step 3：斷線橫幅＋暫停編輯——CHANNEL_ERROR/TIMED_OUT 進橫幅，重連 SUBSCRIBED 清橫幅並整份重抓；
      // wasDisconnected 區分「初次掛載的 SUBSCRIBED」（資料已是 server 剛渲染的新鮮值，不需要 refresh）
      // 與「斷線後恢復的 SUBSCRIBED」（spec §6：重連後整份行程重新抓取）
      let wasDisconnected = false
      channel.subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          onDisconnectedChange(false)
          if (wasDisconnected) {
            wasDisconnected = false
            router.refresh()
          }
          await channel.track({ userId, displayName })
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          wasDisconnected = true
          onDisconnectedChange(true)
        }
      })

      return channel
    }

    adopt(mount())

    return () => {
      cancelled = true
      if (debounceTimer) clearTimeout(debounceTimer)
      if (maxWaitTimer) clearTimeout(maxWaitTimer)
      if (retryTimer) clearTimeout(retryTimer)
      if (currentChannel) void supabase.removeChannel(currentChannel)
    }
    // tripId/userId/displayName 變動才需要重建 channel（換行程/身分）；stopIds/legIds 用 ref 讀最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, userId, displayName])

  return null
}
