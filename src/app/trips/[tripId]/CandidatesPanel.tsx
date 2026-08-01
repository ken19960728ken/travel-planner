'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export type Candidate = { id: string; name: string; lat: number; lng: number; place_id: string; created_at: string }

const CANDIDATE_LIMIT = 100

type Notice = { kind: 'error'; text: string } | null

/** 單一備選列：改名／刪除直接在此寫 DB（比照 TripView 的 DetachedLegRow 慣例，兩段式確認 + 影響
 *  列數檢查）；拼入行程的實際寫入（插入 stops、移除本列候選）屬於整合任務，委由 onPromote 回呼
 *  交給父層完成，本檔只負責呼叫並顯示失敗提示。 */
function CandidateRow({
  candidate,
  canEdit,
  busy,
  dayKeys,
  activeDay,
  selected,
  onFocus,
  onPromote,
}: {
  candidate: Candidate
  canEdit: boolean
  busy: boolean
  dayKeys: string[]
  activeDay: string
  selected: boolean
  onFocus: (c: Candidate) => void
  onPromote: (c: Candidate, day: string) => Promise<boolean>
}) {
  const router = useRouter()
  const [day, setDay] = useState(activeDay)
  const [editing, setEditing] = useState(false)
  const [nameInput, setNameInput] = useState(candidate.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [saving, setSaving] = useState(false)
  const busyRef = useRef(false) // 同步 guard，比照 MembersPanel：state 是 render 當下閉包值，快速連點需要 ref 才擋得住

  async function promote() {
    if (busyRef.current || busy) return
    busyRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      const ok = await onPromote(candidate, day)
      if (!ok) setNotice({ kind: 'error', text: '拼入行程失敗，請稍後再試' })
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  async function rename() {
    const name = nameInput.trim()
    if (!name || busyRef.current) return
    busyRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.from('trip_candidates').update({ name }).eq('id', candidate.id).select('id')
      // RLS USING 排除時 error 為 null 但 0 列受影響（比照 MembersPanel toggleRole 語義）——
      // 不能把這種靜默失敗顯示成成功
      if (error || data.length === 0) {
        setNotice({ kind: 'error', text: '未生效，請重新整理' })
        router.refresh()
        return
      }
      setEditing(false)
      router.refresh()
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  async function remove() {
    if (busyRef.current) return
    busyRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.from('trip_candidates').delete().eq('id', candidate.id).select('id')
      if (error || data.length === 0) {
        setNotice({ kind: 'error', text: '未生效，請重新整理' })
      }
      router.refresh()
    } finally {
      busyRef.current = false
      setSaving(false)
      setConfirmDelete(false)
    }
  }

  return (
    <li className={`rounded border p-2 text-xs ${selected ? 'border-blue-500' : ''}`}>
      <button type="button" className="block text-left font-medium" onClick={() => onFocus(candidate)}>
        {candidate.name}
      </button>
      {canEdit && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select className="rounded border p-1" value={day} onChange={e => setDay(e.target.value)} disabled={saving || busy}>
            {dayKeys.map(k => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={saving || busy} onClick={promote}>
            拼入行程
          </button>
          {editing ? (
            <>
              <input
                className="w-28 rounded border p-1"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                maxLength={200}
                disabled={saving}
                autoFocus
              />
              <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={saving || !nameInput.trim()} onClick={rename}>
                儲存
              </button>
              <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={saving} onClick={() => setEditing(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded border px-1 disabled:opacity-50"
              disabled={saving || busy}
              onClick={() => {
                setNameInput(candidate.name)
                setEditing(true)
              }}
            >
              改名
            </button>
          )}
          {confirmDelete ? (
            <>
              <button type="button" className="rounded bg-red-600 px-1 text-white disabled:opacity-50" disabled={saving} onClick={remove}>
                確認刪除
              </button>
              <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={saving} onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded border px-1 text-red-600 disabled:opacity-50"
              disabled={saving || busy}
              onClick={() => setConfirmDelete(true)}
            >
              刪除
            </button>
          )}
        </div>
      )}
      {notice && <p className="mt-1 text-red-600">{notice.text}</p>}
    </li>
  )
}

/** 備選地點面板（Plan 6 Task 3）：清單由 page.tsx 併發查詢後以 props 傳入，本元件不自行 fetch。
 *  viewer 唯讀語義比照 TripView 156 行：資料可見，只是不渲染日期選單／拼入行程／改名／刪除等寫入出口。 */
export default function CandidatesPanel({
  candidates,
  loadError,
  canEdit,
  busy,
  dayKeys,
  activeDay,
  selectedCandidateId,
  onFocus,
  onPromote,
}: {
  candidates: Candidate[]
  loadError: boolean
  canEdit: boolean
  busy: boolean
  dayKeys: string[]
  activeDay: string
  selectedCandidateId: string | null
  onFocus: (c: Candidate) => void
  onPromote: (c: Candidate, day: string) => Promise<boolean>
}) {
  return (
    <details className="mt-2 rounded border p-2" open>
      <summary className="cursor-pointer text-sm font-medium">
        備選（{candidates.length}）
        {candidates.length >= CANDIDATE_LIMIT && <span className="ml-1 font-normal text-red-600">已達上限 100，請先拼入行程或刪除</span>}
      </summary>
      {loadError && <p className="mt-1 text-xs text-red-600">備選讀取失敗，清單可能不完整</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {candidates.map(c => (
          <CandidateRow
            key={c.id}
            candidate={c}
            canEdit={canEdit}
            busy={busy}
            dayKeys={dayKeys}
            activeDay={activeDay}
            selected={selectedCandidateId === c.id}
            onFocus={onFocus}
            onPromote={onPromote}
          />
        ))}
        {candidates.length === 0 && (
          <li className="text-sm text-gray-500">{canEdit ? '還沒有備選，搜尋地點後按「存入備選」' : '這個行程還沒有備選'}</li>
        )}
      </ul>
    </details>
  )
}
