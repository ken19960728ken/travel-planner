import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 護欄（比照 invite.spec.ts／smoke.spec.ts）：afterAll 的 listUsers 會翻頁掃描整個 auth.users 表
// 並刪除符合前綴的帳號——只允許對本地 Supabase 執行，避免 .env.test.local 誤指到雲端時大規模
// 誤刪正式帳號（比照 src/lib/supabase/invites.test.ts 既有護欄）
const sbUrlGuard = process.env.SUPABASE_URL
if (sbUrlGuard && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(sbUrlGuard)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行 E2E 測試（防止誤打正式環境）')
}

// 本檔專屬 e2e-candidate- 前綴，afterAll 清理只 filter 這個前綴，不會跟 smoke.spec.ts（e2e-smoke-）
// 或 invite.spec.ts（e2e-invite-）的測試帳號互相誤刪。
let createdTripId: string | undefined
let admin: SupabaseClient | undefined

test('存入備選 → 面板顯示 → 拼入行程落地為停留點 → viewer 唯讀可見', async ({ browser }) => {
  const sbUrl = process.env.SUPABASE_URL
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!sbUrl || !sbService, '需要本地 Supabase service role key（直接寫入 trip_candidates／trip_members，繞過 Google Places 自動完成）')

  admin = createClient(sbUrl!, sbService!, { auth: { persistSession: false } })
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'e2e-candidate-password-1234'
  const ownerEmail = `e2e-candidate-owner-${suffix}@test.local`
  const viewerEmail = `e2e-candidate-viewer-${suffix}@test.local`

  const { data: viewerUser, error: viewerCreateErr } = await admin.auth.admin.createUser({
    email: viewerEmail, password, email_confirm: true,
  })
  expect(viewerCreateErr).toBeNull()

  // 地圖金鑰 referrer 未涵蓋目前來源時，Google Maps 只在 console 噴錯、不拋例外，其餘斷言仍會綠燈通過——
  // 全程收集這類訊息（owner／viewer 兩個頁面都掛地圖，一併收集），尾端斷言必須為空，避免金鑰設定錯誤
  // 被誤判為「測試通過」的假綠燈（比照 smoke.spec.ts）
  const mapsErrors: string[] = []
  // 點備選名稱會掛橘色 AdvancedMarker——落在 canvas 內無法用 DOM 斷言，改收集 pageerror，斷言點擊後
  // 不崩潰（Map 區塊有 SectionErrorBoundary，渲染例外不會讓整頁白屏，但仍會冒泡出 pageerror 事件）
  const ownerPageErrors: string[] = []

  // ---- Owner：註冊 → 建立 3 天行程 ----
  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  ownerPage.on('console', msg => {
    if (msg.text().includes('Google Maps JavaScript API error')) mapsErrors.push(msg.text())
  })
  ownerPage.on('pageerror', err => ownerPageErrors.push(err.message))

  await ownerPage.goto('/login')
  await ownerPage.getByPlaceholder('Email').fill(ownerEmail)
  await ownerPage.getByPlaceholder('密碼').fill(password)
  await ownerPage.getByRole('button', { name: '註冊' }).click()
  await expect(ownerPage).toHaveURL(/\/trips$/, { timeout: 15_000 })

  await ownerPage.getByPlaceholder(/行程標題/).fill('E2E 備選行程')
  const dates = ownerPage.locator('input[type="date"]')
  await dates.nth(0).fill('2026-12-01')
  await dates.nth(1).fill('2026-12-03')
  await ownerPage.getByRole('button', { name: '建立行程' }).click()
  const tripLink = ownerPage.getByRole('link', { name: /E2E 備選行程/ })
  await expect(tripLink).toBeVisible({ timeout: 10_000 })
  await tripLink.click()
  await expect(ownerPage).toHaveURL(/\/trips\/[0-9a-f-]{36}$/)
  createdTripId = ownerPage.url().split('/').pop()

  // ---- Admin：service role 直插 2 筆候選（繞開 Places 自動完成，見檔頭設計註解） ----
  const candidateNameA = 'E2E備選博多駅'
  const candidateNameB = 'E2E備選福岡塔'
  const { error: candidateInsertErr } = await admin.from('trip_candidates').insert([
    { trip_id: createdTripId, name: candidateNameA, lat: 33.5904, lng: 130.4017, place_id: `e2e-candidate-place-a-${suffix}` },
    { trip_id: createdTripId, name: candidateNameB, lat: 33.5629, lng: 130.3958, place_id: `e2e-candidate-place-b-${suffix}` },
  ])
  expect(candidateInsertErr).toBeNull()

  // ---- Owner 視角：重新整理拿到 SSR 帶入的候選清單 ----
  // 候選一旦拼入行程，同一個名字會同時出現在地圖標記（title）與時間軸色塊（可見文字）上，
  // 兩者的 accessible name／文字內容都可能與候選名稱完全相同——後續斷言一律限定在備選面板
  // （<details> 內）範圍，避免把「拼入後在別處新出現的同名元素」誤判成「候選列還沒消失」。
  await ownerPage.reload()
  const candidatesPanel = ownerPage.locator('details').filter({ hasText: '備選（' })
  const candidateAButton = candidatesPanel.getByRole('button', { name: candidateNameA, exact: true })
  const candidateBButton = candidatesPanel.getByRole('button', { name: candidateNameB, exact: true })
  await expect(candidateAButton).toBeVisible({ timeout: 10_000 })
  await expect(candidateBButton).toBeVisible()
  await expect(candidatesPanel.getByRole('button', { name: '拼入行程' })).toHaveCount(2)

  // 點備選名稱：只斷言不崩潰（aria-pressed 翻轉證明點擊有正常處理，橘釘落在地圖 canvas 內無法斷言）
  await candidateAButton.click()
  await expect(candidateAButton).toHaveAttribute('aria-pressed', 'true')
  expect(ownerPageErrors).toEqual([])

  // ---- 選第 2 天 → 拼入行程 → 該備選列消失、側欄第 2 天出現同名停留點 ----
  const dayKeys = ['2026-12-01', '2026-12-02', '2026-12-03']
  const rowA = candidatesPanel.locator('li').filter({ hasText: candidateNameA })
  // 用 aria-label 指名日期下拉：Plan 7 在同一列加了分類下拉，裸 locator('select') 會命中兩個而違反
  // strict mode（這條測試因此在 main 上紅了一段時間沒被發現）
  await rowA.getByLabel('拼入哪一天').selectOption(dayKeys[1])
  await rowA.getByRole('button', { name: '拼入行程' }).click()

  await expect(candidateAButton).toHaveCount(0, { timeout: 10_000 })
  // 側欄停留點列表的名稱固定用 <span className="font-medium"> 承載（見 TripView.tsx），
  // 用這個結構鎖定「側欄新出現的停留點」，不誤中地圖標記／時間軸色塊上同名的 accessible name
  const promotedStopName = ownerPage.locator('span.font-medium', { hasText: candidateNameA })
  await expect(promotedStopName).toBeVisible({ timeout: 10_000 })
  await expect(candidatesPanel.getByRole('button', { name: '拼入行程' })).toHaveCount(1)

  // ---- Viewer：admin 直接寫 trip_members role='viewer'，登入後開同一行程 ----
  const { error: memberInsertErr } = await admin
    .from('trip_members')
    .insert({ trip_id: createdTripId, user_id: viewerUser!.user!.id, role: 'viewer' })
  expect(memberInsertErr).toBeNull()

  const viewerContext = await browser.newContext()
  const viewerPage = await viewerContext.newPage()
  viewerPage.on('console', msg => {
    if (msg.text().includes('Google Maps JavaScript API error')) mapsErrors.push(msg.text())
  })

  await viewerPage.goto('/login')
  await viewerPage.getByPlaceholder('Email').fill(viewerEmail)
  await viewerPage.getByPlaceholder('密碼').fill(password)
  await viewerPage.getByRole('button', { name: '登入', exact: true }).click()
  await expect(viewerPage).toHaveURL(/\/trips$/, { timeout: 10_000 })

  await viewerPage.goto(`/trips/${createdTripId}`)
  await expect(viewerPage).toHaveURL(new RegExp(`/trips/${createdTripId}$`))
  // 唯讀不是不能看：候選 B 仍未拼入行程，viewer 應該看得到名稱，但不給任何寫入出口
  const viewerCandidatesPanel = viewerPage.locator('details').filter({ hasText: '備選（' })
  await expect(viewerCandidatesPanel.getByText(candidateNameB, { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(viewerPage.getByRole('button', { name: '拼入行程' })).toHaveCount(0)
  await expect(viewerPage.getByRole('button', { name: '刪除' })).toHaveCount(0)

  expect(mapsErrors).toEqual([])

  await ownerContext.close()
  await viewerContext.close()
})

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  const client = admin ?? createClient(url, serviceKey, { auth: { persistSession: false } })
  if (createdTripId) await client.from('trips').delete().eq('id', createdTripId)
  // listUsers 預設每頁 50 筆，翻頁掃到底才能保證零殘留（比照 invite.spec.ts／smoke.spec.ts 既有修正）
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
  const testUsers = allUsers.filter(u => u.email?.endsWith('@test.local') && u.email.startsWith('e2e-candidate-'))
  for (const u of testUsers) await client.auth.admin.deleteUser(u.id)
})
