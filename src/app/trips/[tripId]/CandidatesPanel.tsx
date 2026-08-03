'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { StopCategory } from '@/lib/domain/placeCategory'
import { CATEGORY_ICON, CATEGORY_LABEL, CATEGORY_ORDER } from './categoryUi'

export type Candidate = { id: string; name: string; lat: number; lng: number; place_id: string; created_at: string; category: StopCategory }

// 調整此值須同步 page.tsx 的 .limit(100) 與 migration 20260804000000_trip_candidates.sql 的 v_limit（三處目前各自寫死）
export const CANDIDATE_LIMIT = 100

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
  // day 不能是獨立 state：CandidateRow 的 key 是 c.id（見下方 CandidatesPanel），使用者在 Timeline
  // 切 Day 分頁改變 activeDay 時本列不會重掛載，若拿 activeDay 當 state 的初始值就會永遠卡在
  // 第一次掛載那天，導致「切到 Day 3 瀏覽、日期選單仍顯示 Day 1」的靜默寫入錯誤日期。改用衍生值：
  // 使用者沒手動選過（dayOverride 為 null）就永遠跟著 activeDay；手動選過之後尊重他的選擇。
  const [dayOverride, setDayOverride] = useState<string | null>(null)
  const day = dayOverride ?? activeDay
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
      if (!ok) {
        setNotice({ kind: 'error', text: '拼入行程失敗，請稍後再試' })
      } else {
        // 成功後歸零：本列理論上會隨 onPromote（移除本列候選，見上方元件註解）從父層 candidates
        // 陣列移出而整列卸載，dayOverride 隨卸載一併消失。但整合尚未接線（Task 6），不能保證父層
        // 一定會移除本列——若日後改成「保留本列並標記已拼入」，歸零可讓 day 衍生值重新跟隨
        // activeDay，而不是繼續卡在使用者這次手動選的天數，成本為零、風險為零，故一律歸零。
        setDayOverride(null)
      }
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  async function rename() {
    const name = nameInput.trim()
    if (!name || busyRef.current || busy) return
    busyRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.from('trip_candidates').update({ name }).eq('id', candidate.id).select('id')
      // error（離線、42501、P0001 等）與「RLS USING 排除時 error 為 null 但 0 列受影響」（比照
      // MembersPanel toggleRole 語義）是不同狀況，不能共用同一句提示——後者才是「未生效，請重新整理」，
      // 前者套用同一句會誤導成「只是沒刷新」，蓋掉真正的網路／權限錯誤
      if (error) {
        setNotice({ kind: 'error', text: '改名失敗，請稍後再試' })
        router.refresh()
        return
      }
      if (data.length === 0) {
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

  async function changeCategory(next: StopCategory) {
    if (busyRef.current || busy) return
    busyRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.from('trip_candidates').update({ category: next }).eq('id', candidate.id).select('id')
      // error（離線、42501、P0001 等）與「RLS USING 排除時 error 為 null 但 0 列受影響」（比照
      // MembersPanel toggleRole 語義）是不同狀況，不能共用同一句提示——後者才是「未生效，請重新整理」，
      // 前者套用同一句會誤導成「只是沒刷新」，蓋掉真正的網路／權限錯誤
      if (error) {
        setNotice({ kind: 'error', text: '改分類失敗，請稍後再試' })
        router.refresh()
        return
      }
      if (data.length === 0) {
        setNotice({ kind: 'error', text: '未生效，請重新整理' })
        router.refresh()
        return
      }
      router.refresh()
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  async function remove() {
    if (busyRef.current || busy) return
    busyRef.current = true
    setSaving(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.from('trip_candidates').delete().eq('id', candidate.id).select('id')
      // error（離線、42501、P0001 等）與「RLS USING 排除時 error 為 null 但 0 列受影響」（比照
      // MembersPanel toggleRole 語義）是不同狀況，不能共用同一句提示——後者才是「未生效，請重新整理」，
      // 前者套用同一句會誤導成「只是沒刷新」，蓋掉真正的網路／權限錯誤
      if (error) {
        setNotice({ kind: 'error', text: '刪除失敗，請稍後再試' })
      } else if (data.length === 0) {
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
      <button
        type="button"
        aria-pressed={selected}
        className="block text-left font-medium"
        onClick={() => onFocus(candidate)}
      >
        {candidate.name}
      </button>
      {canEdit && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select className="rounded border p-1" value={day} onChange={e => setDayOverride(e.target.value)} disabled={saving || busy}>
            {dayKeys.map(k => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select
            className="rounded border p-1"
            value={candidate.category}
            onChange={e => changeCategory(e.target.value as StopCategory)}
            disabled={saving || busy}
          >
            {CATEGORY_ORDER.map(c => (
              <option key={c} value={c}>{`${CATEGORY_ICON[c]} ${CATEGORY_LABEL[c]}`}</option>
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
                disabled={saving || busy}
                autoFocus
              />
              <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={saving || busy || !nameInput.trim()} onClick={rename}>
                儲存
              </button>
              <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={saving || busy} onClick={() => setEditing(false)}>
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
              <button type="button" className="rounded bg-red-600 px-1 text-white disabled:opacity-50" disabled={saving || busy} onClick={remove}>
                確認刪除
              </button>
              <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={saving || busy} onClick={() => setConfirmDelete(false)}>
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
      {candidates.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">{canEdit ? '還沒有備選，搜尋地點後按「存入備選」' : '這個行程還沒有備選'}</p>
      ) : (
        CATEGORY_ORDER.map(category => {
          const items = candidates.filter(c => c.category === category)
          if (items.length === 0) return null
          return (
            <div key={category} className="mt-2">
              <p className="text-xs font-medium text-gray-500">{`${CATEGORY_ICON[category]} ${CATEGORY_LABEL[category]}（${items.length}）`}</p>
              <ul className="mt-1 flex flex-col gap-2">
                {items.map(c => (
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
              </ul>
            </div>
          )
        })
      )}
    </details>
  )
}
