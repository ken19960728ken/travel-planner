'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '@/lib/domain/datetime'
import type { Stop } from './TripView'

export default function StopEditor({
  stop,
  currency,
  onDeleted,
}: {
  stop: Stop
  currency: string
  onDeleted?: () => void
}) {
  const router = useRouter()
  const [name, setName] = useState(stop.name)
  const [startsAt, setStartsAt] = useState(toDatetimeLocalValue(new Date(stop.starts_at).getTime()))
  const [endsAt, setEndsAt] = useState(toDatetimeLocalValue(new Date(stop.ends_at).getTime()))
  const [notes, setNotes] = useState(stop.notes ?? '')
  const [cost, setCost] = useState(stop.estimated_cost?.toString() ?? '')
  const [locked, setLocked] = useState(stop.locked)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [msg, setMsg] = useState('')

  async function save() {
    const trimmed = name.trim()
    const startMs = fromDatetimeLocalValue(startsAt)
    const endMs = fromDatetimeLocalValue(endsAt)
    if (!trimmed) return setMsg('名稱不能為空')
    if (!(endMs > startMs)) return setMsg('結束時間必須晚於開始時間')
    const supabase = createClient()
    const { error } = await supabase
      .from('stops')
      .update({
        name: trimmed,
        starts_at: new Date(startMs).toISOString(),
        ends_at: new Date(endMs).toISOString(),
        notes: notes.trim() || null,
        estimated_cost: cost === '' ? null : Number(cost),
        locked,
      })
      .eq('id', stop.id)
    if (error) return setMsg('儲存失敗，請稍後再試')
    setMsg('已儲存 ✓')
    router.refresh()
  }

  async function remove() {
    const supabase = createClient()
    const { error } = await supabase.from('stops').delete().eq('id', stop.id)
    if (error) return setMsg('刪除失敗，請稍後再試')
    onDeleted?.()
    router.refresh()
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border p-2 text-sm">
      <input className="rounded border p-1" value={name} onChange={e => setName(e.target.value)} />
      <label className="flex flex-col gap-1">
        開始
        <input className="rounded border p-1" type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        結束
        <input className="rounded border p-1" type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} />
      </label>
      <textarea className="rounded border p-1" placeholder="備註" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
      <input
        className="rounded border p-1"
        type="number"
        min="0"
        step="0.01"
        placeholder={`預估花費（${currency}，可留空）`}
        value={cost}
        onChange={e => setCost(e.target.value)}
      />
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)} />
        🔒 鎖定時間（航班、訂位等不可順延的行程）
      </label>
      <div className="flex gap-2">
        <button className="flex-1 rounded bg-foreground p-1 text-background" onClick={save}>儲存</button>
        {confirmDelete ? (
          <>
            <button className="rounded bg-red-600 px-2 text-white" onClick={remove}>確認刪除</button>
            <button className="rounded border px-2" onClick={() => setConfirmDelete(false)}>取消</button>
          </>
        ) : (
          <button className="rounded border px-2 text-red-600" onClick={() => setConfirmDelete(true)}>刪除</button>
        )}
      </div>
      {msg && <p className={msg.startsWith('已儲存') ? 'text-green-600' : 'text-red-600'}>{msg}</p>}
    </div>
  )
}
