import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 護欄（比照 routepath.spec.ts／candidates.spec.ts）：afterAll 的 listUsers 會翻頁掃描整個
// auth.users 表並刪除符合前綴的帳號——只允許對本地 Supabase 執行。
const sbUrlGuard = process.env.SUPABASE_URL
if (sbUrlGuard && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(sbUrlGuard)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行 E2E 測試（防止誤打正式環境）')
}

// 本檔專屬 e2e-participants- 前綴，afterAll 只 filter 這個前綴。
let createdTripId: string | undefined
let admin: SupabaseClient | undefined

const legKeys = async (tripId: string, client: SupabaseClient, stopName: Map<string, string>) => {
  const { data } = await client.from('legs').select('from_stop_id, to_stop_id').eq('trip_id', tripId)
  return (data ?? [])
    .map(l => `${stopName.get(l.from_stop_id) ?? '?'}→${stopName.get(l.to_stop_id) ?? '?'}`)
    .sort()
}

test('分頭行動：交通段分軌生成、不產生幻影段、重疊不誤報衝突、移除參與人回到全員', async ({ browser }) => {
  const sbUrl = process.env.SUPABASE_URL
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!sbUrl || !sbService, '需要本地 Supabase service role key（直接插入 stops，繞過 Google Places 自動完成）')

  admin = createClient(sbUrl!, sbService!, { auth: { persistSession: false } })
  const suffix = Math.random().toString(36).slice(2, 8)
  const password = 'e2e-participants-password-1234'
  const ownerEmail = `e2e-participants-owner-${suffix}@test.local`

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

  await page.getByPlaceholder(/行程標題/).fill('E2E 參與人')
  const dates = page.locator('input[type="date"]')
  await dates.nth(0).fill('2026-12-05')
  await dates.nth(1).fill('2026-12-05')
  await page.getByRole('button', { name: '建立行程' }).click()
  const tripLink = page.getByRole('link', { name: /E2E 參與人/ })
  await expect(tripLink).toBeVisible({ timeout: 10_000 })
  await tripLink.click()
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]{36}$/)
  createdTripId = page.url().split('/').pop()!

  // ---- 四個停留點：A 共同 → B(甲)/C(乙) 同時段分頭 → D 共同會合 ----
  // 這正是現行單軌演算法會出錯的形狀：按時間排序取相鄰配對會生出 B→C（沒有人走過），
  // 而真正存在的 A→C 永遠不會被建立。
  const mk = (name: string, from: string, to: string) => ({
    trip_id: createdTripId, name, lat: 33.59, lng: 130.42, is_custom: true,
    timezone: 'Asia/Tokyo', starts_at: from, ends_at: to, category: 'sight',
  })
  const { data: stops, error: stopsErr } = await admin.from('stops').insert([
    mk('E2E共同早上', '2026-12-05T00:00:00Z', '2026-12-05T01:00:00Z'),
    mk('E2E甲的下午', '2026-12-05T03:00:00Z', '2026-12-05T04:00:00Z'),
    mk('E2E乙的下午', '2026-12-05T03:00:00Z', '2026-12-05T04:00:00Z'),
    mk('E2E共同晚上', '2026-12-05T09:00:00Z', '2026-12-05T10:00:00Z'),
  ]).select('id, name')
  expect(stopsErr).toBeNull()
  const stopName = new Map((stops ?? []).map(s => [s.id, s.name.replace('E2E', '')]))
  const idOf = (n: string) => (stops ?? []).find(s => s.name === n)!.id

  await page.reload()

  // ---- 名冊：加兩個無帳號同行者 ----
  // 面板在 router.refresh() 後**保持開啟**（連續加人不必重開），所以只點一次
  await page.getByRole('button', { name: /參與人/ }).click()
  await page.getByPlaceholder(/同行者名字/).fill('甲野')
  await page.getByRole('button', { name: '加入' }).click()
  await expect(page.getByRole('button', { name: /參與人（1）/ })).toBeVisible({ timeout: 10_000 })
  await page.getByPlaceholder(/同行者名字/).fill('乙川')
  await page.getByRole('button', { name: '加入' }).click()
  await expect(page.getByRole('button', { name: /參與人（2）/ })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /參與人（2）/ }).click() // 收合，避免遮住側欄

  const { data: tripRow } = await admin.from('trips').select('participants').eq('id', createdTripId).single()
  const roster = tripRow!.participants as { id: string; name: string }[]
  expect(roster.map(p => p.name)).toEqual(['甲野', '乙川'])

  // ---- 指派：B 給甲、C 給乙（走 UI 的 ParticipantPicker，驗證整條寫入路徑）----
  // 側欄與 Timeline 都有同名按鈕（Timeline 的帶 data-stop-block）——用結構限定側欄那個，
  // 不用 .first()：DOM 順序不是規格的一部分，改版就會靜默點到另一個
  const sidebarStop = (name: string) => page.locator('li > button', { hasText: name })
  for (const [stopLabel, who] of [['E2E甲的下午', '甲野'], ['E2E乙的下午', '乙川']] as const) {
    await sidebarStop(stopLabel).click()
    await expect(page.getByText('🔒 鎖定時間（航班、訂位等不可順延的行程）')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('checkbox', { name: /全員/ }).uncheck()
    // 取消全員後預設是全部勾選，把「不是這個人」的取消掉
    const other = who === '甲野' ? '乙川' : '甲野'
    await page.getByRole('checkbox', { name: other }).uncheck()
    await page.getByRole('button', { name: '儲存' }).click()
    await expect(page.getByText('已儲存 ✓')).toBeVisible({ timeout: 10_000 })
    await sidebarStop(stopLabel).click() // 收合編輯器
  }

  // 落地確認：兩個停留點各自只有一個人
  await expect.poll(async () => {
    const { data } = await admin!.from('stops').select('name, participant_ids').eq('trip_id', createdTripId!)
    return (data ?? [])
      .filter(s => Array.isArray(s.participant_ids))
      .map(s => `${s.name}:${(s.participant_ids as string[]).length}`)
      .sort()
  }, { timeout: 15_000 }).toEqual(['E2E乙的下午:1', 'E2E甲的下午:1'])

  // ---- 核心斷言：交通段分軌，不存在幻影的「甲的下午→乙的下午」----
  // 期望值依 Array.sort() 的 UTF-16 碼位順序排列，不是語意順序：乙 U+4E59 < 共 U+5171 < 甲 U+7532。
  // 超時給到 90s：sync 是 fire-and-forget，且每個新段都要打一次 Google Routes（實測單次 10-15s），
  // 兩次指派會觸發兩輪 sync。給 30s 會在第四段還沒建好時就紅燈（假陰性）。
  await page.reload()
  await expect.poll(() => legKeys(createdTripId!, admin!, stopName), { timeout: 90_000, intervals: [2000] })
    .toEqual(['乙的下午→共同晚上', '共同早上→乙的下午', '共同早上→甲的下午', '甲的下午→共同晚上'])

  const keys = await legKeys(createdTripId!, admin!, stopName)
  expect(keys).not.toContain('甲的下午→乙的下午')
  expect(keys).not.toContain('乙的下午→甲的下午')

  // ---- 分頭時段時間完全重疊，但不是衝突 ----
  await page.reload()
  await expect(page.getByText(/時間重疊/)).toHaveCount(0)

  // ---- 移除甲野：只指派給他的停留點回到「全員」（null），名冊也一併清掉 ----
  await page.getByRole('button', { name: /參與人（2）/ }).click()
  await expect(page.getByText(/1 個停留點指派了這個人/)).toHaveCount(0) // 尚未按下移除，提示不該先出現
  await page.getByRole('button', { name: '移除' }).first().click()
  await expect(page.getByText(/個停留點指派了這個人/)).toBeVisible()
  await page.getByRole('button', { name: '確認' }).click()

  await expect.poll(async () => {
    const { data } = await admin!.from('stops').select('participant_ids')
      .eq('trip_id', createdTripId!).eq('name', 'E2E甲的下午').single()
    return data?.participant_ids
  }, { timeout: 15_000 }).toBeNull()

  const { data: after } = await admin.from('trips').select('participants').eq('id', createdTripId).single()
  expect((after!.participants as { name: string }[]).map(p => p.name)).toEqual(['乙川'])

  // 甲的下午回到全員後，它重新回到剩下那個人（乙川）的鏈上——A→甲→乙→D 這條單鏈
  void idOf

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
  const testUsers = allUsers.filter(u => u.email?.endsWith('@test.local') && u.email.startsWith('e2e-participants-'))
  for (const u of testUsers) await client.auth.admin.deleteUser(u.id)
})
