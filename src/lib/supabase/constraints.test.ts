import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && serviceKey)

describe.skipIf(!hasEnv)('標題長度/非空約束（需本地 Supabase）', () => {
  let admin: SupabaseClient
  const createdTripIds: string[] = []

  beforeAll(() => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
  })

  afterAll(async () => {
    if (createdTripIds.length > 0) {
      await admin.from('trips').delete().in('id', createdTripIds)
    }
  })

  it('視覺空白標題（換行/全形空白）被拒', async () => {
    const { error } = await admin.from('trips').insert({
      title: '\n　', start_date: '2026-10-01', end_date: '2026-10-02', owner_id: null,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('trips_title_len')
  })

  it('201 字被拒、200 字（含中文）通過', async () => {
    const tooLong = '中'.repeat(201)
    const { error: e1 } = await admin.from('trips').insert({
      title: tooLong, start_date: '2026-10-01', end_date: '2026-10-02', owner_id: null,
    })
    expect(e1).not.toBeNull()

    const exactly200 = '中'.repeat(200)
    const { data, error: e2 } = await admin
      .from('trips')
      .insert({ title: exactly200, start_date: '2026-10-01', end_date: '2026-10-02', owner_id: null })
      .select('id')
      .single()
    expect(e2).toBeNull()
    if (data) createdTripIds.push(data.id)
  })
})
