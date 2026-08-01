import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 護欄（critic 審查 H-2）：本檔用 service role 大量建立/刪除測試帳號，且清理階段會 listUsers
// 翻頁掃描整個 auth.users 表——只允許對本地 Supabase 執行，避免 .env.test.local 誤指到雲端時
// 大規模誤刪正式帳號（比照 src/lib/supabase/invites.test.ts 既有護欄）
const sbUrlGuard = process.env.SUPABASE_URL
if (sbUrlGuard && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(sbUrlGuard)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行 E2E 測試（防止誤打正式環境）')
}

// M-5：本檔專屬 e2e-invite- 前綴，afterAll 清理只 filter 這個前綴，
// 不會跟 smoke.spec.ts（e2e-smoke-）或未來其他 e2e 檔案的測試帳號互相誤刪。
let createdTripId: string | undefined
let admin: SupabaseClient | undefined

test('owner 建行程 → 邀請 editor/viewer → 各自加入對應角色 → 移除 editor 後其行程頁 404（含邀請連帶撤銷）', async ({ browser }) => {
  const sbUrl = process.env.SUPABASE_URL
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!sbUrl || !sbService, '需要本地 Supabase service role key（建立額外測試帳號、直接讀邀請 token）')

  admin = createClient(sbUrl!, sbService!, { auth: { persistSession: false } })
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'e2e-invite-password-1234'
  const ownerEmail = `e2e-invite-owner-${suffix}@test.local`
  const editorEmail = `e2e-invite-editor-${suffix}@test.local`
  const viewerEmail = `e2e-invite-viewer-${suffix}@test.local`
  const editorLocalPart = editorEmail.split('@')[0]

  // editor/viewer 帳號直接用 admin API 建（email_confirm: true），不必各跑一次註冊 UI 流程；
  // owner 則透過真實 UI 註冊 → 建行程，覆蓋這條主要入口（比照 smoke.spec.ts 模式）
  const { error: editorCreateErr } = await admin.auth.admin.createUser({
    email: editorEmail, password, email_confirm: true,
  })
  expect(editorCreateErr).toBeNull()
  const { data: viewerUser, error: viewerCreateErr } = await admin.auth.admin.createUser({
    email: viewerEmail, password, email_confirm: true,
  })
  expect(viewerCreateErr).toBeNull()

  // ---- Owner：註冊 → 建行程 ----
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await ownerPage.goto('/login')
  await ownerPage.getByPlaceholder('Email').fill(ownerEmail)
  await ownerPage.getByPlaceholder('密碼').fill(password)
  await ownerPage.getByRole('button', { name: '註冊' }).click()
  await expect(ownerPage).toHaveURL(/\/trips$/, { timeout: 15_000 })

  await ownerPage.getByPlaceholder(/行程標題/).fill('E2E 邀請行程')
  const dates = ownerPage.locator('input[type="date"]')
  await dates.nth(0).fill('2026-11-01')
  await dates.nth(1).fill('2026-11-03')
  await ownerPage.getByRole('button', { name: '建立行程' }).click()
  const tripLink = ownerPage.getByRole('link', { name: /E2E 邀請行程/ })
  await expect(tripLink).toBeVisible({ timeout: 10_000 })
  await tripLink.click()
  await expect(ownerPage).toHaveURL(/\/trips\/[0-9a-f-]{36}$/)
  createdTripId = ownerPage.url().split('/').pop()

  // ---- Owner：開成員面板，產生 editor 邀請（預設角色） ----
  await ownerPage.getByRole('button', { name: /^成員/ }).click()
  await ownerPage.getByRole('button', { name: '產生邀請連結' }).click()
  // 兩道斷言：notice 文字 + 邀請清單真的多一列（critic 審查 M-5：只認 notice 文字有極小機率撞上前一則
  // 殘留提示的時序巧合，邀請清單內容才是「這次真的建成了」的可靠信號，兩者一起判斷更穩）
  await expect(ownerPage.getByText(/已複製|已建立邀請連結/)).toBeVisible({ timeout: 5_000 })
  await expect(ownerPage.getByText(/可編輯・剩餘/)).toBeVisible({ timeout: 5_000 })

  // 從 DB 撈剛建立的 token（不依賴 clipboard 權限，更穩定；比照計畫「從 DB 撈 token 組 URL」）
  const { data: editorInviteRow, error: editorInviteErr } = await admin
    .from('trip_invites')
    .select('id')
    .eq('trip_id', createdTripId!)
    .eq('role', 'editor')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  expect(editorInviteErr).toBeNull()
  const editorToken = editorInviteRow!.id

  // 切換邀請角色為 viewer，再產生一則
  await ownerPage.getByLabel('邀請角色').selectOption('viewer')
  await ownerPage.getByRole('button', { name: '產生邀請連結' }).click()
  await expect(ownerPage.getByText(/已複製|已建立邀請連結/)).toBeVisible({ timeout: 5_000 })
  await expect(ownerPage.getByText(/僅檢視・剩餘/)).toBeVisible({ timeout: 5_000 })
  const { data: viewerInviteRow, error: viewerInviteErr } = await admin
    .from('trip_invites')
    .select('id')
    .eq('trip_id', createdTripId!)
    .eq('role', 'viewer')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  expect(viewerInviteErr).toBeNull()
  const viewerToken = viewerInviteRow!.id

  // ---- Editor（B）：登入 → 開接受頁 → 加入 → 可見編輯入口 ----
  const editorContext = await browser.newContext()
  const editorPage = await editorContext.newPage()
  await editorPage.goto('/login')
  await editorPage.getByPlaceholder('Email').fill(editorEmail)
  await editorPage.getByPlaceholder('密碼').fill(password)
  await editorPage.getByRole('button', { name: '登入', exact: true }).click()
  await expect(editorPage).toHaveURL(/\/trips$/, { timeout: 10_000 })

  await editorPage.goto(`/invite/${editorToken}`)
  await editorPage.getByRole('button', { name: '加入行程' }).click()
  await expect(editorPage).toHaveURL(new RegExp(`/trips/${createdTripId}$`), { timeout: 10_000 })
  // editor 唯一路徑：canEdit=true 時的空清單文案（Task 5 唯讀化的斷言邏輯，見 TripView.tsx）
  await expect(editorPage.getByText('還沒有停留點，用上方搜尋加入第一個景點')).toBeVisible({ timeout: 10_000 })
  await expect(editorPage.getByText('👁 檢視模式')).toHaveCount(0)

  // ---- Viewer（B2）：登入 → 開接受頁 → 加入 → 無編輯入口 ----
  const viewerContext = await browser.newContext()
  const viewerPage = await viewerContext.newPage()
  await viewerPage.goto('/login')
  await viewerPage.getByPlaceholder('Email').fill(viewerEmail)
  await viewerPage.getByPlaceholder('密碼').fill(password)
  await viewerPage.getByRole('button', { name: '登入', exact: true }).click()
  await expect(viewerPage).toHaveURL(/\/trips$/, { timeout: 10_000 })

  await viewerPage.goto(`/invite/${viewerToken}`)
  await viewerPage.getByRole('button', { name: '加入行程' }).click()
  await expect(viewerPage).toHaveURL(new RegExp(`/trips/${createdTripId}$`), { timeout: 10_000 })
  // viewer 唯一路徑：canEdit=false 時的空清單文案 + 檢視模式徽章，兩者同時成立才是真正唯讀化
  await expect(viewerPage.getByText('這個行程還沒有停留點', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(viewerPage.getByText('👁 檢視模式')).toBeVisible()

  // ---- Owner：重新整理拿到最新成員名單 → 移除 editor（B） ----
  await ownerPage.reload()
  await ownerPage.getByRole('button', { name: /^成員/ }).click()
  const editorRow = ownerPage.locator('li').filter({ hasText: editorLocalPart })
  await expect(editorRow).toBeVisible({ timeout: 10_000 })
  await editorRow.getByRole('button', { name: '移除成員' }).click()
  await editorRow.getByRole('button', { name: '確認移除' }).click()
  await expect(ownerPage.getByText(/已移除 ✓/)).toBeVisible({ timeout: 10_000 })

  // editor（B）被移除後再開行程頁 → 404（RLS 擋掉 select，page.tsx 的 notFound() 路徑）
  const res = await editorPage.goto(`/trips/${createdTripId}`)
  expect(res?.status()).toBe(404)

  // Task 6 遺留根治驗證（critic 審查 C-1 後改採「移除成員時撤銷該行程全部邀請」設計，
  // 見 MembersPanel.tsx 檔頭註解與 invites.test.ts 同名案例）：editor 的邀請與 viewer 已用過的
  // 邀請都應一併消失——不是只清「被移除者曾用過的那條」，是整個行程的邀請連結全部作廢
  const { data: editorInviteAfter } = await admin.from('trip_invites').select('id').eq('id', editorToken).maybeSingle()
  expect(editorInviteAfter).toBeNull()
  const { data: viewerInviteAfter } = await admin.from('trip_invites').select('id').eq('id', viewerToken).maybeSingle()
  expect(viewerInviteAfter).toBeNull()

  // viewer（B2）的成員資格未被移除（只有邀請連結被撤銷，trip_members 不受影響）：
  // 確認移除操作精準作用在 editor 身上，沒有誤傷其他成員的成員資格
  const { data: viewerStillMember } = await admin
    .from('trip_members')
    .select('role')
    .eq('trip_id', createdTripId!)
    .eq('user_id', viewerUser!.user!.id)
    .maybeSingle()
  expect(viewerStillMember?.role).toBe('viewer')

  await ownerContext.close()
  await editorContext.close()
  await viewerContext.close()
})

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  const client = admin ?? createClient(url, serviceKey, { auth: { persistSession: false } })
  if (createdTripId) await client.from('trips').delete().eq('id', createdTripId)
  // M-5：listUsers 預設每頁 50 筆，翻頁掃到底才能保證零殘留（既有 smoke.spec.ts 缺口同步修正）
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
  const testUsers = allUsers.filter(u => u.email?.endsWith('@test.local') && u.email.startsWith('e2e-invite-'))
  for (const u of testUsers) await client.auth.admin.deleteUser(u.id)
})
