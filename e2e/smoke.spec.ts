import { test, expect } from '@playwright/test'

// 需要本地 Supabase（供 auth 與資料庫）；email 自動確認為本地設定
test('註冊 → 自動登入 → 建立行程 → 清單顯示 → 開詳情頁', async ({ page }) => {
  const email = `e2e-${Date.now()}@test.local`

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
  await expect(page.getByText('還沒有停留點')).toBeVisible({ timeout: 10_000 })
})
