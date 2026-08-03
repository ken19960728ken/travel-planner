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

// migration 的顯式欄位白名單（審查 M-3）；斷言用 Object.keys().sort() 全等鎖住「新增欄位預設外洩」的回歸——
// 不是「包含」，任何多出或少掉的欄位都要讓測試變紅
const TRIP_KEYS = ['id', 'title', 'start_date', 'end_date', 'currency'].sort()
const STOP_KEYS = [
  'id', 'name', 'lat', 'lng', 'place_id', 'is_custom', 'timezone',
  'starts_at', 'ends_at', 'locked', 'estimated_cost', 'category',
].sort()
const LEG_KEYS = [
  'id', 'from_stop_id', 'to_stop_id', 'mode', 'duration_minutes', 'distance_meters',
  'detail', 'source', 'stale', 'departs_at', 'arrives_at', 'estimated_cost', 'updated_at',
].sort()

// ⚠️ 這組全等斷言是分享白名單的**唯一自動守門**——它會抓到任何多出或少掉的欄位。
// skipIf 讓沒有本地 Supabase 的環境靜默跳過、測試全綠，等於守門在 CI 上不存在。
// 未改成硬失敗是因為本專案其餘整合測試都用同一慣例，單獨改這支會造成不一致；
// 改用啟動時的醒目警告，並在 README 標明 CI 必須起本地 Supabase。
if (!hasEnv) {
  console.warn(
    '\n⚠️  share.test.ts 已跳過：缺少 SUPABASE_URL / ANON / SERVICE_ROLE。\n' +
    '   這支測試是 get_shared_trip 欄位白名單的唯一自動守門，跳過等於沒有人在看。\n' +
    '   CI 必須啟動本地 Supabase，否則新增欄位外洩不會有任何告警。\n',
  )
}

describe.skipIf(!hasEnv)('get_shared_trip RPC（需本地 Supabase）', () => {
  let admin: SupabaseClient
  let owner: SupabaseClient
  let anon: SupabaseClient
  let ownerId: string
  let tripId: string
  let shareToken: string
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'test-password-1234'

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    anon = newUserClient()
    owner = newUserClient()

    const email = `share-owner-${suffix}@test.local`
    const { data: userData, error: userErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (userErr) throw userErr
    ownerId = userData.user.id
    const { error: signInErr } = await owner.auth.signInWithPassword({ email, password })
    if (signInErr) throw signInErr // 未登入的 client 會被誤判成走 anon 角色，讓後續斷言看似通過但其實沒測到東西

    const { data: trip, error: tripErr } = await owner
      .from('trips')
      .insert({ title: '分享測試行程', start_date: '2026-09-10', end_date: '2026-09-12', currency: 'JPY' })
      .select('id, share_token')
      .single()
    if (tripErr) throw tripErr
    tripId = trip.id
    shareToken = trip.share_token

    const { data: stopA, error: stopAErr } = await owner
      .from('stops')
      .insert({
        trip_id: tripId, name: '分享景點A', lat: 35.0, lng: 135.0, timezone: 'Asia/Tokyo',
        starts_at: '2026-09-10T09:00:00Z', ends_at: '2026-09-10T10:00:00Z', estimated_cost: 500,
      })
      .select('id')
      .single()
    if (stopAErr) throw stopAErr
    const { data: stopB, error: stopBErr } = await owner
      .from('stops')
      .insert({
        trip_id: tripId, name: '分享景點B', lat: 35.1, lng: 135.1, timezone: 'Asia/Tokyo',
        starts_at: '2026-09-10T11:00:00Z', ends_at: '2026-09-10T12:00:00Z',
      })
      .select('id')
      .single()
    if (stopBErr) throw stopBErr

    const { error: legErr } = await owner
      .from('legs')
      .insert({
        trip_id: tripId, from_stop_id: stopA.id, to_stop_id: stopB.id,
        mode: 'custom', source: 'manual', duration_minutes: 30, estimated_cost: 100,
      })
    if (legErr) throw legErr
  })

  afterAll(async () => {
    if (tripId) await admin.from('trips').delete().eq('id', tripId) // stops/legs 隨 cascade 清掉
    if (ownerId) await admin.auth.admin.deleteUser(ownerId)
  })

  it('anon 帶有效 token 呼叫 get_shared_trip → 取得 trip/stops/legs，每列鍵集合恰等於白名單', async () => {
    const { data, error } = await anon.rpc('get_shared_trip', { p_token: shareToken })
    expect(error).toBeNull()
    expect(data.trip.id).toBe(tripId)
    expect(Object.keys(data.trip).sort()).toEqual(TRIP_KEYS)
    expect(data.stops).toHaveLength(2)
    for (const stop of data.stops) {
      expect(Object.keys(stop).sort()).toEqual(STOP_KEYS)
    }
    expect(data.legs).toHaveLength(1)
    for (const leg of data.legs) {
      expect(Object.keys(leg).sort()).toEqual(LEG_KEYS)
    }
  })

  it('亂造 token → null（與撤銷/不存在不可區分，對外一律「連結已失效」）', async () => {
    const { data, error } = await anon.rpc('get_shared_trip', { p_token: '00000000-0000-0000-0000-000000000000' })
    expect(error).toBeNull()
    expect(data).toBeNull()
  })

  it('anon 直接 select trips/stops/legs 一律被拒（get_shared_trip 是唯一合法管道，M-3 沒有給任何表級權限）', async () => {
    const { error: tripsErr } = await anon.from('trips').select('id').eq('id', tripId)
    expect(tripsErr).not.toBeNull()
    const { error: stopsErr } = await anon.from('stops').select('id').eq('trip_id', tripId)
    expect(stopsErr).not.toBeNull()
    const { error: legsErr } = await anon.from('legs').select('id').eq('trip_id', tripId)
    expect(legsErr).not.toBeNull()
  })

  it('owner regenerate_share_token 後：舊 token → null、新 token → 有效（「連結已失效」語義閉環）', async () => {
    const { data: newToken, error: regenErr } = await owner.rpc('regenerate_share_token', { p_trip_id: tripId })
    expect(regenErr).toBeNull()
    expect(newToken).toBeTruthy()
    expect(newToken).not.toBe(shareToken)

    const { data: oldTokenResult, error: oldErr } = await anon.rpc('get_shared_trip', { p_token: shareToken })
    expect(oldErr).toBeNull()
    expect(oldTokenResult).toBeNull()

    const { data: newTokenResult, error: newErr } = await anon.rpc('get_shared_trip', { p_token: newToken })
    expect(newErr).toBeNull()
    expect(newTokenResult.trip.id).toBe(tripId)
  })
})
