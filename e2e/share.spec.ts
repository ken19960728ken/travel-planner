import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 護欄（比照 invite.spec.ts / smoke.spec.ts 既有模式）：afterAll 的 listUsers 會翻頁掃描整個
// auth.users 表並刪除符合前綴的帳號——只允許對本地 Supabase 執行，避免 .env.test.local 誤指到
// 雲端時大規模誤刪正式帳號
const sbUrlGuard = process.env.SUPABASE_URL
if (sbUrlGuard && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(sbUrlGuard)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行 E2E 測試（防止誤打正式環境）')
}

// M-5：本檔專屬 e2e-share- 前綴，afterAll 清理只 filter 這個前綴，不會跟其他 e2e 檔案互相誤刪
let createdTripId: string | undefined
let admin: SupabaseClient | undefined

test('分享連結唯讀檢視：owner 建行程 → 無痕開分享連結 → 可見標題且無編輯入口', async ({ browser }) => {
  const sbUrl = process.env.SUPABASE_URL
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!sbUrl || !sbService, '需要本地 Supabase service role key（直接讀 share_token）')

  admin = createClient(sbUrl!, sbService!, { auth: { persistSession: false } })
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'e2e-share-password-1234'
  const ownerEmail = `e2e-share-owner-${suffix}@test.local`

  // ---- Owner：註冊 → 建行程（比照 smoke.spec.ts 模式） ----
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await ownerPage.goto('/login')
  await ownerPage.getByPlaceholder('Email').fill(ownerEmail)
  await ownerPage.getByPlaceholder('密碼').fill(password)
  await ownerPage.getByRole('button', { name: '註冊' }).click()
  await expect(ownerPage).toHaveURL(/\/trips$/, { timeout: 15_000 })

  await ownerPage.getByPlaceholder(/行程標題/).fill('E2E 分享行程')
  const dates = ownerPage.locator('input[type="date"]')
  await dates.nth(0).fill('2026-12-01')
  await dates.nth(1).fill('2026-12-03')
  await ownerPage.getByRole('button', { name: '建立行程' }).click()
  const tripLink = ownerPage.getByRole('link', { name: /E2E 分享行程/ })
  await expect(tripLink).toBeVisible({ timeout: 10_000 })
  await tripLink.click()
  await expect(ownerPage).toHaveURL(/\/trips\/[0-9a-f-]{36}$/)
  createdTripId = ownerPage.url().split('/').pop()

  // 從 DB 撈 share_token（不依賴 clipboard 權限，比照 invite.spec.ts 的 token 取得方式）
  const { data: tripRow, error: tripErr } = await admin
    .from('trips').select('share_token').eq('id', createdTripId!).single()
  expect(tripErr).toBeNull()
  const shareToken = tripRow!.share_token as string

  // ---- 無痕 context：全新瀏覽器情境，無任何登入 cookie ----
  const anonContext = await browser.newContext()
  const anonPage = await anonContext.newPage()
  await anonPage.goto(`/share/${shareToken}`)
  await expect(anonPage.getByText('E2E 分享行程')).toBeVisible({ timeout: 10_000 })
  await expect(anonPage.getByText('👁 分享檢視')).toBeVisible()
  // 唯讀斷言沿用 Task 5 的唯讀化語義（invite.spec.ts 已鎖：canEdit=false 時是這句空清單文案）；
  // 反面同時斷言 editor 專屬文案不存在，避免誤判成有編輯入口的版本
  await expect(anonPage.getByText('這個行程還沒有停留點', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(anonPage.getByText('還沒有停留點，用上方搜尋加入第一個景點')).toHaveCount(0)

  await ownerContext.close()
  await anonContext.close()
})

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  const client = admin ?? createClient(url, serviceKey, { auth: { persistSession: false } })
  if (createdTripId) await client.from('trips').delete().eq('id', createdTripId)
  // M-5：listUsers 預設每頁 50 筆，翻頁掃到底才能保證零殘留
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
  const testUsers = allUsers.filter(u => u.email?.endsWith('@test.local') && u.email.startsWith('e2e-share-'))
  for (const u of testUsers) await client.auth.admin.deleteUser(u.id)
})
