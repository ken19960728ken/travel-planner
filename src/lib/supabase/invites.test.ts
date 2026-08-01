import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && anonKey && serviceKey)

// 護欄：整合測試會寫入與刪除資料，只允許對本地 Supabase 執行
if (url && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行整合測試（防止誤打正式環境）')
}

function newUserClient(): SupabaseClient {
  return createClient(url!, anonKey!, { auth: { persistSession: false } })
}

describe.skipIf(!hasEnv)('trip_invites + accept RPC + 權限收緊（需本地 Supabase）', () => {
  let admin: SupabaseClient
  let owner: SupabaseClient
  let editor: SupabaseClient
  let viewer: SupabaseClient
  let stranger: SupabaseClient
  let anon: SupabaseClient
  let ownerId: string | undefined
  let editorId: string | undefined
  let viewerId: string | undefined
  let strangerId: string | undefined
  let tripId: string
  const userIds: string[] = []
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'test-password-1234'

  async function makeUser(role: string): Promise<{ client: SupabaseClient; id: string }> {
    const email = `invites-${role}-${suffix}@test.local`
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    const client = newUserClient()
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password })
    if (signInErr) throw signInErr // 未登入的 client 會被誤判成走 anon 角色，讓後續斷言看似通過但其實沒測到東西
    userIds.push(data.user.id)
    return { client, id: data.user.id }
  }

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    anon = newUserClient()

    const o = await makeUser('owner')
    owner = o.client
    ownerId = o.id
    const e = await makeUser('editor')
    editor = e.client
    editorId = e.id
    const v = await makeUser('viewer')
    viewer = v.client
    viewerId = v.id
    const s = await makeUser('stranger')
    stranger = s.client
    strangerId = s.id

    const { data: trip, error } = await owner
      .from('trips')
      .insert({ title: 'invites 測試行程', start_date: '2026-09-01', end_date: '2026-09-05', currency: 'JPY' })
      .select('id')
      .single()
    if (error) throw error
    tripId = trip.id

    const { error: memberErr } = await admin.from('trip_members').insert([
      { trip_id: tripId, user_id: editorId, role: 'editor' },
      { trip_id: tripId, user_id: viewerId, role: 'viewer' },
    ])
    if (memberErr) throw memberErr
  })

  afterAll(async () => {
    if (tripId) await admin.from('trips').delete().eq('id', tripId) // trip_invites/trip_members 隨 cascade 清掉
    for (const id of userIds) await admin.auth.admin.deleteUser(id)
  })

  // ---- 1. 建邀請的權限與效期封頂 ----

  it('owner 建邀請成功且能列出', async () => {
    const { data, error } = await owner
      .from('trip_invites')
      .insert({ trip_id: tripId, role: 'editor' })
      .select('id, role')
      .single()
    expect(error).toBeNull()
    expect(data?.role).toBe('editor')

    const { data: list, error: listErr } = await owner
      .from('trip_invites').select('id').eq('trip_id', tripId)
    expect(listErr).toBeNull()
    expect(list!.map((r) => r.id)).toContain(data!.id)
  })

  it('trip_invites 沒有 update policy/grant：owner 想延長 expires_at 也被拒（30 天上限無法被繞過）', async () => {
    const { data: invite, error: invErr } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'viewer' }).select('id').single()
    if (invErr) throw invErr
    const farFuture = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString()
    const { error } = await owner.from('trip_invites').update({ expires_at: farFuture }).eq('id', invite.id)
    expect(error).not.toBeNull()
  })

  it('editor 對邀請的 delete 被 owner-only policy 排除：0 列受影響，邀請仍在', async () => {
    const { data: invite, error: invErr } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'viewer' }).select('id').single()
    if (invErr) throw invErr
    const { error } = await editor.from('trip_invites').delete().eq('id', invite.id)
    expect(error).toBeNull() // USING 排除，不是錯誤，是靜默 0 列
    const { data: stillThere } = await admin.from('trip_invites').select('id').eq('id', invite.id).maybeSingle()
    expect(stillThere?.id).toBe(invite.id)
    await owner.from('trip_invites').delete().eq('id', invite.id) // 清理
  })

  it('editor / viewer / 非成員 建邀請一律被拒（42501）', async () => {
    for (const client of [editor, viewer, stranger]) {
      const { error } = await client
        .from('trip_invites').insert({ trip_id: tripId, role: 'viewer' })
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    }
  })

  it('owner 建邀請 expires_at 超過 30 天上限被拒（42501）', async () => {
    const farFuture = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    const { error } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'viewer', expires_at: farFuture })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  // ---- 2. 邀請不可見性（token 本身即機密） ----

  it('editor / viewer / 非成員 select 邀請 → 0 列', async () => {
    for (const client of [editor, viewer, stranger]) {
      const { data, error } = await client.from('trip_invites').select('id').eq('trip_id', tripId)
      expect(error).toBeNull()
      expect(data).toEqual([])
    }
  })

  it('anon（未登入）select 邀請 → 錯誤（無 grant）', async () => {
    const { error } = await anon.from('trip_invites').select('id').eq('trip_id', tripId)
    expect(error).not.toBeNull()
  })

  // ---- 3. accept_trip_invite 的角色語義（不升不降） ----

  it('新使用者 accept editor 邀請 → trip_members 出現 editor 列並回傳 trip_id', async () => {
    const { data: invite, error: invErr } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'editor' }).select('id').single()
    if (invErr) throw invErr

    const newbie = await makeUser('newbie')
    const { data: acceptedTripId, error } = await newbie.client.rpc('accept_trip_invite', { p_token: invite.id })
    expect(error).toBeNull()
    expect(acceptedTripId).toBe(tripId)

    const { data: member } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', newbie.id).single()
    expect(member?.role).toBe('editor')

    // 同人重複 accept → 冪等，角色不變、不報錯
    const { data: second, error: secondErr } = await newbie.client.rpc('accept_trip_invite', { p_token: invite.id })
    expect(secondErr).toBeNull()
    expect(second).toBe(tripId)
    const { data: memberAfter } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', newbie.id).single()
    expect(memberAfter?.role).toBe('editor')
  })

  it('新使用者 accept viewer 邀請 → trip_members 出現 viewer 列', async () => {
    const { data: invite, error: invErr } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'viewer' }).select('id').single()
    if (invErr) throw invErr

    const newbie = await makeUser('newbie-viewer')
    const { data: acceptedTripId, error } = await newbie.client.rpc('accept_trip_invite', { p_token: invite.id })
    expect(error).toBeNull()
    expect(acceptedTripId).toBe(tripId)

    const { data: member } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', newbie.id).single()
    expect(member?.role).toBe('viewer')
  })

  it('既有 viewer 成員 accept editor 邀請 → 角色仍是 viewer（不升級）', async () => {
    const { data: invite, error: invErr } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'editor' }).select('id').single()
    if (invErr) throw invErr

    const { data: acceptedTripId, error } = await viewer.rpc('accept_trip_invite', { p_token: invite.id })
    expect(error).toBeNull()
    expect(acceptedTripId).toBe(tripId)

    const { data: member } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', viewerId).single()
    expect(member?.role).toBe('viewer')
  })

  it('owner 自己 accept 邀請 → 仍是 owner（不降級）', async () => {
    const { data: invite, error: invErr } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'viewer' }).select('id').single()
    if (invErr) throw invErr

    const { data: acceptedTripId, error } = await owner.rpc('accept_trip_invite', { p_token: invite.id })
    expect(error).toBeNull()
    expect(acceptedTripId).toBe(tripId)

    const { data: member } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', ownerId).single()
    expect(member?.role).toBe('owner')
  })

  // ---- 4. 過期／偽造 token 與 anon 呼叫 RPC ----

  it('過期邀請與亂造 token 回應皆為 null（不可區分）；anon 呼叫 RPC → 錯誤（execute 已收回）', async () => {
    const { data: invite, error: invErr } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'viewer' }).select('id').single()
    if (invErr) throw invErr
    const { error: expireErr } = await admin
      .from('trip_invites').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', invite.id)
    if (expireErr) throw expireErr

    const expiredCaller = await makeUser('expired-caller')
    const expiredResponse = await expiredCaller.client.rpc('accept_trip_invite', { p_token: invite.id })
    expect(expiredResponse.error).toBeNull()
    expect(expiredResponse.data).toBeNull()

    const forgedCaller = await makeUser('forged-caller')
    const forgedResponse = await forgedCaller.client
      .rpc('accept_trip_invite', { p_token: '00000000-0000-0000-0000-000000000000' })
    expect(forgedResponse.error).toBeNull()
    expect(forgedResponse.data).toBeNull()
    // 兩者回應不可區分：不只 data 皆為 null，連 error 都同為 null（沒有任何欄位能讓呼叫者分辨
    // 「token 過期」與「token 根本不存在」——這正是 RPC 語義設計要達成的效果）
    expect(forgedResponse).toEqual(expiredResponse)

    const { error: anonErr } = await anon.rpc('accept_trip_invite', { p_token: invite.id })
    expect(anonErr).not.toBeNull()
  })

  // ---- 5. 撤銷 ----

  it('owner 撤銷邀請後 accept → null', async () => {
    const { data: invite, error: invErr } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'viewer' }).select('id').single()
    if (invErr) throw invErr
    const { error: delErr } = await owner.from('trip_invites').delete().eq('id', invite.id)
    expect(delErr).toBeNull()

    const revokedCaller = await makeUser('revoked-caller')
    const { data, error } = await revokedCaller.client.rpc('accept_trip_invite', { p_token: invite.id })
    expect(error).toBeNull()
    expect(data).toBeNull()
  })

  // ---- 6. trips 欄位級 GRANT 收緊 + regenerate_share_token ----

  it('editor 可改 title（白名單欄位），但直接改 share_token 一律被拒（owner 也不例外）', async () => {
    const { error: titleErr } = await editor.from('trips').update({ title: 'invites 測試行程（改）' }).eq('id', tripId)
    expect(titleErr).toBeNull()

    const { error: editorShareErr } = await editor
      .from('trips').update({ share_token: '11111111-1111-1111-1111-111111111111' }).eq('id', tripId)
    expect(editorShareErr).not.toBeNull()
    expect(editorShareErr!.code).toBe('42501')

    const { error: ownerShareErr } = await owner
      .from('trips').update({ share_token: '22222222-2222-2222-2222-222222222222' }).eq('id', tripId)
    expect(ownerShareErr).not.toBeNull()
    expect(ownerShareErr!.code).toBe('42501')
  })

  it('owner_id 不在欄位白名單內：owner 想改 owner_id（模擬轉移所有權）也被拒', async () => {
    const { error } = await owner
      .from('trips').update({ owner_id: editorId! }).eq('id', tripId)
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  it('regenerate_share_token：owner 呼叫成功且 token 改變；editor / 非成員 / anon 呼叫皆被拒', async () => {
    const { data: before } = await admin.from('trips').select('share_token').eq('id', tripId).single()

    const { data: editorAttempt, error: editorErr } = await editor.rpc('regenerate_share_token', { p_trip_id: tripId })
    expect(editorAttempt).toBeNull()
    expect(editorErr).not.toBeNull()
    expect(editorErr!.code).toBe('42501')

    const { data: strangerAttempt, error: strangerErr } = await stranger.rpc('regenerate_share_token', { p_trip_id: tripId })
    expect(strangerAttempt).toBeNull()
    expect(strangerErr).not.toBeNull()
    expect(strangerErr!.code).toBe('42501')

    const { error: anonErr } = await anon.rpc('regenerate_share_token', { p_trip_id: tripId })
    expect(anonErr).not.toBeNull() // execute 未授予 anon

    const { data: newToken, error } = await owner.rpc('regenerate_share_token', { p_trip_id: tripId })
    expect(error).toBeNull()
    expect(newToken).toBeTruthy()
    expect(newToken).not.toBe(before?.share_token)

    const { data: after } = await admin.from('trips').select('share_token').eq('id', tripId).single()
    expect(after?.share_token).toBe(newToken)
  })

  // ---- 7. 回歸：GRANT 手術未誤傷 stops/legs ----

  it('回歸：editor 仍可正常 update stops 與 legs', async () => {
    const { data: stopA, error: stopAErr } = await owner
      .from('stops')
      .insert({
        trip_id: tripId, name: '回歸測試景點A', lat: 35.0, lng: 135.0, timezone: 'Asia/Tokyo',
        starts_at: '2026-09-01T09:00:00Z', ends_at: '2026-09-01T10:00:00Z',
      })
      .select('id')
      .single()
    if (stopAErr) throw stopAErr
    const { data: stopB, error: stopBErr } = await owner
      .from('stops')
      .insert({
        trip_id: tripId, name: '回歸測試景點B', lat: 35.1, lng: 135.1, timezone: 'Asia/Tokyo',
        starts_at: '2026-09-01T11:00:00Z', ends_at: '2026-09-01T12:00:00Z',
      })
      .select('id')
      .single()
    if (stopBErr) throw stopBErr

    const { error: stopUpdateErr } = await editor.from('stops').update({ name: '回歸測試景點A（改）' }).eq('id', stopA.id)
    expect(stopUpdateErr).toBeNull()

    const { data: leg, error: legErr } = await owner
      .from('legs')
      .insert({
        trip_id: tripId, from_stop_id: stopA.id, to_stop_id: stopB.id,
        mode: 'custom', source: 'manual', duration_minutes: 30,
      })
      .select('id')
      .single()
    if (legErr) throw legErr

    const { error: legUpdateErr } = await editor.from('legs').update({ duration_minutes: 45 }).eq('id', leg.id)
    expect(legUpdateErr).toBeNull()
  })

  // ---- 8. 角色提權封堵（M-2） ----

  it('owner 直接 INSERT 一列 role=owner 造第二個 owner → 被拒（42501，20260803000001 補的 INSERT 白名單）', async () => {
    // db-expert 審查發現：M-2 最初只補了 UPDATE policy，INSERT policy（「owner 可管理成員」）
    // 當時仍只驗 is_trip_owner、未限制新列 role，owner 可繞過 UPDATE 白名單直接插一列 role='owner'
    // 造出第二個 owner（PoC 已在 20260803000001_invites_and_grants_v2.sql 套用前實測成功，
    // 套用後不再成功）。此測試鎖住這條路徑不再迴歸。
    const { error } = await owner
      .from('trip_members').insert({ trip_id: tripId, user_id: strangerId!, role: 'owner' })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')

    const { data: members } = await admin.from('trip_members').select('user_id, role').eq('trip_id', tripId).eq('role', 'owner')
    expect(members).toHaveLength(1) // 仍只有一個 owner
  })

  it('owner 把成員角色改為 owner → 被拒（42501，白名單擋下）', async () => {
    const { error } = await owner.from('trip_members').update({ role: 'owner' }).eq('trip_id', tripId).eq('user_id', editorId!)
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  it('owner 把成員角色在 editor↔viewer 間調整 → 正常', async () => {
    const { error: toViewerErr } = await owner
      .from('trip_members').update({ role: 'viewer' }).eq('trip_id', tripId).eq('user_id', editorId!)
    expect(toViewerErr).toBeNull()
    const { data: afterDowngrade } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', editorId!).single()
    expect(afterDowngrade?.role).toBe('viewer')

    const { error: toEditorErr } = await owner
      .from('trip_members').update({ role: 'editor' }).eq('trip_id', tripId).eq('user_id', editorId!)
    expect(toEditorErr).toBeNull()
    const { data: afterUpgrade } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', editorId!).single()
    expect(afterUpgrade?.role).toBe('editor')
  })

  it('降級成員時撤銷全部邀請，被降級者無法用舊 editor 連結升回去（審查 I-1 迴歸鎖）', async () => {
    // 邀請連結是 bearer token：被降級者可「自行退出 → 用舊 editor 連結重新加入」把自己升回 editor。
    // MembersPanel.toggleRole 先撤銷該行程全部邀請再改角色，這裡鎖住 DB 層的可行性前提。
    const { data: inv } = await owner
      .from('trip_invites')
      .insert({ trip_id: tripId, role: 'editor', expires_at: new Date(Date.now() + 3 * 24 * 3600_000).toISOString() })
      .select('id').single()
    expect(inv?.id).toBeTruthy()

    // toggleRole 的第一步：撤銷該行程全部邀請
    const { error: revokeErr } = await owner.from('trip_invites').delete().eq('trip_id', tripId)
    expect(revokeErr).toBeNull()

    // 被降級者退出後拿舊連結重來 → RPC 找不到邀請，回 null，不會重新入團
    await admin.from('trip_members').delete().eq('trip_id', tripId).eq('user_id', editorId!)
    const { data: accepted, error: acceptErr } = await editor.rpc('accept_trip_invite', { p_token: inv!.id })
    expect(acceptErr).toBeNull()
    expect(accepted).toBeNull()
    const { data: rows } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', editorId!)
    expect(rows?.length ?? 0).toBe(0)

    // 還原：後續測試仍預期 editor 是成員
    await admin.from('trip_members').insert({ trip_id: tripId, user_id: editorId!, role: 'editor' })
  })

  it('owner 改自己的 role → 被拒（USING 排除自己這列，0 列受影響、角色不變）', async () => {
    // with check 的 user_id <> auth.uid() 是 USING 子句同時具備的條件：owner 對自己這列在
    // RLS 下「根本不可見於此 UPDATE」，因此不是 WITH CHECK 違規（無 42501），而是靜默 0 列更新
    // ——與 trip_members 既有「owner 可移除其他成員」policy 排除自己的行為一致（同為 USING 排除）。
    const { error } = await owner.from('trip_members').update({ role: 'viewer' }).eq('trip_id', tripId).eq('user_id', ownerId!)
    expect(error).toBeNull()
    const { data } = await admin
      .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', ownerId!).single()
    expect(data?.role).toBe('owner') // 未被更動
  })

  // ---- 9. 移除成員時撤銷邀請（Task 6 遺留根治：MembersPanel 移除成員時的實際查詢模式） ----

  it('owner 移除成員時可批次撤銷該行程「全部」邀請連結（不論已用未用），critic 審查後改採此設計', async () => {
    // C-1 根治紀錄：原設計曾用 accepted_by 欄位只鎖「最近一次接受者」，經 critic + PoC 證實
    // fail-open——同一條邀請連結若先後被多人接受（或 owner 自己重複點擊測試），accepted_by
    // 會被覆寫，導致被移除的人仍能用手上舊連結重新加入。改採「移除成員時撤銷該行程全部邀請」
    // ——bearer-token 分享連結（本設計無 email 定向收件人）沒有更精確的辦法能區分「誰的連結」，
    // 全部撤銷才是誠實、完整、不 fail-open 的根治（owner 事後可重新產生連結）。
    // 這裡只驗證 DB 層權限：owner 對自己的行程可以不帶 id 條件、只用 trip_id 批次刪除全部邀請列
    // （既有「owner 可撤銷邀請」policy 是 is_trip_owner(trip_id)，本就支援批次刪除，非新權限）。
    const { data: invite1, error: inv1Err } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'editor' }).select('id').single()
    if (inv1Err) throw inv1Err
    const { data: invite2, error: inv2Err } = await owner
      .from('trip_invites').insert({ trip_id: tripId, role: 'viewer' }).select('id').single()
    if (inv2Err) throw inv2Err

    const kicked = await makeUser('bulk-revoke-kicked')
    const { data: acceptedTripId, error: acceptErr } = await kicked.client.rpc('accept_trip_invite', { p_token: invite1.id })
    expect(acceptErr).toBeNull()
    expect(acceptedTripId).toBe(tripId)

    // MembersPanel.removeMember 的實際查詢：移除 trip_members 列後，批次刪掉該行程剩下的全部邀請
    await admin.from('trip_members').delete().eq('trip_id', tripId).eq('user_id', kicked.id)
    const { error: revokeErr } = await owner.from('trip_invites').delete().eq('trip_id', tripId)
    expect(revokeErr).toBeNull()

    const { data: remaining } = await admin.from('trip_invites').select('id').eq('trip_id', tripId)
    expect(remaining).toEqual([]) // 全清空——連未被任何人使用過的 invite2 也一併撤銷
    const { data: invite2StillThere } = await admin.from('trip_invites').select('id').eq('id', invite2.id).maybeSingle()
    expect(invite2StillThere).toBeNull() // 明確斷言：不是只清了 invite1，未使用過的 invite2 同樣被撤銷

    // 撤銷後即使 kicked 手上還留著舊連結，也不能再用它加入（token 已不存在）
    const { data: reAccept, error: reAcceptErr } = await kicked.client.rpc('accept_trip_invite', { p_token: invite1.id })
    expect(reAcceptErr).toBeNull()
    expect(reAccept).toBeNull()
  })
})
