import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 護欄（比照 realtime.spec.ts 既有模式）：只允許對本地 Supabase 執行
const sbUrlGuard = process.env.SUPABASE_URL
if (sbUrlGuard && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(sbUrlGuard)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行 E2E 測試（防止誤打正式環境）')
}

// C-1 Critical 迴歸鎖（2026-08-04 critic 審查）：未登入者只要知道 tripId（不是機密——分享頁
// RSC payload／URL／被移除成員的瀏覽紀錄皆可取得）就能對 public channel `trip:{tripId}` track
// 一筆缺 displayName 的 presence payload，讓所有正在編輯的合法成員頁面在 render 期崩潰。
// 根治：channel 改 private:true + migration 20260805000000 的 realtime.messages RLS policy
// （未登入者現在連 join 都會被拒絕）；presence sync 另有型別守衛作第二層防禦。
// 本檔專屬 e2e-realtime-anon- 前綴，afterAll 清理只刪這裡建立的帳號/行程。
let createdTripId: string | undefined
let admin: SupabaseClient | undefined

test('C-1 迴歸：未登入攻擊者對 trip channel 送出畸形 presence，受害者頁面不受影響', async ({ browser }) => {
  const sbUrl = process.env.SUPABASE_URL
  const sbAnon = process.env.SUPABASE_ANON_KEY
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!sbUrl || !sbAnon || !sbService, '需要本地 Supabase service role key 與 anon key')

  admin = createClient(sbUrl!, sbService!, { auth: { persistSession: false } })
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'e2e-realtime-anon-password-1234'
  const victimEmail = `e2e-realtime-anon-victim-${suffix}@test.local`

  const { data: victimUser, error: createErr } = await admin.auth.admin.createUser({
    email: victimEmail, password, email_confirm: true,
  })
  expect(createErr).toBeNull()
  await admin.from('profiles').upsert({ id: victimUser!.user!.id, display_name: '受害者' })
  const { data: trip, error: tripErr } = await admin
    .from('trips')
    .insert({ title: 'e2e-realtime-anon- 迴歸測試行程', start_date: '2026-12-01', end_date: '2026-12-02', currency: 'JPY', owner_id: victimUser!.user!.id })
    .select('id')
    .single()
  expect(tripErr).toBeNull()
  createdTripId = trip!.id
  await admin.from('trip_members').upsert({ trip_id: createdTripId, user_id: victimUser!.user!.id, role: 'owner' })
  const mk = (h: number) => new Date(Date.UTC(2026, 11, 1, h)).toISOString()
  await admin.from('stops').insert({
    trip_id: createdTripId, name: '受害停留點', lat: 33.5, lng: 130.4,
    timezone: 'Asia/Tokyo', starts_at: mk(1), ends_at: mk(2),
  })

  // ---- 受害者：真實 UI 登入 → 開行程頁 ----
  const victimContext = await browser.newContext()
  const victimPage = await victimContext.newPage()
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  victimPage.on('pageerror', e => pageErrors.push(e.message.split('\n')[0]))
  victimPage.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
  await victimPage.goto('/login')
  await victimPage.getByPlaceholder('Email').fill(victimEmail)
  await victimPage.getByPlaceholder('密碼').fill(password)
  await victimPage.getByRole('button', { name: '登入', exact: true }).click()
  await victimPage.waitForURL(/\/trips$/, { timeout: 20_000 })
  await victimPage.goto(`/trips/${createdTripId}`)
  // 側欄清單與 Timeline 拖曳色塊都會渲染停留點名稱，locator 需限定在側欄（aside）才不會撞上兩處
  // 同名文字造成 strict mode violation（既有 UI 事實，見 realtime.spec.ts 同樣的處理）
  const stopNameInSidebar = victimPage.locator('aside').getByText('受害停留點')
  await expect(stopNameInSidebar).toBeVisible({ timeout: 20_000 })
  await victimPage.waitForTimeout(3_000) // 給 TripRealtime 掛載/join 一點時間

  // ---- 攻擊者：完全未登入，只用公開 anon key + 已知的 tripId ----
  const attacker = createClient(sbUrl!, sbAnon!, { auth: { persistSession: false } })
  const attackerChannel = attacker.channel(`trip:${createdTripId}`, { config: { presence: { key: 'attacker' } } })
  await new Promise<void>(resolve => {
    attackerChannel.subscribe(status => { if (status === 'SUBSCRIBED') resolve() })
    // public channel 的 join 通常瞬間成功；即使某些環境下被拒絕（例如未來關掉 public access），
    // 這裡也不應該卡死整個測試——3 秒逾時就放棄，後續斷言仍然成立（攻擊者連 track 都做不到）
    setTimeout(resolve, 3_000)
  })
  await attackerChannel.track({ userId: 'evil' }) // 刻意缺 displayName
  await victimPage.waitForTimeout(3_000)

  // ---- 斷言：受害者頁面完全不受影響 ----
  expect(pageErrors).toEqual([])
  expect(consoleErrors.filter(e => e.includes('Cannot read propert'))).toEqual([])
  await expect(stopNameInSidebar).toBeVisible()

  await attacker.removeAllChannels()
  await victimContext.close()
})

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  const client = admin ?? createClient(url, serviceKey, { auth: { persistSession: false } })
  if (createdTripId) await client.from('trips').delete().eq('id', createdTripId)
  const perPage = 200
  let page = 1
  const allUsers: { id: string; email?: string }[] = []
  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage })
    if (error || !data) break
    allUsers.push(...data.users)
    if (data.users.length < perPage) break
    page += 1
  }
  const testUsers = allUsers.filter(u => u.email?.endsWith('@test.local') && u.email.startsWith('e2e-realtime-anon-'))
  for (const u of testUsers) await client.auth.admin.deleteUser(u.id)
})
