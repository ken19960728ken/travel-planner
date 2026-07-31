import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

let createdTripId: string | undefined

// 需要本地 Supabase（供 auth 與資料庫）；email 自動確認為本地設定
test('註冊 → 自動登入 → 建立行程 → 清單顯示 → 開詳情頁', async ({ page }) => {
  const email = `e2e-${Math.random().toString(36).slice(2, 8)}@test.local`

  await page.goto('/login')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('密碼').fill('e2e-password-1234')
  await page.getByRole('button', { name: '註冊' }).click()

  // 本地 autoconfirm：註冊後直接進 /trips
  await expect(page).toHaveURL(/\/trips$/, { timeout: 15_000 })

  await page.getByPlaceholder(/行程標題/).fill('E2E 東京行')
  const dates = page.locator('input[type="date"]')
  await dates.nth(0).fill('2026-10-01')
  await dates.nth(1).fill('2026-10-05')
  await page.getByRole('button', { name: '建立行程' }).click()

  const tripLink = page.getByRole('link', { name: /E2E 東京行/ })
  await expect(tripLink).toBeVisible({ timeout: 10_000 })

  await tripLink.click()
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]{36}$/)
  createdTripId = page.url().split('/').pop()
  await expect(page.getByText('還沒有停留點')).toBeVisible({ timeout: 10_000 })

  // 無金鑰環境顯示占位訊息；有金鑰環境顯示地圖——兩者擇一存在即可
  const placeholder = page.getByText(/尚未設定 NEXT_PUBLIC_GOOGLE_MAPS_API_KEY/)
  const mapCanvas = page.locator('.gm-style').first()
  await expect(placeholder.or(mapCanvas)).toBeVisible({ timeout: 10_000 })
})

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  if (createdTripId) await admin.from('trips').delete().eq('id', createdTripId)
  const { data } = await admin.auth.admin.listUsers()
  const testUsers = data?.users.filter(u => u.email?.endsWith('@test.local') && u.email.startsWith('e2e-')) ?? []
  for (const u of testUsers) await admin.auth.admin.deleteUser(u.id)
})
