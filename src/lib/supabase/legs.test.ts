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

describe.skipIf(!hasEnv)('legs schema 與 stale trigger（需本地 Supabase）', () => {
  let admin: SupabaseClient
  let owner: SupabaseClient
  let ownerId: string | undefined
  let tripId: string
  const stopIds: string[] = []
  // 注意（審查 M-1）：Date.UTC 對小數時數做整數截斷（MakeTime 的 ToIntegerOrInfinity），
  // mk(4.5) 會等於 mk(4)——半小時一律用分鐘參數表達
  const mk = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 2, h, m)).toISOString()

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    const suffix = Math.random().toString(36).slice(2, 8)
    const password = 'test-password-1234'
    const o = await admin.auth.admin.createUser({ email: `legs-${suffix}@test.local`, password, email_confirm: true })
    ownerId = o.data.user?.id
    owner = createClient(url!, anonKey!, { auth: { persistSession: false } })
    await owner.auth.signInWithPassword({ email: `legs-${suffix}@test.local`, password })

    const { data: trip, error } = await owner
      .from('trips')
      .insert({ title: 'legs 測試行程', start_date: '2026-08-02', end_date: '2026-08-06', currency: 'JPY' })
      .select('id')
      .single()
    if (error) throw error
    tripId = trip.id

    for (const [name, sh, eh] of [['桃機', 0, 1], ['福岡機場', 4, 5], ['博多', 6, 7]] as const) {
      const { data, error: e } = await owner
        .from('stops')
        .insert({
          trip_id: tripId, name, lat: 33.59, lng: 130.4, timezone: 'Asia/Tokyo',
          starts_at: mk(sh), ends_at: mk(eh),
        })
        .select('id')
        .single()
      if (e) throw e
      stopIds.push(data.id)
    }
  })

  afterAll(async () => {
    if (tripId) await admin.from('trips').delete().eq('id', tripId) // legs 隨 cascade 清掉
    if (ownerId) await admin.auth.admin.deleteUser(ownerId)
  })

  it('flight 段可插入（manual、起訖時間跨時區）', async () => {
    const { error } = await owner.from('legs').insert({
      trip_id: tripId, from_stop_id: stopIds[0], to_stop_id: stopIds[1],
      mode: 'flight', source: 'manual', duration_minutes: 135,
      departs_at: mk(0, 30), arrives_at: mk(2, 45),
    })
    expect(error).toBeNull()
  })

  it('arrives_at 不晚於 departs_at 被 check 擋下（23514）', async () => {
    const { error } = await owner.from('legs').insert({
      trip_id: tripId, from_stop_id: stopIds[1], to_stop_id: stopIds[2],
      mode: 'custom', source: 'manual', departs_at: mk(5), arrives_at: mk(5),
    })
    expect(error?.code).toBe('23514')
  })

  it('同一有向配對第二條 leg 被 unique 擋下（23505）', async () => {
    const { error } = await owner.from('legs').insert({
      trip_id: tripId, from_stop_id: stopIds[0], to_stop_id: stopIds[1],
      mode: 'transit', source: 'auto',
    })
    expect(error?.code).toBe('23505')
  })

  it('停留點時間變動 → manual 段被 trigger 標 stale；auto 段不動', async () => {
    const { error: autoErr } = await owner.from('legs').insert({
      trip_id: tripId, from_stop_id: stopIds[1], to_stop_id: stopIds[2],
      mode: 'transit', source: 'auto', duration_minutes: 12,
    })
    expect(autoErr).toBeNull()

    // 動 stopIds[1]（同時是 manual 段的 to、auto 段的 from）；用分鐘級偏移確保值真的變了（M-1）
    const { error } = await owner.from('stops')
      .update({ starts_at: mk(4, 30), ends_at: mk(5, 30) }).eq('id', stopIds[1])
    expect(error).toBeNull()

    const { data } = await owner.from('legs')
      .select('source, stale').eq('trip_id', tripId).order('source')
    const bySource = Object.fromEntries(data!.map(r => [r.source, r.stale]))
    expect(bySource['manual']).toBe(true)
    expect(bySource['auto']).toBe(false)
  })

  it('停留點非時間欄位變動不觸發 stale', async () => {
    // 依 legs 表的鎖序規約逐列歸零（測試無併發，但規約全專案一體遵守，不留壞範例）
    const { data: allLegs } = await admin.from('legs').select('id').eq('trip_id', tripId).order('id')
    for (const l of allLegs ?? []) await admin.from('legs').update({ stale: false }).eq('id', l.id)
    const { error } = await owner.from('stops').update({ name: '福岡空港' }).eq('id', stopIds[1])
    expect(error).toBeNull()
    const { data } = await owner.from('legs').select('stale').eq('trip_id', tripId)
    expect(data!.every(r => r.stale === false)).toBe(true)
  })

  it('cascade_shift_stops 連鎖平移也會標 stale manual 段（trigger 與 RPC 同交易）', async () => {
    const { error } = await owner.rpc('cascade_shift_stops', {
      p_trip_id: tripId, p_changed_stop_id: stopIds[0], p_delta_seconds: 3600,
    })
    expect(error).toBeNull()
    const { data } = await owner.from('legs').select('source, stale').eq('trip_id', tripId)
    expect(data!.find(r => r.source === 'manual')!.stale).toBe(true)
  })
})
