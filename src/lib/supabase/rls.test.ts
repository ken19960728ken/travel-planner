import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && anonKey && serviceKey)

function newUserClient(): SupabaseClient {
  return createClient(url!, anonKey!, { auth: { persistSession: false } })
}

describe.skipIf(!hasEnv)('RLS 權限規則（需本地 Supabase）', () => {
  let owner: SupabaseClient
  let stranger: SupabaseClient
  let admin: SupabaseClient
  let tripId: string

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    const suffix = Math.random().toString(36).slice(2, 8)
    const password = 'test-password-1234'
    const ownerEmail = `owner-${suffix}@test.local`
    const strangerEmail = `stranger-${suffix}@test.local`
    await admin.auth.admin.createUser({ email: ownerEmail, password, email_confirm: true })
    await admin.auth.admin.createUser({ email: strangerEmail, password, email_confirm: true })

    owner = newUserClient()
    stranger = newUserClient()
    await owner.auth.signInWithPassword({ email: ownerEmail, password })
    await stranger.auth.signInWithPassword({ email: strangerEmail, password })

    const { data, error } = await owner
      .from('trips')
      .insert({ title: 'RLS 測試行程', start_date: '2026-10-01', end_date: '2026-10-05', currency: 'JPY' })
      .select('id')
      .single()
    if (error) throw error
    tripId = data.id
  })

  it('owner 建立行程後自動成為成員並可讀取', async () => {
    const { data: members } = await owner
      .from('trip_members').select('role').eq('trip_id', tripId)
    expect(members).toEqual([{ role: 'owner' }])

    const { data: trips } = await owner.from('trips').select('id').eq('id', tripId)
    expect(trips).toHaveLength(1)
  })

  it('非成員讀不到行程', async () => {
    const { data } = await stranger.from('trips').select('id').eq('id', tripId)
    expect(data).toEqual([])
  })

  it('非成員不能新增停留點', async () => {
    const { error } = await stranger.from('stops').insert({
      trip_id: tripId, name: '偷加的景點', lat: 35.7, lng: 139.8,
      timezone: 'Asia/Tokyo',
      starts_at: '2026-10-01T09:00:00Z', ends_at: '2026-10-01T10:00:00Z',
    })
    expect(error).not.toBeNull()
  })

  it('owner 可以新增停留點', async () => {
    const { error } = await owner.from('stops').insert({
      trip_id: tripId, name: '淺草寺', lat: 35.71478, lng: 139.79665,
      timezone: 'Asia/Tokyo',
      starts_at: '2026-10-01T09:00:00Z', ends_at: '2026-10-01T10:30:00Z',
    })
    expect(error).toBeNull()
  })

  it('用戶端完全碰不到 route_cache', async () => {
    const { error } = await owner.from('route_cache').insert({
      cache_key: 'x', result: {},
    })
    expect(error).not.toBeNull()
  })

  afterAll(async () => {
    if (tripId) {
      await admin.from('trips').delete().eq('id', tripId)
    }
  })
})
