'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { MAX_PARTICIPANTS, type Participant } from '@/lib/domain/participants'
import { participantColorAt, PARTICIPANT_COLORS } from './participantUi'
import ParticipantChip from './ParticipantChip'
import type { Member } from './MembersPanel'

type Notice = { kind: 'error' | 'success'; text: string } | null

const NAME_MAX = 40 // 與 upsert_trip_participant 的 length 檢查同值

/** 參與人名冊面板（2026-08-11）。
 *
 *  【為何不併進 MembersPanel】兩者權責不同：成員是**存取控制**（誰能開這個行程、誰能編輯，
 *  只有 owner 能改）；參與人是**行程內容**（誰去了哪裡，editor 就能改，而且可以是沒有帳號的
 *  同行者）。把不同權限模型的東西放同一個面板，遲早有人把 isOwner 的判斷套到參與人上。
 *  MembersPanel 也已經 516 行。
 *
 *  【寫入一律走 RPC】名冊是單一 jsonb 欄位，client 端「讀出整份 → 改 → 寫回」是典型的
 *  lost update：兩個人同時各加一個人，後寫入者會靜默蓋掉前者。RPC 在 SQL 端合併，天然原子。 */
export default function ParticipantsPanel({
  tripId,
  roster,
  members,
  canEdit,
  affectedStopCounts,
}: {
  tripId: string
  roster: readonly Participant[]
  /** 用來提供「從成員加入」的候選；無帳號同行者不在其中 */
  members: readonly Member[]
  canEdit: boolean
  /** participantId → 指派到他的停留點數，移除前用來提示後果。
   *  **傳 Record 而非函式**：page.tsx 是 server component，函式無法序列化給 client component。 */
  affectedStopCounts: Readonly<Record<string, number>>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false) // 同步 guard：state 是 render 當下的閉包值，快速連點擋不住
  const [notice, setNotice] = useState<Notice>(null)
  const [newName, setNewName] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const full = roster.length >= MAX_PARTICIPANTS
  const unlisted = members.filter(m => !roster.some(p => p.user_id === m.userId))

  // 面板關閉再重開時清掉殘留的兩段式 confirm 與編輯狀態——否則重開後會直接看到「上膛」的
  // 確認鈕，形同陷阱（同 MembersPanel 的 toggleOpen 理由）
  function toggleOpen() {
    setOpen(o => !o)
    setConfirmRemoveId(null)
    setEditingId(null)
    setNotice(null)
  }

  async function run(fn: (supabase: ReturnType<typeof createClient>) => Promise<string | null>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const err = await fn(createClient())
      if (err) {
        setNotice({ kind: 'error', text: err })
        return
      }
      setNotice(null)
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function errorText(code: string | undefined): string {
    if (code === '42501') return '你沒有編輯這個行程的權限'
    if (code === '22023') return `名稱不能為空，且不超過 ${NAME_MAX} 字`
    if (code === '23514') return `參與人最多 ${MAX_PARTICIPANTS} 人`
    return '儲存失敗，請稍後再試'
  }

  function add(userId: string | null, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return setNotice({ kind: 'error', text: '名稱不能為空' })
    if (trimmed.length > NAME_MAX) return setNotice({ kind: 'error', text: `名稱不能超過 ${NAME_MAX} 字` })
    void run(async supabase => {
      const { error } = await supabase.rpc('upsert_trip_participant', {
        p_trip_id: tripId,
        p_id: crypto.randomUUID(),
        p_user_id: userId,
        p_name: trimmed,
        // 顏色依目前人數指派並**存進名冊**，不是每次由索引推算——後者在移除一個人之後
        // 會讓後面所有人的顏色跟著位移，畫面上像是換了一組人
        p_color: participantColorAt(roster.length),
      })
      return error ? errorText(error.code) : null
    })
    setNewName('')
  }

  function update(p: Participant, changes: Partial<Pick<Participant, 'name' | 'color'>>) {
    const name = (changes.name ?? p.name).trim()
    if (!name) return setNotice({ kind: 'error', text: '名稱不能為空' })
    void run(async supabase => {
      const { error } = await supabase.rpc('upsert_trip_participant', {
        p_trip_id: tripId,
        p_id: p.id,
        p_user_id: p.user_id,
        p_name: name,
        p_color: changes.color ?? p.color,
      })
      return error ? errorText(error.code) : null
    })
    setEditingId(null)
  }

  function remove(id: string) {
    void run(async supabase => {
      const { error } = await supabase.rpc('remove_trip_participant', {
        p_trip_id: tripId,
        p_participant_id: id,
      })
      return error ? errorText(error.code) : null
    })
    setConfirmRemoveId(null)
  }

  return (
    <div className="relative">
      <button
        className="rounded border px-2 py-1 text-sm"
        onClick={toggleOpen}
        aria-expanded={open}
      >
        🧑‍🤝‍🧑 參與人{roster.length > 0 ? `（${roster.length}）` : ''}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 flex w-80 flex-col gap-2 rounded border bg-background p-3 text-sm shadow-lg">
          {roster.length === 0 && (
            <p className="text-xs text-gray-500">
              還沒有參與人。加入之後，可以在每個停留點標記「誰會去」，分頭行動的路線與分帳就會分開算。
            </p>
          )}

          <ul className="flex flex-col gap-1">
            {roster.map(p => (
              <li key={p.id} className="flex items-center gap-2">
                <ParticipantChip participant={p} />
                {editingId === p.id ? (
                  <input
                    className="min-w-0 flex-1 rounded border p-1"
                    value={editingName}
                    maxLength={NAME_MAX}
                    autoFocus
                    onChange={e => setEditingName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') update(p, { name: editingName })
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={p.name}>{p.name}</span>
                )}
                <span className="shrink-0 text-xs text-gray-400">
                  {p.user_id === null ? '同行者' : '成員'}
                </span>

                {canEdit && editingId !== p.id && (
                  <>
                    <button
                      className="shrink-0 text-xs underline disabled:opacity-50"
                      disabled={busy}
                      onClick={() => { setEditingId(p.id); setEditingName(p.name) }}
                    >
                      改名
                    </button>
                    <select
                      className="shrink-0 rounded border text-xs disabled:opacity-50"
                      value={p.color}
                      disabled={busy}
                      aria-label={`${p.name} 的顏色`}
                      onChange={e => update(p, { color: e.target.value })}
                    >
                      {/* 允許重複選色：首字才是識別主體，顏色只是輔助（participantUi.ts 檔頭） */}
                      {PARTICIPANT_COLORS.map((c, ci) => (
                        <option key={c} value={c}>{`色 ${ci + 1}`}</option>
                      ))}
                      {!PARTICIPANT_COLORS.includes(p.color) && (
                        <option value={p.color}>目前</option>
                      )}
                    </select>
                    {confirmRemoveId === p.id ? (
                      <button
                        className="shrink-0 rounded bg-red-600 px-1 text-xs text-white disabled:opacity-50"
                        disabled={busy}
                        onClick={() => remove(p.id)}
                      >
                        確認
                      </button>
                    ) : (
                      <button
                        className="shrink-0 text-xs text-red-600 underline disabled:opacity-50"
                        disabled={busy}
                        onClick={() => setConfirmRemoveId(p.id)}
                      >
                        移除
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>

          {/* 移除前明講後果：只指派給這個人的停留點會回到「全員」，因為資料模型無法表達「沒有人去」 */}
          {confirmRemoveId !== null && (
            <p className="rounded bg-amber-50 p-1 text-xs text-amber-800">
              {(() => {
                const n = affectedStopCounts[confirmRemoveId] ?? 0
                return n === 0
                  ? '這個人沒有被指派到任何停留點。'
                  : `${n} 個停留點指派了這個人；只剩他一個人的停留點會回到「全員」。`
              })()}
            </p>
          )}

          {canEdit && (
            <div className="flex flex-col gap-1 border-t pt-2">
              {full ? (
                <p className="text-xs text-gray-500">已達上限 {MAX_PARTICIPANTS} 人。</p>
              ) : (
                <>
                  {unlisted.length > 0 && (
                    <select
                      className="rounded border p-1 disabled:opacity-50"
                      value=""
                      disabled={busy}
                      aria-label="從成員加入"
                      onChange={e => { if (e.target.value) add(e.target.value, members.find(m => m.userId === e.target.value)!.displayName) }}
                    >
                      <option value="">＋ 從成員加入…</option>
                      {unlisted.map(m => (
                        <option key={m.userId} value={m.userId}>{m.displayName}</option>
                      ))}
                    </select>
                  )}
                  <div className="flex gap-1">
                    <input
                      className="min-w-0 flex-1 rounded border p-1"
                      placeholder="同行者名字（不需帳號）"
                      value={newName}
                      maxLength={NAME_MAX}
                      onChange={e => setNewName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') add(null, newName) }}
                    />
                    <button
                      className="shrink-0 rounded bg-foreground px-2 text-background disabled:opacity-50"
                      disabled={busy || newName.trim() === ''}
                      onClick={() => add(null, newName)}
                    >
                      加入
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <p className="text-xs text-gray-400">
            播放時圖示顯示名字的第一個字。想改成別的字就直接改名。
          </p>

          {notice && (
            <p className={notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}>{notice.text}</p>
          )}
        </div>
      )}
    </div>
  )
}
