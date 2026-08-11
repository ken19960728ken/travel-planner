'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { utcMsToWallInput, wallInputToUtcMs } from '@/lib/domain/tz'
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
}: {
  stop: Stop
  currency: string
  /** 參與人名冊；為空時 ParticipantPicker 整個不渲染 */
  roster: readonly Participant[]
  onDeleted?: () => void
  onChanged?: () => void
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
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

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
        .eq('starts_at', stop.starts_at)
        .eq('ends_at', stop.ends_at)
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
      setNotice({ kind: 'success', text: '已儲存 ✓' })
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
      {notice && (
        <p className={`text-sm ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
      )}
    </div>
  )
}
