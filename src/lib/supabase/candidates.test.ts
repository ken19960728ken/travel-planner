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

describe.skipIf(!hasEnv)('trip_candidates 權限面與約束（需本地 Supabase）', () => {
  let admin: SupabaseClient
  let owner: SupabaseClient
  let editor: SupabaseClient
  let viewer: SupabaseClient
  let stranger: SupabaseClient
  let anon: SupabaseClient
  let editorId: string | undefined
  let viewerId: string | undefined
  let strangerId: string | undefined
  let tripAId: string
  let tripBId: string
  let tripCId: string
  let baselineCandidateId: string
  let editorCandidateId: string
  const userIds: string[] = []
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'test-password-1234'
  let placeSeq = 0

  function placeId(label: string): string {
    placeSeq += 1
    return `cand-test-${suffix}-${label}-${placeSeq}`
  }

  async function makeUser(role: string): Promise<{ client: SupabaseClient; id: string }> {
    const email = `cand-test-${role}-${suffix}@test.local`
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

    owner = (await makeUser('owner')).client
    const e = await makeUser('editor')
    editor = e.client
    editorId = e.id
    const v = await makeUser('viewer')
    viewer = v.client
    viewerId = v.id
    const s = await makeUser('stranger')
    stranger = s.client
    strangerId = s.id

    const { data: tripA, error: tripAErr } = await owner
      .from('trips')
      .insert({ title: 'cand-test 行程 A', start_date: '2026-09-01', end_date: '2026-09-05', currency: 'JPY' })
      .select('id')
      .single()
    if (tripAErr) throw tripAErr
    tripAId = tripA.id

    const { data: tripB, error: tripBErr } = await owner
      .from('trips')
      .insert({ title: 'cand-test 行程 B', start_date: '2026-09-01', end_date: '2026-09-05', currency: 'JPY' })
      .select('id')
      .single()
    if (tripBErr) throw tripBErr
    tripBId = tripB.id

    const { data: tripC, error: tripCErr } = await owner
      .from('trips')
      .insert({ title: 'cand-test 行程 C（上限測試）', start_date: '2026-09-01', end_date: '2026-09-05', currency: 'JPY' })
      .select('id')
      .single()
    if (tripCErr) throw tripCErr
    tripCId = tripC.id

    // editor 身兼 A、B、C 三個行程的 editor（供跨行程橫移與上限測試使用）；viewer 只在 A；
    // stranger 不屬於任何一個行程
    const { error: memberErr } = await admin.from('trip_members').insert([
      { trip_id: tripAId, user_id: editorId, role: 'editor' },
      { trip_id: tripAId, user_id: viewerId, role: 'viewer' },
      { trip_id: tripBId, user_id: editorId, role: 'editor' },
      { trip_id: tripCId, user_id: editorId, role: 'editor' },
    ])
    if (memberErr) throw memberErr

    const { data: baseline, error: baselineErr } = await admin
      .from('trip_candidates')
      .insert({
        trip_id: tripAId, name: '基準候選地點', lat: 33.5, lng: 130.4,
        place_id: placeId('baseline'), category: 'sight',
      })
      .select('id')
      .single()
    if (baselineErr) throw baselineErr
    baselineCandidateId = baseline.id
  })

  afterAll(async () => {
    if (tripAId) await admin.from('trips').delete().eq('id', tripAId)
    if (tripBId) await admin.from('trips').delete().eq('id', tripBId) // 可能已在 cascade 測試中刪除，重複刪除是 no-op
    if (tripCId) await admin.from('trips').delete().eq('id', tripCId)
    for (const id of userIds) await admin.auth.admin.deleteUser(id)
  })

  // ---- 1. stranger（非成員） ----

  it('stranger：SELECT 0 列；INSERT 42501；UPDATE/DELETE 對既有列 0 列受影響（USING 排除）', async () => {
    const { data: selectData, error: selectErr } = await stranger
      .from('trip_candidates').select('id').eq('trip_id', tripAId)
    expect(selectErr).toBeNull()
    expect(selectData).toEqual([])

    const { error: insertErr } = await stranger.from('trip_candidates').insert({
      trip_id: tripAId, name: 'stranger 偷加', lat: 33.5, lng: 130.4,
      place_id: placeId('stranger-insert'), category: 'other',
    })
    expect(insertErr).not.toBeNull()
    expect(insertErr!.code).toBe('42501')

    const { data: updateData, error: updateErr } = await stranger
      .from('trip_candidates').update({ name: 'stranger 竄改' }).eq('id', baselineCandidateId).select()
    expect(updateErr).toBeNull()
    expect(updateData).toEqual([])

    const { data: deleteData, error: deleteErr } = await stranger
      .from('trip_candidates').delete().eq('id', baselineCandidateId).select()
    expect(deleteErr).toBeNull()
    expect(deleteData).toEqual([])

    const { data: stillThere } = await admin
      .from('trip_candidates').select('id, name').eq('id', baselineCandidateId).single()
    expect(stillThere?.name).toBe('基準候選地點') // 未被更動也未被刪除
  })

  // ---- 2. viewer ----

  it('viewer：SELECT 看得到；INSERT 42501；UPDATE/DELETE 對既有列 0 列受影響、資料仍在', async () => {
    const { data: selectData, error: selectErr } = await viewer
      .from('trip_candidates').select('id').eq('trip_id', tripAId)
    expect(selectErr).toBeNull()
    expect(selectData?.map((r) => r.id)).toContain(baselineCandidateId)

    const { error: insertErr } = await viewer.from('trip_candidates').insert({
      trip_id: tripAId, name: 'viewer 偷加', lat: 33.5, lng: 130.4,
      place_id: placeId('viewer-insert'), category: 'other',
    })
    expect(insertErr).not.toBeNull()
    expect(insertErr!.code).toBe('42501')

    const { data: updateData, error: updateErr } = await viewer
      .from('trip_candidates').update({ name: 'viewer 竄改' }).eq('id', baselineCandidateId).select()
    expect(updateErr).toBeNull()
    expect(updateData).toEqual([])

    const { data: deleteData, error: deleteErr } = await viewer
      .from('trip_candidates').delete().eq('id', baselineCandidateId).select()
    expect(deleteErr).toBeNull()
    expect(deleteData).toEqual([])

    const { data: stillThere } = await admin
      .from('trip_candidates').select('name').eq('id', baselineCandidateId).single()
    expect(stillThere?.name).toBe('基準候選地點')
  })

  // ---- 3. editor 的正常寫入路徑 ----

  it('editor：六欄 INSERT（trip_id/name/lat/lng/place_id/category）成功，且可 UPDATE name / category', async () => {
    const { data: inserted, error: insertErr } = await editor
      .from('trip_candidates')
      .insert({
        trip_id: tripAId, name: 'editor 新增的候選', lat: 33.6, lng: 130.5,
        place_id: placeId('editor-insert'), category: 'food',
      })
      .select('id, name, category')
      .single()
    expect(insertErr).toBeNull()
    expect(inserted?.category).toBe('food')
    editorCandidateId = inserted!.id

    const { data: renamed, error: renameErr } = await editor
      .from('trip_candidates').update({ name: '改過名字的候選' }).eq('id', editorCandidateId)
      .select('name').single()
    expect(renameErr).toBeNull()
    expect(renamed?.name).toBe('改過名字的候選')

    const { data: recategorized, error: categoryErr } = await editor
      .from('trip_candidates').update({ category: 'shopping' }).eq('id', editorCandidateId)
      .select('category').single()
    expect(categoryErr).toBeNull()
    expect(recategorized?.category).toBe('shopping')
  })

  // ---- 4. editor 竄改欄位級 GRANT 白名單之外的欄位 ----

  it('editor 竄改 lat / lng / place_id / trip_id 皆被欄位級 GRANT 擋下（42501）', async () => {
    const patches: Record<string, unknown>[] = [
      { lat: 10 },
      { lng: 10 },
      { place_id: placeId('tamper') },
      { trip_id: tripBId },
    ]
    for (const patch of patches) {
      const { error } = await editor.from('trip_candidates').update(patch).eq('id', editorCandidateId)
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    }
  })

  // ---- 5. editor INSERT 時冒用 created_by ----

  it('editor INSERT 指定 created_by 為他人 uuid → 42501（欄位不在 INSERT 白名單）', async () => {
    const { error } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: '嘗試冒用 created_by', lat: 33.5, lng: 130.4,
      place_id: placeId('created-by-tamper'), category: 'other', created_by: strangerId,
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  // ---- 6. 跨行程橫移 ----

  it('跨行程橫移：身兼 A、B 兩行程 editor 者把 A 的候選 trip_id 改成 B 仍被欄位級 GRANT 擋下（42501）', async () => {
    const { error } = await editor.from('trip_candidates').update({ trip_id: tripBId }).eq('id', editorCandidateId)
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')

    const { data } = await admin.from('trip_candidates').select('trip_id').eq('id', editorCandidateId).single()
    expect(data?.trip_id).toBe(tripAId) // 確認真的沒被搬走
  })

  // ---- 7. anon（未登入） ----

  it('anon（未登入）SELECT/INSERT/UPDATE/DELETE 全被拒（42501，未 grant anon）', async () => {
    const { error: selectErr } = await anon.from('trip_candidates').select('id').eq('trip_id', tripAId)
    expect(selectErr).not.toBeNull()
    expect(selectErr!.code).toBe('42501')

    const { error: insertErr } = await anon.from('trip_candidates').insert({
      trip_id: tripAId, name: 'anon 嘗試新增', lat: 33.5, lng: 130.4,
      place_id: placeId('anon-insert'), category: 'other',
    })
    expect(insertErr).not.toBeNull()
    expect(insertErr!.code).toBe('42501')

    const { error: updateErr } = await anon.from('trip_candidates').update({ name: 'x' }).eq('id', editorCandidateId)
    expect(updateErr).not.toBeNull()
    expect(updateErr!.code).toBe('42501')

    const { error: deleteErr } = await anon.from('trip_candidates').delete().eq('id', editorCandidateId)
    expect(deleteErr).not.toBeNull()
    expect(deleteErr!.code).toBe('42501')
  })

  // ---- 8. 候選地點上限 ----

  it('上限：admin 塞滿 100 筆後 editor INSERT 第 101 筆 → P0001 candidate_limit_reached', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      trip_id: tripCId, name: `上限測試-${i}`, lat: 30, lng: 130,
      place_id: placeId(`limit-${i}`), category: 'other',
    }))
    const { error: fillErr } = await admin.from('trip_candidates').insert(rows)
    expect(fillErr).toBeNull()

    const { error } = await editor.from('trip_candidates').insert({
      trip_id: tripCId, name: '第101筆', lat: 30, lng: 130,
      place_id: placeId('limit-101'), category: 'other',
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('P0001')
    expect(error!.message).toContain('candidate_limit_reached')
  })

  // ---- 9. F-1 迴歸：已滿行程不得因錯誤碼差異洩漏「是否已滿」 ----

  it('F-1 迴歸：已滿行程被非成員 INSERT → 42501（而非 P0001，不洩漏該行程是否已滿）', async () => {
    const { error } = await stranger.from('trip_candidates').insert({
      trip_id: tripCId, name: '非成員嘗試新增', lat: 30, lng: 130,
      place_id: placeId('nonmember-insert'), category: 'other',
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  // ---- 10. F-3 迴歸：不可變欄位的縱深防禦（trigger 擋 service_role） ----

  it('F-3 迴歸：service_role 直改不可變欄位被 trigger 擋（P0001），name / category 仍可正常改', async () => {
    const immutablePatches: Record<string, unknown>[] = [
      { trip_id: tripBId },
      { place_id: placeId('immutable-attempt') },
      { created_by: strangerId },
      { created_at: new Date().toISOString() },
      { id: '00000000-0000-0000-0000-000000000000' },
    ]
    for (const patch of immutablePatches) {
      const { error } = await admin.from('trip_candidates').update(patch).eq('id', editorCandidateId)
      expect(error).not.toBeNull()
      expect(error!.code).toBe('P0001')
      expect(error!.message).toContain('immutable_column_modified')
    }

    const { data, error: okErr } = await admin
      .from('trip_candidates')
      .update({ name: '服務端仍可改名', category: 'lodging' })
      .eq('id', editorCandidateId)
      .select('name, category')
      .single()
    expect(okErr).toBeNull()
    expect(data?.name).toBe('服務端仍可改名')
    expect(data?.category).toBe('lodging')
  })

  // ---- 11. category 約束 ----

  it('category 約束：非法值 23514 且訊息含 trip_candidates_category_valid；六個合法值皆可寫；不帶欄位時預設 other', async () => {
    const { error: badErr } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: '非法分類', lat: 30, lng: 130, place_id: placeId('cat-bad'), category: 'INVALID',
    })
    expect(badErr).not.toBeNull()
    expect(badErr!.code).toBe('23514')
    expect(badErr!.message).toContain('trip_candidates_category_valid')

    const categories = ['transport', 'sight', 'food', 'lodging', 'shopping', 'other']
    for (const category of categories) {
      const { error } = await editor.from('trip_candidates').insert({
        trip_id: tripAId, name: `分類-${category}`, lat: 30, lng: 130,
        place_id: placeId(`cat-${category}`), category,
      })
      expect(error).toBeNull()
    }

    const { data: defaultRow, error: defaultErr } = await editor
      .from('trip_candidates')
      .insert({ trip_id: tripAId, name: '不帶分類', lat: 30, lng: 130, place_id: placeId('cat-default') })
      .select('category')
      .single()
    expect(defaultErr).toBeNull()
    expect(defaultRow?.category).toBe('other')
  })

  // ---- 12. name 約束 ----

  it('name 約束：全形/ASCII 空白被拒且訊息含 trip_candidates_name_len；200 字通過、201 字被拒', async () => {
    const { error: fullwidthErr } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: '　', lat: 30, lng: 130, place_id: placeId('name-fullwidth'), category: 'other',
    })
    expect(fullwidthErr).not.toBeNull()
    expect(fullwidthErr!.message).toContain('trip_candidates_name_len')

    const { error: asciiErr } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: '   ', lat: 30, lng: 130, place_id: placeId('name-ascii'), category: 'other',
    })
    expect(asciiErr).not.toBeNull()
    expect(asciiErr!.message).toContain('trip_candidates_name_len')

    const exactly200 = '中'.repeat(200)
    const { error: okErr } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: exactly200, lat: 30, lng: 130, place_id: placeId('name-200'), category: 'other',
    })
    expect(okErr).toBeNull()

    const tooLong = '中'.repeat(201)
    const { error: tooLongErr } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: tooLong, lat: 30, lng: 130, place_id: placeId('name-201'), category: 'other',
    })
    expect(tooLongErr).not.toBeNull()
    expect(tooLongErr!.message).toContain('trip_candidates_name_len')
  })

  // ---- 13. place_id 約束 ----

  it('place_id 約束：空字串被拒、256 字被拒（訊息含 trip_candidates_place_id_len）、正常值通過', async () => {
    const { error: emptyErr } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: '空 place_id', lat: 30, lng: 130, place_id: '', category: 'other',
    })
    expect(emptyErr).not.toBeNull()
    expect(emptyErr!.message).toContain('trip_candidates_place_id_len')

    const tooLongPlaceId = 'p'.repeat(256)
    const { error: tooLongErr } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: '過長 place_id', lat: 30, lng: 130, place_id: tooLongPlaceId, category: 'other',
    })
    expect(tooLongErr).not.toBeNull()
    expect(tooLongErr!.message).toContain('trip_candidates_place_id_len')

    const { error: okErr } = await editor.from('trip_candidates').insert({
      trip_id: tripAId, name: '正常 place_id', lat: 30, lng: 130, place_id: placeId('normal'), category: 'other',
    })
    expect(okErr).toBeNull()
  })

  // ---- 14. cascade：刪 trip 連帶刪候選地點 ----

  it('cascade：刪 trip → candidates 連帶消失（admin 直查確認）', async () => {
    const { error: insertErr } = await admin.from('trip_candidates').insert({
      trip_id: tripBId, name: 'cascade 測試候選', lat: 30, lng: 130, place_id: placeId('cascade'), category: 'other',
    })
    expect(insertErr).toBeNull()

    const { error: deleteTripErr } = await admin.from('trips').delete().eq('id', tripBId)
    expect(deleteTripErr).toBeNull()

    const { data: remaining } = await admin.from('trip_candidates').select('id').eq('trip_id', tripBId)
    expect(remaining).toEqual([])
  })
})
