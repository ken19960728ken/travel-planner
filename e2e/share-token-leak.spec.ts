import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// 護欄（比照 share.spec.ts 既有模式）：只允許對本地 Supabase 執行，避免 .env.test.local 誤指到雲端
const sbUrlGuard = process.env.SUPABASE_URL
if (sbUrlGuard && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(sbUrlGuard)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行 E2E 測試（防止誤打正式環境）')
}

// C-1 修復（邊界換票）的核心迴歸測試：本檔專屬 e2e-share-leak- 前綴（僅用於行程標題辨識，不建帳號），
// afterAll 清理只刪這裡建立的行程，不會跟其他 e2e 檔案互相誤刪。
let createdTripId: string | undefined
let admin: SupabaseClient | undefined

test('C-1 迴歸：開啟分享連結後，網址與所有送往 Google Maps 的請求都不含 token', async ({ browser }) => {
  const sbUrl = process.env.SUPABASE_URL
  const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!sbUrl || !sbService, '需要本地 Supabase service role key（直接建行程取得 share_token）')

  admin = createClient(sbUrl!, sbService!, { auth: { persistSession: false } })
  // service_role 直接寫入：owner_id 交給欄位預設，auth.uid() 在 service_role context 下為
  // null，handle_new_trip trigger 對此有明確處理（見 migration 20260730000000 註解「service_role
  // 的系統寫入」）。這個測試只驗證 anon 開分享連結時 URL／網路請求層級不外洩 token，跟 owner 是誰無關，
  // 不需要真的走一次登入流程。
  const { data: trip, error: tripErr } = await admin
    .from('trips')
    .insert({ title: 'e2e-share-leak- 迴歸測試行程', start_date: '2026-12-01', end_date: '2026-12-01', currency: 'JPY' })
    .select('id, share_token')
    .single()
  expect(tripErr).toBeNull()
  createdTripId = trip!.id
  const shareToken = trip!.share_token as string

  const { error: stopErr } = await admin.from('stops').insert({
    trip_id: createdTripId, name: 'C-1 測試景點', lat: 35.0, lng: 135.0, timezone: 'Asia/Tokyo',
    starts_at: '2026-12-01T09:00:00Z', ends_at: '2026-12-01T10:00:00Z',
  })
  expect(stopErr).toBeNull()

  const context = await browser.newContext()
  const page = await context.newPage()

  // 攔截所有送往 maps.googleapis.com 的請求（含 Maps JS 內部的 $rpc 呼叫，例如審查實測踩到的
  // GetViewportInfo）：斷言 URL 與 postData 都不含 token 字串——這是本次修復要證明的核心事實，
  // 不是「頁面看起來正常」這種間接證據。
  const mapsRequests: { url: string; postData: string | null }[] = []
  page.on('request', req => {
    if (req.url().includes('maps.googleapis.com')) {
      mapsRequests.push({ url: req.url(), postData: req.postData() })
    }
  })

  await page.goto(`/share/${shareToken}`)
  // 舊連結轉址後應落在 /share/view，網址列從此不再帶 token（C-1 修復的直接可觀察結果）
  await expect(page).toHaveURL(/\/share\/view$/, { timeout: 10_000 })
  await expect(page.getByText('e2e-share-leak- 迴歸測試行程')).toBeVisible({ timeout: 10_000 })

  // 給地圖腳本足夠時間完成載入與內部呼叫（GetViewportInfo 等 $rpc 請求發生在腳本載入後）
  await page.waitForTimeout(5_000)

  expect(page.url()).not.toContain(shareToken)
  // 反面防呆：若地圖金鑰失效導致完全沒有送出請求，下面「逐筆不含 token」的斷言會是假陽性（空陣列必過）
  expect(mapsRequests.length).toBeGreaterThan(0)
  for (const r of mapsRequests) {
    expect(r.url).not.toContain(shareToken)
    if (r.postData) expect(r.postData).not.toContain(shareToken)
  }

  await context.close()
})

test.afterAll(async () => {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  const client = admin ?? createClient(url, serviceKey, { auth: { persistSession: false } })
  if (createdTripId) await client.from('trips').delete().eq('id', createdTripId)
})
