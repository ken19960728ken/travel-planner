'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { utcMsToWallInput, wallInputToUtcMs } from '@/lib/domain/tz'
import { followingShiftMs } from '@/lib/domain/schedule'
import type { StopCategory } from '@/lib/domain/placeCategory'
import { CATEGORY_LABEL, CATEGORY_ORDER } from '@/lib/domain/placeCategory'
import { CATEGORY_ICON } from './categoryUi'
import type { Participant } from '@/lib/domain/participants'
import ParticipantPicker from './ParticipantPicker'
import type { Stop } from './TripView'

type Notice = { kind: 'error' | 'success'; text: string } | null

export default function StopEditor({
  stop,
  currency,
  roster,
  onDeleted,
  onChanged,
  onShiftFollowing,
  followingCount,
}: {
  stop: Stop
  currency: string
  /** 參與人名冊；為空時 ParticipantPicker 整個不渲染 */
  roster: readonly Participant[]
  onDeleted?: () => void
  onChanged?: () => void
  /** 順延後續行程。回傳實際被移動的筆數；undefined 代表呼叫端不支援（例如唯讀情境）。 */
  onShiftFollowing?: (
    anchorId: string, afterIso: string, deltaMs: number, expectedCount: number,
  ) => Promise<{ moved: number } | { moved: null; code?: string }>
  /** 有幾筆「會被順延」的後續停留點（已扣除鎖定與不同參與人者），用來決定要不要問、以及提示文案 */
  followingCount?: (
    anchorId: string, afterIso: string, deltaMs: number, anchorWho: readonly string[],
  ) => { total: number; outOfRange: number }
}) {
  const router = useRouter()
  const [name, setName] = useState(stop.name)
  const [category, setCategory] = useState(stop.category)
  const [startsAt, setStartsAt] = useState(utcMsToWallInput(new Date(stop.starts_at).getTime(), stop.timezone))
  const [endsAt, setEndsAt] = useState(utcMsToWallInput(new Date(stop.ends_at).getTime(), stop.timezone))
  const [notes, setNotes] = useState(stop.notes ?? '')
  const [cost, setCost] = useState(stop.estimated_cost?.toString() ?? '')
  const [locked, setLocked] = useState(stop.locked)
  // stop.participant_ids 型別是 unknown（DB 形狀不可信）。非陣列一律當成 null＝全員，
  // 與 resolveStopParticipants 的規則一致——這裡不另做「未知 id 過濾」，
  // 那會讓使用者一打開編輯器就被靜默改寫指派；未知 id 在渲染與計算時才被忽略。
  const [participantIds, setParticipantIds] = useState<string[] | null>(
    Array.isArray(stop.participant_ids) ? (stop.participant_ids as string[]) : null,
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** 儲存成功後，若結束時間有變且後面還有行程，停在這裡等使用者決定要不要一起順延。
   *  刻意**不自動順延**：時間軸拖曳是「你正看著它移動」，編輯器是填表單，
   *  預設幫使用者做大幅改動（例如把某個景點改到下午）並不安全。 */
  const [pendingCascade, setPendingCascade] = useState<
    { afterIso: string; deltaMs: number; count: number; outOfRange: number } | null
  >(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  /** 樂觀鎖的比對基準。掛載時取 props，**每次成功寫入後更新成剛寫進去的值**。
   *
   *  不能每次都直接讀 props：props 要等 router.refresh() 落地，而編輯器儲存後不會關閉。
   *  使用者連續存兩次時，第二次會拿還沒更新的舊值去比對 → 0 列命中 → 誤判成
   *  「已被其他操作變更」，但根本沒有別人動過（2026-08-11 E2E 實測復現）。
   *  「儲存後跳出順延詢問」讓這條路徑變得很常走，所以一併修掉。
   *
   *  仍然擋得住真正的外部改動：協作者改過之後 DB 的值就不等於我們上次寫入的值，一樣 0 列。 */
  const lockRef = useRef({ startsAt: stop.starts_at, endsAt: stop.ends_at })
  /** 順延詢問的基準。與 lockRef **刻意分開**——兩者的生命週期不同：
   *
   *  - `lockRef` 每次成功寫入就推進（樂觀鎖要比對「DB 現在是什麼」）
   *  - `cascadeBaseRef` **只在使用者回答詢問框之後才推進**（順延要算的是「距離上次做過順延決策
   *    以來，總共移動了多少」）
   *
   *  混用一份的後果（審查 C-1，無競態即可復現）：A 12:00-13:00、後面 B 14:00-15:00。
   *  把 A 結束改成 14:00 存檔 → 跳「順延 60 分」；發現打錯，**不回答**、改回 13:00 再存 →
   *  基準已被推到 14:00，於是 delta 變成 −60，詢問框改問「要一起提前 60 分嗎」。按下去之後
   *  A 淨變化為零、**B 卻早了一小時**，而畫面顯示綠色的「已順延 1 個行程 ✓」。
   *  同向的變體則是漏移：兩次各 +1h 只順延 +1h，A 移了 +2h 直接壓到 B 身上。
   *
   *  分開之後，未回答就連續編輯會正確累加成一次總量。 */
  const cascadeBaseRef = useRef({ startsAt: stop.starts_at, endsAt: stop.ends_at })

  async function save() {
    if (busyRef.current) return
    const trimmed = name.trim()
    const startMs = wallInputToUtcMs(startsAt, stop.timezone)
    const endMs = wallInputToUtcMs(endsAt, stop.timezone)
    if (!trimmed) return setNotice({ kind: 'error', text: '名稱不能為空' })
    if (!(endMs > startMs)) return setNotice({ kind: 'error', text: '結束時間必須晚於開始時間' })
    if (cost !== '' && Number(cost) < 0) return setNotice({ kind: 'error', text: '花費不能是負數' })
    busyRef.current = true
    setBusy(true)
    // 詢問框的生命週期嚴格綁在「最近一次成功寫入」上（審查 C-2）：不先清掉的話，
    // 這次儲存若失敗（例如撞上協作者的改動），畫面會同時留著舊的詢問框與新的錯誤訊息，
    // 使用者按下去等於在別人已經動過的狀態上再疊一次位移。
    setPendingCascade(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('stops')
        .update({
          name: trimmed,
          starts_at: new Date(startMs).toISOString(),
          ends_at: new Date(endMs).toISOString(),
          notes: notes.trim() || null,
          estimated_cost: cost === '' ? null : Number(cost),
          locked,
          category,
          participant_ids: participantIds,
        })
        // 樂觀鎖：以 lockRef（掛載時取 props、每次成功寫入後推進）比對 starts_at/ends_at，
        // 防的是本分頁尚未觀察到的外部改動（跨分頁／協作者）——比對不到列時 data 為空陣列
        // 且無 error，不可再靜默覆寫。
        // 註：這裡原本讀的是 props，舊註解也寫「需改為掛載時快照」——那件事已經做了（見
        // lockRef 的說明）。同分頁的拖曳連鎖仍由 TripView 的 moveStop 成功後關閉編輯器負責；
        // 本次新增的 shiftFollowingStops 動的是後續停留點、不動錨點，繞不過這道守衛。
        .eq('id', stop.id)
        .eq('starts_at', lockRef.current.startsAt)
        .eq('ends_at', lockRef.current.endsAt)
        .select('id')
      if (error) {
        setNotice(
          error.code === '23514'
            ? { kind: 'error', text: '輸入內容不符限制，請檢查名稱長度與數值' }
            : { kind: 'error', text: '儲存失敗，請稍後再試' },
        )
        return
      }
      if (data.length === 0) {
        setNotice({ kind: 'error', text: '此停留點的時間已被其他操作變更，請重新整理後再編輯' })
        router.refresh()
        return
      }
      // 樂觀鎖基準推進到剛寫進去的值，讓連續儲存不會誤判成外部衝突
      lockRef.current = {
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(endMs).toISOString(),
      }
      setNotice({ kind: 'success', text: '已儲存 ✓' })
      // 「後續要不要一起順延」取**結束時間**的變化量（followingShiftMs 的檔頭有四種情況對照表），
      // 基準是 cascadeBaseRef——不是 props、也不是 lockRef（見該 ref 的說明：審查 C-1）。
      // afterIso 同樣取基準的開始時間（審查 M-1）：用 props 會在「連續儲存、第一次把錨點挪到
      // 很後面」時把切點算在舊位置，連錨點前面的行程都被判成後續而一起移動。
      const base = cascadeBaseRef.current
      const deltaMs = followingShiftMs(new Date(base.endsAt).getTime(), endMs)
      const count =
        deltaMs !== 0 && onShiftFollowing && followingCount
          // anchorWho 傳**表單當下**的參與人，不是 props（審查 M-1）：同一次儲存也可能改了
          // 指派，props 還是舊值而 RPC 讀到的是剛寫入的新值，實測「畫面說 1、實際動 2」。
          // participantIds 為 null＝全員，展開成完整名冊。
          ? followingCount(stop.id, base.startsAt, deltaMs, participantIds ?? roster.map(p => p.id))
          : null
      if (count !== null && count.total > 0) {
        setPendingCascade({ afterIso: base.startsAt, deltaMs, count: count.total, outOfRange: count.outOfRange })
      } else {
        // 沒有可順延的對象（或 delta 為 0）：這一步不會有順延決策，基準直接跟上
        cascadeBaseRef.current = { ...lockRef.current }
      }
      onChanged?.()
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function remove() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    // 停留點都要被刪了，殘留的順延詢問沒有意義（錨點即將不存在，RPC 會回 P0001）
    setPendingCascade(null)
    try {
      const supabase = createClient()
      const { error } = await supabase.from('stops').delete().eq('id', stop.id)
      if (error) {
        setNotice({ kind: 'error', text: '刪除失敗，請稍後再試' })
        return
      }
      onDeleted?.()
      onChanged?.()
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border p-2 text-sm">
      <p className="text-xs text-gray-400">{stop.timezone}</p>
      <input className="rounded border p-1" value={name} onChange={e => setName(e.target.value)} maxLength={200} />
      <select className="rounded border p-1" value={category} onChange={e => setCategory(e.target.value as StopCategory)}>
        {CATEGORY_ORDER.map(c => (
          <option key={c} value={c}>{`${CATEGORY_ICON[c]} ${CATEGORY_LABEL[c]}`}</option>
        ))}
      </select>
      <label className="flex flex-col gap-1">
        開始（當地時間）
        <input className="rounded border p-1" type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        結束（當地時間）
        <input className="rounded border p-1" type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} />
      </label>
      <textarea className="rounded border p-1" maxLength={10000} placeholder="備註" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
      <input
        className="rounded border p-1"
        type="number"
        min="0"
        step="0.01"
        placeholder={`預估花費（${currency}，可留空）`}
        value={cost}
        onChange={e => setCost(e.target.value)}
      />
      <ParticipantPicker roster={roster} value={participantIds} onChange={setParticipantIds} disabled={busy} />
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)} />
        🔒 鎖定時間（航班、訂位等不可順延的行程）
      </label>
      <div className="flex gap-2">
        <button className="flex-1 rounded bg-foreground p-1 text-background disabled:opacity-50" onClick={save} disabled={busy}>儲存</button>
        {confirmDelete ? (
          <>
            <button className="rounded bg-red-600 px-2 text-white disabled:opacity-50" onClick={remove} disabled={busy}>確認刪除</button>
            <button className="rounded border px-2 disabled:opacity-50" onClick={() => setConfirmDelete(false)} disabled={busy}>取消</button>
          </>
        ) : (
          <button className="rounded border px-2 text-red-600 disabled:opacity-50" onClick={() => setConfirmDelete(true)} disabled={busy}>刪除</button>
        )}
      </div>
      {pendingCascade && (
        <div className="flex flex-col gap-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs">
          <span>
            後面還有 {pendingCascade.count} 個行程。要一起
            {pendingCascade.deltaMs > 0 ? '順延' : '提前'}{' '}
            {Math.abs(Math.round(pendingCascade.deltaMs / 60000))} 分鐘嗎？
          </span>
          <span className="text-gray-500">鎖定 🔒 的行程不會被移動。</span>
          {/* 出界警示（審查 M-3）：Timeline 的日期分頁只展開 start_date~end_date，被移出範圍的
              停留點在側欄與時間軸都沒有任何分頁能顯示它，但花費彙總與匯出照算——
              使用者只會看到「已順延 N 個行程 ✓」，然後某一筆從此看不到也編不到。 */}
          {pendingCascade.outOfRange > 0 && (
            <span className="text-red-600">
              ⚠ 其中 {pendingCascade.outOfRange} 個會被移出行程的日期範圍，移出後在畫面上看不到
              （需要先延長行程的結束日期）。
            </span>
          )}
          <div className="flex gap-2">
            <button
              className="rounded bg-foreground px-2 py-0.5 text-background disabled:opacity-50"
              disabled={busy}
              onClick={async () => {
                if (busyRef.current) return
                busyRef.current = true
                setBusy(true)
                try {
                  const result = await onShiftFollowing!(
                    stop.id, pendingCascade.afterIso, pendingCascade.deltaMs, pendingCascade.count,
                  )
                  const verb = pendingCascade.deltaMs > 0 ? '順延' : '提前'
                  setNotice(
                    result.moved === null
                      // 錯誤碼分流（審查 m-3）：這些多半**不是**暫時性的，叫使用者「稍後再試」
                      // 只會讓他一直重試。40001 是我們自己的一致性守衛，語義最明確。
                      ? result.code === '40001'
                        ? { kind: 'error', text: '後續行程在這段時間內被改過了，請重新整理再確認一次' }
                        : result.code === '42883' || result.code === '42501'
                          ? { kind: 'error', text: '這個功能目前無法使用，請重新整理頁面' }
                          : { kind: 'error', text: `${verb}失敗，請稍後再試` }
                      : { kind: 'success', text: `已${verb} ${result.moved} 個行程 ✓` },
                  )
                  cascadeBaseRef.current = { ...lockRef.current }
                } finally {
                  busyRef.current = false
                  setBusy(false)
                  setPendingCascade(null)
                }
              }}
            >
              {pendingCascade.deltaMs > 0 ? '一起順延' : '一起提前'}
            </button>
            <button
              className="rounded border px-2 py-0.5 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                // 「不順延」也是一次順延決策，基準要跟上——否則下次儲存會把這次的位移再算一遍
                cascadeBaseRef.current = { ...lockRef.current }
                setPendingCascade(null)
              }}
            >
              只改這一筆
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
      )}
    </div>
  )
}
