'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export type MemberRole = 'owner' | 'editor' | 'viewer'
export type Member = { userId: string; role: MemberRole; displayName: string }
export type Invite = { id: string; role: 'editor' | 'viewer'; expiresAt: string }

type Notice = { kind: 'error' | 'success'; text: string } | null

const ROLE_LABEL: Record<MemberRole, string> = { owner: '擁有者', editor: '可編輯', viewer: '僅檢視' }

function expiryLabel(expiresAt: string): string {
  const remainMs = new Date(expiresAt).getTime() - Date.now()
  if (remainMs <= 0) return '已過期'
  const hours = remainMs / (60 * 60 * 1000)
  if (hours < 24) return `剩餘 ${Math.max(1, Math.ceil(hours))} 小時`
  return `剩餘 ${Math.ceil(hours / 24)} 天`
}

/** 成員面板（Task 7）：owner 視角管理成員角色/移除、產生與撤銷邀請連結；非 owner 成員可自行退出。
 *  trip_members 與 profiles 無 FK（page.tsx 已用兩段查詢併好 displayName），這裡只做展示與寫入。
 *
 *  移除成員時撤銷邀請的設計（critic 審查後定案，見 invites.test.ts 同名案例的長註解）：
 *  trip_invites 是不記名的分享連結（無 email 收件人欄位），沒有辦法精確得知「這個成員是用哪一條
 *  連結加入的」——曾嘗試加一個 accepted_by 欄位追蹤「最近一次接受者」，但 PoC 證實 fail-open：
 *  連結一旦被別人（甚至 owner 自己測試）重複點過，追蹤就會被覆寫，被移除的人仍能用舊連結重新
 *  加入。改採「移除成員時撤銷該行程全部邀請連結」——唯一不會 fail-open 的作法，owner 事後可
 *  重新產生連結給還沒加入的人。 */
export default function MembersPanel({
  tripId,
  currentUserId,
  isOwner,
  members,
  invites,
  loadError = false,
}: {
  tripId: string
  currentUserId: string
  isOwner: boolean
  members: Member[]
  /** 僅 owner 會收到非空陣列——其餘角色的 trip_invites RLS select 本就回 0 列，page.tsx 直接省查 */
  invites: Invite[]
  /** page.tsx 讀 trip_members/profiles/trip_invites 任一失敗時設 true：面板仍可開合，但不假裝資料完整 */
  loadError?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false) // 同步 guard：state 讀到的是 render 當下的閉包值，快速連點需要 ref 才擋得住
  const [notice, setNotice] = useState<Notice>(null)
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor')

  // 面板關閉再重開時，任何殘留的兩段式 confirm 都要清掉——否則使用者上次點到一半、關掉面板，
  // 重開後會直接看到「上膛」的確認鈕，形同陷阱
  function toggleOpen() {
    setOpen(o => !o)
    setConfirmRemoveUserId(null)
    setConfirmLeave(false)
    setNotice(null)
  }

  // nextRole 由呼叫端算好傳入（目標角色，非目前角色）——避免在這裡重新從「目前角色」推導一次，
  // 呼叫端（member row 的 nextRoleForToggle）已經是唯一計算來源，這裡不重複判斷以免兩處算法不同步
  async function toggleRole(userId: string, nextRole: 'editor' | 'viewer') {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      const supabase = createClient()
      // 降級才需要撤銷，且只撤 editor 連結（審查 I-1 + N-4）：邀請連結是 bearer token，未過期的
      // editor 連結會讓被降級者「自行退出 → 用舊連結重新加入」把自己升回 editor，owner 的降級形同無效。
      // 但範圍要精準——升級（viewer→editor）是在給更多權限，不需撤銷任何連結；viewer 連結被重用最多
      // 換回 viewer，無提權，故保留。順序必須先撤銷再改角色（同 removeMember 的 N-1 理由）。
      const downgrading = nextRole === 'viewer'
      if (downgrading) {
        const { error: revokeErr } = await supabase
          .from('trip_invites').delete().eq('trip_id', tripId).eq('role', 'editor')
        if (revokeErr) {
          setNotice({ kind: 'error', text: '邀請連結撤銷失敗，尚未調整角色，請稍後再試' })
          return
        }
      }
      const { data, error } = await supabase
        .from('trip_members').update({ role: nextRole }).eq('trip_id', tripId).eq('user_id', userId).select('user_id')
      if (error || data.length === 0) {
        // RLS USING 排除時 error 為 null 但 0 列受影響（比照 invites.test.ts 記載的既有語義）——
        // 不能把這種靜默失敗顯示成成功
        setNotice({
          kind: 'error',
          text: downgrading
            ? '角色調整未生效，但 editor 邀請連結已撤銷，請重新整理後再試（如需再邀請請重新產生）'
            : '角色調整未生效，請重新整理後再試',
        })
        router.refresh()
        return
      }
      setNotice({
        kind: 'success',
        text: downgrading
          ? '已調整角色 ✓（editor 邀請連結已一併撤銷，如需再邀請請重新產生）'
          : '已調整角色 ✓',
      })
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function removeMember(userId: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      const supabase = createClient()
      // 順序不可對調（審查 N-1，PoC 實證）：兩句之間有一個網路往返的窗口，若先刪成員後撤邀請，
      // 被移除者在窗口內用舊連結 accept 會成功（on conflict 不再命中），第一次踢人必定打空。
      // 先撤邀請再刪成員則任何交錯都安全：窗口內 accept 時連結已不存在，窗口前 accept 會被隨後的刪除吃掉。
      // 代價是「撤銷成功但刪成員失敗」時邀請已沒了——良性失敗，owner 重新產生連結即可。
      const { error: revokeErr } = await supabase.from('trip_invites').delete().eq('trip_id', tripId)
      if (revokeErr) {
        setNotice({ kind: 'error', text: '邀請連結撤銷失敗，尚未移除成員，請稍後再試' })
        return
      }
      const { data, error } = await supabase
        .from('trip_members').delete().eq('trip_id', tripId).eq('user_id', userId).select('user_id')
      if (error) {
        setNotice({ kind: 'error', text: '移除未生效，但該行程邀請連結已全部撤銷，請重新整理後再試（如需再邀請請重新產生）' })
        router.refresh()
        return
      }
      if (data.length === 0) {
        setNotice({ kind: 'error', text: '移除未生效，但該行程邀請連結已全部撤銷，請重新整理後再試（如需再邀請請重新產生）' })
        router.refresh()
        return
      }
      setNotice({ kind: 'success', text: '已移除 ✓（該行程所有邀請連結已一併撤銷，如需再邀請請重新產生）' })
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
      setConfirmRemoveUserId(null)
    }
  }

  async function leaveTrip() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('trip_members').delete().eq('trip_id', tripId).eq('user_id', currentUserId).select('user_id')
      if (error) {
        setNotice({ kind: 'error', text: '退出失敗，請稍後再試' })
        return
      }
      if (data.length === 0) {
        setNotice({ kind: 'error', text: '退出未生效，請重新整理後再試' })
        return
      }
      router.push('/trips')
    } finally {
      busyRef.current = false
      setBusy(false)
      setConfirmLeave(false)
    }
  }

  async function createInvite() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('trip_invites')
        .insert({ trip_id: tripId, role: inviteRole })
        .select('id')
        .single()
      if (error || !data) {
        setNotice({ kind: 'error', text: '建立邀請失敗，請稍後再試' })
        return
      }
      const link = `${location.origin}/invite/${data.id}`
      try {
        await navigator.clipboard.writeText(link)
        setNotice({ kind: 'success', text: '邀請連結已複製 ✓' })
      } catch {
        // clipboard 權限被拒或非安全情境（http）：連結直接顯示在提示裡，仍可手動複製
        setNotice({ kind: 'success', text: `已建立邀請連結：${link}` })
      }
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function revokeInvite(id: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.from('trip_invites').delete().eq('id', id).select('id')
      if (error) {
        setNotice({ kind: 'error', text: '撤銷失敗，請稍後再試' })
        return
      }
      if (data.length === 0) {
        setNotice({ kind: 'error', text: '這則邀請已不存在，請重新整理' })
        router.refresh()
        return
      }
      setNotice({ kind: 'success', text: '已撤銷 ✓' })
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="shrink-0 whitespace-nowrap rounded border px-2 py-1 text-sm"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        成員（{members.length}）
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded border bg-background p-3 text-sm shadow-lg">
          {loadError && <p className="text-xs text-red-600">成員資料讀取失敗，請重新整理再試</p>}
          {notice && (
            <p className={`mb-2 text-xs ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
          )}
          <ul className="flex flex-col gap-1">
            {members.map(m => {
              const isSelf = m.userId === currentUserId
              // 提前算成獨立、已知窄化的 const：m.role 的窄化（!== 'owner'）在下方 JSX 的 onClick
              // closure 裡不會保留（TS 對「屬性窄化」跨函式邊界不延續，即使 m 本身是迴圈內的 const），
              // 這裡先算好一個型別已確定是 'editor' | 'viewer' 的值，供 closure 安全捕捉
              const nextRoleForToggle: 'editor' | 'viewer' = m.role === 'editor' ? 'viewer' : 'editor'
              return (
                <li key={m.userId} className="flex items-center justify-between gap-2 rounded border p-1.5 text-xs">
                  <span>
                    {m.displayName}
                    <span className="ml-1 text-gray-500">（{ROLE_LABEL[m.role]}）</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {/* m.role !== 'owner' 防線二：唯一 owner 恆為 isSelf（DB 白名單擋第二個 owner），
                        但 role 型別斷言不該只靠這個推論成立，寫死排除避免日後資料異常時對 owner 顯示錯誤動作 */}
                    {isOwner && !isSelf && m.role !== 'owner' && (
                      <>
                        <button
                          type="button"
                          className="rounded border px-1 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => toggleRole(m.userId, nextRoleForToggle)}
                        >
                          切換為 {nextRoleForToggle}
                        </button>
                        {confirmRemoveUserId === m.userId ? (
                          <>
                            <button
                              type="button"
                              className="rounded bg-red-600 px-1 text-white disabled:opacity-50"
                              disabled={busy}
                              onClick={() => removeMember(m.userId)}
                            >
                              確認移除
                            </button>
                            <button
                              type="button"
                              className="rounded border px-1 disabled:opacity-50"
                              disabled={busy}
                              onClick={() => setConfirmRemoveUserId(null)}
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="rounded border px-1 text-red-600 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => setConfirmRemoveUserId(m.userId)}
                          >
                            移除成員
                          </button>
                        )}
                      </>
                    )}
                    {!isOwner && isSelf && (
                      confirmLeave ? (
                        <>
                          <button
                            type="button"
                            className="rounded bg-red-600 px-1 text-white disabled:opacity-50"
                            disabled={busy}
                            onClick={leaveTrip}
                          >
                            確認退出
                          </button>
                          <button
                            type="button"
                            className="rounded border px-1 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => setConfirmLeave(false)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="rounded border px-1 text-red-600 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => setConfirmLeave(true)}
                        >
                          退出行程
                        </button>
                      )
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
          {isOwner && (
            <div className="mt-3 border-t pt-2">
              <p className="mb-1 font-medium">邀請旅伴</p>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs">
                  邀請角色
                  <select
                    className="rounded border p-1"
                    value={inviteRole}
                    onChange={e => setInviteRole(e.target.value as 'editor' | 'viewer')}
                  >
                    <option value="editor">可編輯</option>
                    <option value="viewer">僅檢視</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                  disabled={busy}
                  onClick={createInvite}
                >
                  產生邀請連結
                </button>
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {invites.map(inv => (
                  <li key={inv.id} className="flex items-center justify-between gap-2 text-xs">
                    <span>{ROLE_LABEL[inv.role]}・{expiryLabel(inv.expiresAt)}</span>
                    <button
                      type="button"
                      className="rounded border px-1 text-red-600 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => revokeInvite(inv.id)}
                    >
                      撤銷
                    </button>
                  </li>
                ))}
                {invites.length === 0 && <li className="text-gray-500">尚無邀請連結</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
