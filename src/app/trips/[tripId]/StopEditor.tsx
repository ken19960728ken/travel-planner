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
  onShiftFollowing?: (anchorId: string, afterIso: string, deltaMs: number) => Promise<number | null>
  /** 有幾筆「會被順延」的後續停留點（已扣除鎖定與不同參與人者），用來決定要不要問、以及提示文案 */
  followingCount?: (anchorId: string, afterIso: string) => number
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
  const [pendingCascade, setPendingCascade] = useState<{ afterIso: string; deltaMs: number; count: number } | null>(null)
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
        // 樂觀鎖：以「當下 props 值」比對 starts_at/ends_at，防的是本分頁尚未觀察到的
        // 外部改動（跨分頁／協作者）——比對不到列時 data 為空陣列且無 error，不可再靜默覆寫。
        // 同分頁的舊表單覆寫（拖曳連鎖）由 TripView 的 moveStop 成功後關閉編輯器負責；
        // 若未來新增「同分頁改時間但不關編輯器」的寫入路徑，此守衛擋不住，需改為掛載時快照
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
      // 寫入成功：基準推進到剛寫進去的值，讓連續儲存不會誤判成外部衝突
      const prevEndsAt = lockRef.current.endsAt
      lockRef.current = {
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(endMs).toISOString(),
      }
      setNotice({ kind: 'success', text: '已儲存 ✓' })
      // 「後續要不要一起順延」取**結束時間**的變化量（followingShiftMs 的檔頭說明了為什麼
      // 不是開始時間）。0 就完全不問——例如「提早到但同時離開」，後面本來就不用動。
      const deltaMs = followingShiftMs(new Date(prevEndsAt).getTime(), endMs)
      if (deltaMs !== 0 && onShiftFollowing && followingCount) {
        const count = followingCount(stop.id, stop.starts_at)
        if (count > 0) setPendingCascade({ afterIso: stop.starts_at, deltaMs, count })
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
          <div className="flex gap-2">
            <button
              className="rounded bg-foreground px-2 py-0.5 text-background disabled:opacity-50"
              disabled={busy}
              onClick={async () => {
                if (busyRef.current) return
                busyRef.current = true
                setBusy(true)
                try {
                  const moved = await onShiftFollowing!(stop.id, pendingCascade.afterIso, pendingCascade.deltaMs)
                  setNotice(
                    moved === null
                      ? { kind: 'error', text: '順延失敗，請稍後再試' }
                      : { kind: 'success', text: `已順延 ${moved} 個行程 ✓` },
                  )
                } finally {
                  busyRef.current = false
                  setBusy(false)
                  setPendingCascade(null)
                }
              }}
            >
              一起順延
            </button>
            <button
              className="rounded border px-2 py-0.5 disabled:opacity-50"
              disabled={busy}
              onClick={() => setPendingCascade(null)}
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
