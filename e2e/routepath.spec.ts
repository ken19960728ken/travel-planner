import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 護欄（比照 candidates.spec.ts／invite.spec.ts／smoke.spec.ts）：afterAll 的 listUsers 會翻頁掃描
// 整個 auth.users 表並刪除符合前綴的帳號——只允許對本地 Supabase 執行，避免 .env.test.local 誤指
// 到雲端時大規模誤刪正式帳號
const sbUrlGuard = process.env.SUPABASE_URL
if (sbUrlGuard && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(sbUrlGuard)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行 E2E 測試（防止誤打正式環境）')
}

// 本檔專屬 e2e-routepath- 前綴，afterAll 清理只 filter 這個前綴，不會跟其他 spec 的測試帳號互相誤刪。
let createdTripId: string | undefined
let admin: SupabaseClient | undefined

test('畫路徑 → 落地 DB → 重新載入仍在 → 分享頁可見 → 還原成自動路線', async ({ browser }) => {
  const sbUrl = process.env.SUPABASE_URL
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!sbUrl || !sbService, '需要本地 Supabase service role key（直接插入 stops／legs，繞過 Google Places 自動完成與路線計算）')

  admin = createClient(sbUrl!, sbService!, { auth: { persistSession: false } })
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'e2e-routepath-password-1234'
  const ownerEmail = `e2e-routepath-owner-${suffix}@test.local`

  // 金鑰 referrer 未涵蓋目前來源時 Google Maps 只在 console 噴錯、不拋例外，其餘斷言仍會綠燈——
  // 收集後尾端斷言為空，避免假綠燈（比照 smoke.spec.ts）
  const mapsErrors: string[] = []
  const pageErrors: string[] = []

  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', msg => {
    if (msg.text().includes('Google Maps JavaScript API error')) mapsErrors.push(msg.text())
  })
  page.on('pageerror', err => pageErrors.push(err.message))

  await page.goto('/login')
  await page.getByPlaceholder('Email').fill(ownerEmail)
  await page.getByPlaceholder('密碼').fill(password)
  await page.getByRole('button', { name: '註冊' }).click()
  await expect(page).toHaveURL(/\/trips$/, { timeout: 15_000 })

  await page.getByPlaceholder(/行程標題/).fill('E2E 手繪路徑')
  const dates = page.locator('input[type="date"]')
  await dates.nth(0).fill('2026-12-01')
  await dates.nth(1).fill('2026-12-01')
  await page.getByRole('button', { name: '建立行程' }).click()
  const tripLink = page.getByRole('link', { name: /E2E 手繪路徑/ })
  await expect(tripLink).toBeVisible({ timeout: 10_000 })
  await tripLink.click()
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]{36}$/)
  createdTripId = page.url().split('/').pop()

  // service role 直插兩個停留點與一段「無大眾運輸資料」的交通段——這正是本功能要解決的情境
  // （Google 對日本 transit 回純步行路線，地圖畫出來卻像真實交通路線）
  const { data: stops, error: stopsErr } = await admin.from('stops').insert([
    {
      trip_id: createdTripId, name: 'E2E博多站', lat: 33.5897, lng: 130.4207, is_custom: true,
      timezone: 'Asia/Tokyo', starts_at: '2026-12-01T01:00:00Z', ends_at: '2026-12-01T01:30:00Z', category: 'transport',
    },
    {
      trip_id: createdTripId, name: 'E2E中洲', lat: 33.5938, lng: 130.4043, is_custom: true,
      timezone: 'Asia/Tokyo', starts_at: '2026-12-01T03:00:00Z', ends_at: '2026-12-01T04:00:00Z', category: 'sight',
    },
  ]).select('id')
  expect(stopsErr).toBeNull()

  const { data: insertedLegs, error: legErr } = await admin.from('legs').insert({
    trip_id: createdTripId, from_stop_id: stops![0].id, to_stop_id: stops![1].id,
    mode: 'transit', source: 'auto', stale: false, duration_minutes: 25,
    detail: { no_transit_data: true },
  }).select('id')
  expect(legErr).toBeNull()
  const legId = insertedLegs![0].id

  await page.reload()
  await expect(page.getByText(/無大眾運輸資料/)).toBeVisible({ timeout: 15_000 })

  // ---- 展開交通段編輯器 → 進入畫路徑模式 ----
  await page.getByText(/無大眾運輸資料/).first().click()
  const drawButton = page.getByRole('button', { name: '畫路徑' })
  await expect(drawButton).toBeVisible({ timeout: 10_000 })
  await drawButton.click()

  // 工具列出現＝已進入編輯模式；計數從 0 開始
  await expect(page.getByText(/0\/100/)).toBeVisible({ timeout: 10_000 })

  // ---- 在地圖上點兩下加轉折點 ----
  const mapBox = await page.locator('[data-testid="map"]').boundingBox()
  expect(mapBox).not.toBeNull()
  // 點在地圖下緣兩側：起播 fitBounds 會把兩個停留點收在中央偏上，而停留點的 AdvancedMarker 是
  // DOM 元素、會吃掉落在它身上的點擊（實測踩過——點中央時只加得到一個點）。工具列在 TOP_CENTER，
  // 也要避開。故選左下與右下兩個明確空白的位置。
  for (const [fx, fy] of [[0.2, 0.82], [0.8, 0.82]]) {
    await page.mouse.click(mapBox!.x + mapBox!.width * fx, mapBox!.y + mapBox!.height * fy)
    await page.waitForTimeout(400)
  }
  await expect(page.getByText(/2\/100/)).toBeVisible({ timeout: 5_000 })

  await page.getByRole('button', { name: '儲存' }).last().click()

  // ---- 落地 DB ----
  await expect
    .poll(async () => {
      const { data } = await admin!.from('legs').select('custom_path').eq('id', legId).single()
      return Array.isArray(data?.custom_path) ? (data!.custom_path as unknown[]).length : 0
    }, { timeout: 15_000 })
    .toBe(2)

  // ---- 重新載入仍在：側欄出現 ✏️ 標記、鈕變成「編輯路徑」 ----
  await page.reload()
  await expect(page.getByText(/✏️/)).toBeVisible({ timeout: 15_000 })
  await page.getByText(/無大眾運輸資料/).first().click()
  await expect(page.getByRole('button', { name: '編輯路徑' })).toBeVisible({ timeout: 10_000 })

  // ---- 分享頁可見（匿名，驗證 get_shared_trip 白名單有放行 custom_path） ----
  const { data: tripRow } = await admin.from('trips').select('share_token').eq('id', createdTripId!).single()
  const shareContext = await browser.newContext()
  const sharePage = await shareContext.newPage()
  const sharePageErrors: string[] = []
  sharePage.on('pageerror', err => sharePageErrors.push(err.message))
  const shareResponse = await sharePage.goto(`/share/${tripRow!.share_token}`)
  expect(shareResponse?.status()).toBeLessThan(400)
  await expect(sharePage.getByText('E2E 手繪路徑')).toBeVisible({ timeout: 15_000 })
  // 匿名訪客拿到的 payload 必須含 custom_path——不然分享頁畫的線會與擁有者看到的不一致
  const sharedCustomPath = await sharePage.evaluate(async () => {
    const html = document.documentElement.innerHTML
    return html.includes('custom_path')
  })
  expect(sharedCustomPath).toBe(true)
  expect(sharePageErrors).toEqual([])
  await shareContext.close()

  // ---- 還原成自動路線 → DB 回 null、✏️ 消失 ----
  await page.getByRole('button', { name: '還原成自動路線' }).click()
  await expect
    .poll(async () => {
      const { data } = await admin!.from('legs').select('custom_path').eq('id', legId).single()
      return data?.custom_path
    }, { timeout: 15_000 })
    .toBeNull()

  expect(mapsErrors).toEqual([])
  expect(pageErrors).toEqual([])
  await context.close()
})

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  const client = admin ?? createClient(url, serviceKey, { auth: { persistSession: false } })
  if (createdTripId) await client.from('trips').delete().eq('id', createdTripId)
  // listUsers 預設每頁 50 筆，翻頁掃到底才能保證零殘留（比照其他 spec 的既有修正）
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
  const testUsers = allUsers.filter(u => u.email?.endsWith('@test.local') && u.email.startsWith('e2e-routepath-'))
  for (const u of testUsers) await client.auth.admin.deleteUser(u.id)
})
