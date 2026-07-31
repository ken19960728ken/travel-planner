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

  // 時間軸：Day 分頁存在且可切換
  await expect(page.getByRole('button', { name: /^D1 / })).toBeVisible()
  const d2 = page.getByRole('button', { name: /^D2 / })
  if (await d2.isVisible().catch(() => false)) {
    await d2.click()
  }

  // 時間軸拖曳（需 service key 直插測試停留點；無 key 環境跳過此段）
  const sbUrl = process.env.SUPABASE_URL
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (sbUrl && sbService && createdTripId) {
    const admin = createClient(sbUrl, sbService, { auth: { persistSession: false } })
    const mk = (h: number) => new Date(Date.UTC(2026, 9, 1, h)).toISOString()
    await admin.from('stops').insert([
      { trip_id: createdTripId, name: 'E2E拖曳A', lat: 33.59, lng: 130.4, timezone: 'Asia/Tokyo', starts_at: mk(1), ends_at: mk(2) },
      { trip_id: createdTripId, name: 'E2E拖曳B', lat: 33.6, lng: 130.42, timezone: 'Asia/Tokyo', starts_at: mk(3), ends_at: mk(4) },
    ])
    await page.reload()
    const blockA = page.locator('[data-stop-block]').first()
    await expect(blockA).toBeVisible({ timeout: 10_000 })
    const before = await admin.from('stops').select('name, starts_at').eq('trip_id', createdTripId).order('starts_at')
    const box = (await blockA.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(3000) // RPC + refresh
    const after = await admin.from('stops').select('name, starts_at').eq('trip_id', createdTripId).order('name')
    const beforeMap = Object.fromEntries(before.data!.map(r => [r.name, new Date(r.starts_at).getTime()]))
    const afterMap = Object.fromEntries(after.data!.map(r => [r.name, new Date(r.starts_at).getTime()]))
    const deltaA = afterMap['E2E拖曳A'] - beforeMap['E2E拖曳A']
    const deltaB = afterMap['E2E拖曳B'] - beforeMap['E2E拖曳B']
    expect(deltaA).toBeGreaterThanOrEqual(5 * 60 * 1000) // 至少一個 snap
    expect(deltaB).toBe(deltaA) // 連鎖：B 跟 A 同步平移
  }
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
