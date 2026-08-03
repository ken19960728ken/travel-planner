import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 護欄（比照 smoke.spec.ts / invite.spec.ts 既有慣例）：只允許對本地 Supabase 執行，避免
// .env.test.local 誤指到雲端時建立/刪除測試帳號、或對正式資料庫送出 Realtime 訂閱
const sbUrlGuard = process.env.SUPABASE_URL
if (sbUrlGuard && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(sbUrlGuard)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行 E2E 測試（防止誤打正式環境）')
}

// M-5：本檔專屬 e2e-realtime- 前綴，afterAll 清理只 filter 這個前綴
let createdTripId: string | undefined
let admin: SupabaseClient | undefined

test('雙 context 冒煙：A 插入停留點 → B 免手動 reload 看到；A 刪除 → B 免手動 reload 消失', async ({ browser }) => {
  const sbUrl = process.env.SUPABASE_URL
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!sbUrl || !sbService, '需要本地 Supabase service role key（建立額外測試帳號、直接寫入 stops 模擬旅伴變更）')

  admin = createClient(sbUrl!, sbService!, { auth: { persistSession: false } })
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'e2e-realtime-password-1234'
  const ownerEmail = `e2e-realtime-owner-${suffix}@test.local`
  const editorEmail = `e2e-realtime-editor-${suffix}@test.local`

  // ---- Owner（context A）：真實 UI 註冊 → 建行程 ----
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await ownerPage.goto('/login')
  await ownerPage.getByPlaceholder('Email').fill(ownerEmail)
  await ownerPage.getByPlaceholder('密碼').fill(password)
  await ownerPage.getByRole('button', { name: '註冊' }).click()
  await expect(ownerPage).toHaveURL(/\/trips$/, { timeout: 15_000 })

  await ownerPage.getByPlaceholder(/行程標題/).fill('E2E Realtime 行程')
  const dates = ownerPage.locator('input[type="date"]')
  await dates.nth(0).fill('2026-12-01')
  await dates.nth(1).fill('2026-12-03')
  await ownerPage.getByRole('button', { name: '建立行程' }).click()
  const tripLink = ownerPage.getByRole('link', { name: /E2E Realtime 行程/ })
  await expect(tripLink).toBeVisible({ timeout: 10_000 })
  await tripLink.click()
  await expect(ownerPage).toHaveURL(/\/trips\/[0-9a-f-]{36}$/)
  createdTripId = ownerPage.url().split('/').pop()

  // ---- Editor（context B）----：直接插入 trip_members（邀請流程已在 invite.spec.ts 覆蓋，
  // 本檔只關心 Realtime 訂閱，兩者都要是 canEdit=true 才會掛載 TripRealtime（spec §6 Step 3：
  // viewer/分享頁不掛訂閱元件），故用 editor 角色而非 viewer
  const { data: editorUser, error: editorCreateErr } = await admin.auth.admin.createUser({
    email: editorEmail, password, email_confirm: true,
  })
  expect(editorCreateErr).toBeNull()
  const { error: memberInsertErr } = await admin
    .from('trip_members')
    .insert({ trip_id: createdTripId!, user_id: editorUser!.user!.id, role: 'editor' })
  expect(memberInsertErr).toBeNull()

  const editorContext = await browser.newContext()
  const editorPage = await editorContext.newPage()
  await editorPage.goto('/login')
  await editorPage.getByPlaceholder('Email').fill(editorEmail)
  await editorPage.getByPlaceholder('密碼').fill(password)
  await editorPage.getByRole('button', { name: '登入', exact: true }).click()
  await expect(editorPage).toHaveURL(/\/trips$/, { timeout: 10_000 })
  await editorPage.goto(`/trips/${createdTripId}`)
  await expect(editorPage.getByText('還沒有停留點，用上方搜尋加入第一個景點')).toBeVisible({ timeout: 10_000 })
  // TripRealtime 掛載於 useEffect，channel join（WebSocket 交握＋SUBSCRIBED）在畫面可見之後才完成；
  // 若插入發生在 SUBSCRIBED 之前，這次事件會直接錯過（不是排隊，是完全收不到）。給訂閱一點建立時間，
  // 寬鬆等待，實測本地環境完成遠快於此
  await editorPage.waitForTimeout(2000)

  // ---- A 插入停留點（模擬旅伴透過 admin/其他分頁寫入）：B 不手動 reload，靠 Realtime debounce
  // refresh 自動看到——寬鬆 timeout 容忍 500ms debounce + Realtime 連線延遲 ----
  const mk = (h: number) => new Date(Date.UTC(2026, 11, 1, h)).toISOString()
  const { error: insertErr } = await admin.from('stops').insert({
    trip_id: createdTripId!, name: 'E2E即時停留點', lat: 33.59, lng: 130.4,
    timezone: 'Asia/Tokyo', starts_at: mk(1), ends_at: mk(2),
  })
  expect(insertErr).toBeNull()
  // 側欄清單與 Timeline 拖曳色塊都會渲染停留點名稱，locator 需限定在側欄（aside）才不會撞上兩處同名
  // 文字造成 strict mode violation（審查時實測發現的既有 UI 事實，非本次改動引入）
  const sidebarStopName = editorPage.locator('aside').getByText('E2E即時停留點')
  await expect(sidebarStopName).toBeVisible({ timeout: 15_000 })

  // ---- 刪除：B 不手動 reload，同步消失（spec §8 DELETE 冪等處理的端對端驗證）----
  const { data: stopRow, error: stopSelectErr } = await admin
    .from('stops').select('id').eq('trip_id', createdTripId!).eq('name', 'E2E即時停留點').single()
  expect(stopSelectErr).toBeNull()
  const { error: deleteErr } = await admin.from('stops').delete().eq('id', stopRow!.id)
  expect(deleteErr).toBeNull()
  await expect(sidebarStopName).toHaveCount(0, { timeout: 15_000 })

  await ownerContext.close()
  await editorContext.close()
})

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  const client = admin ?? createClient(url, serviceKey, { auth: { persistSession: false } })
  if (createdTripId) await client.from('trips').delete().eq('id', createdTripId)
  // M-5：listUsers 翻頁掃到底才能保證零殘留（既有 smoke.spec.ts / invite.spec.ts 慣例）
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
  const testUsers = allUsers.filter(u => u.email?.endsWith('@test.local') && u.email.startsWith('e2e-realtime-'))
  for (const u of testUsers) await client.auth.admin.deleteUser(u.id)
})
