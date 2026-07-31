import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && anonKey && serviceKey)

const HOUR = 60 * 60

describe.skipIf(!hasEnv)('cascade_shift_stops RPC（需本地 Supabase）', () => {
  let admin: SupabaseClient
  let owner: SupabaseClient
  let stranger: SupabaseClient
  let viewer: SupabaseClient
  let ownerId: string | undefined
  let strangerId: string | undefined
  let viewerId: string | undefined
  let tripId: string
  const stopIds: Record<string, string> = {}

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    const suffix = Math.random().toString(36).slice(2, 8)
    const password = 'test-password-1234'
    const o = await admin.auth.admin.createUser({ email: `owner-${suffix}@test.local`, password, email_confirm: true })
    const s = await admin.auth.admin.createUser({ email: `stranger-${suffix}@test.local`, password, email_confirm: true })
    const v = await admin.auth.admin.createUser({ email: `viewer-${suffix}@test.local`, password, email_confirm: true })
    ownerId = o.data.user?.id
    strangerId = s.data.user?.id
    viewerId = v.data.user?.id

    owner = createClient(url!, anonKey!, { auth: { persistSession: false } })
    stranger = createClient(url!, anonKey!, { auth: { persistSession: false } })
    viewer = createClient(url!, anonKey!, { auth: { persistSession: false } })
    await owner.auth.signInWithPassword({ email: `owner-${suffix}@test.local`, password })
    await stranger.auth.signInWithPassword({ email: `stranger-${suffix}@test.local`, password })
    await viewer.auth.signInWithPassword({ email: `viewer-${suffix}@test.local`, password })

    const { data: trip, error } = await owner
      .from('trips')
      .insert({ title: 'RPC 測試行程', start_date: '2026-10-01', end_date: '2026-10-05', currency: 'JPY' })
      .select('id')
      .single()
    if (error) throw error
    tripId = trip.id

    // a: 09-10, b: 11-12, c(locked): 13-14, d: 15-16（UTC）
    for (const [key, sh, eh, locked] of [
      ['a', 9, 10, false], ['b', 11, 12, false], ['c', 13, 14, true], ['d', 15, 16, false],
    ] as const) {
      const { data, error: e } = await owner
        .from('stops')
        .insert({
          trip_id: tripId, name: `RPC-${key}`, lat: 33.59, lng: 130.4,
          timezone: 'Asia/Tokyo', locked,
          starts_at: new Date(Date.UTC(2026, 9, 1, sh)).toISOString(),
          ends_at: new Date(Date.UTC(2026, 9, 1, eh)).toISOString(),
        })
        .select('id')
        .single()
      if (e) throw e
      stopIds[key] = data.id
    }

    const { error: memberErr } = await admin
      .from('trip_members')
      .insert({ trip_id: tripId, user_id: viewerId, role: 'viewer' })
    if (memberErr) throw memberErr
  })

  afterAll(async () => {
    if (tripId) await admin.from('trips').delete().eq('id', tripId)
    if (ownerId) await admin.auth.admin.deleteUser(ownerId)
    if (strangerId) await admin.auth.admin.deleteUser(strangerId)
    if (viewerId) await admin.auth.admin.deleteUser(viewerId)
  })

  it('owner 平移 a +1 小時：a、b、d 順延，鎖定的 c 不動', async () => {
    const { error } = await owner.rpc('cascade_shift_stops', {
      p_trip_id: tripId, p_changed_stop_id: stopIds.a, p_delta_seconds: HOUR,
    })
    expect(error).toBeNull()

    const { data } = await owner
      .from('stops').select('name, starts_at').eq('trip_id', tripId).order('name')
    const starts = Object.fromEntries(data!.map(r => [r.name, new Date(r.starts_at).getTime()]))
    expect(starts['RPC-a']).toBe(Date.UTC(2026, 9, 1, 10))
    expect(starts['RPC-b']).toBe(Date.UTC(2026, 9, 1, 12))
    expect(starts['RPC-c']).toBe(Date.UTC(2026, 9, 1, 13)) // 鎖定不動
    expect(starts['RPC-d']).toBe(Date.UTC(2026, 9, 1, 16))
  })

  it('非成員呼叫 RPC 動不了任何列（RLS 生效）', async () => {
    const { error } = await stranger.rpc('cascade_shift_stops', {
      p_trip_id: tripId, p_changed_stop_id: stopIds.b, p_delta_seconds: HOUR,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('stop not found in trip')

    const { data } = await admin
      .from('stops').select('starts_at').eq('id', stopIds.b).single()
    expect(new Date(data!.starts_at).getTime()).toBe(Date.UTC(2026, 9, 1, 12)) // 維持上一測後的值
  })

  it('viewer 呼叫 RPC 被 editor 前置檢查擋下（假成功不再發生）', async () => {
    const { error } = await viewer.rpc('cascade_shift_stops', {
      p_trip_id: tripId, p_changed_stop_id: stopIds.b, p_delta_seconds: HOUR,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('stop not found in trip')

    const { data } = await admin
      .from('stops').select('starts_at').eq('id', stopIds.b).single()
    expect(new Date(data!.starts_at).getTime()).toBe(Date.UTC(2026, 9, 1, 12)) // 未被移動
  })

  it('delta=0 短路：owner 呼叫不報錯，所有停留點時間不變', async () => {
    const { error } = await owner.rpc('cascade_shift_stops', {
      p_trip_id: tripId, p_changed_stop_id: stopIds.a, p_delta_seconds: 0,
    })
    expect(error).toBeNull()

    const { data } = await owner
      .from('stops').select('name, starts_at').eq('trip_id', tripId).order('name')
    const starts = Object.fromEntries(data!.map(r => [r.name, new Date(r.starts_at).getTime()]))
    expect(starts['RPC-a']).toBe(Date.UTC(2026, 9, 1, 10))
    expect(starts['RPC-b']).toBe(Date.UTC(2026, 9, 1, 12))
    expect(starts['RPC-c']).toBe(Date.UTC(2026, 9, 1, 13))
    expect(starts['RPC-d']).toBe(Date.UTC(2026, 9, 1, 16))
  })
})
