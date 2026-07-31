# Travel Planner 地圖與停留點編輯（Plan 2/5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓地圖登場——行程詳情頁（地圖 + 停留點側欄）、地點搜尋加入停留點、地圖標記聯動、停留點編輯刪除；並先清掉 Plan 1 最終審查的遺留項。

**Architecture:** 延續 Plan 1 的模式：Server Component 讀資料（RLS 保護）、Client Component 寫入後 `router.refresh()`（即時共編屬 Plan 5）。地圖用官方 React 函式庫 `@vis.gl/react-google-maps`；時區由座標離線推定（`@photostructure/tz-lookup`，零 API 費用）；新停留點的預設時間邏輯是純函式（TDD）。

**Tech Stack:** @vis.gl/react-google-maps / Places API (New) PlaceAutocompleteElement / @photostructure/tz-lookup / Playwright（E2E 首度引入）

**Spec:** `docs/superpowers/specs/2026-07-30-travel-planner-design.md` §5（互動）、§4（stops 表）
**前置：** `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` 需存在於 `.env.local`（使用者在 GCP 啟用 Maps JavaScript API + Places API (New) 後建立；Task 1-3 不需要它，Task 4 起的手動驗證需要）。地圖元件在無金鑰時顯示占位訊息，不會炸。

**分支：** 開工前 `git checkout -b feat/plan-2-map-stops`（main 已含 Plan 1）。

---

## 檔案結構總覽（新增/修改）

```
src/
├── app/
│   ├── layout.tsx                    # M6/M7：metadata、lang、字型
│   ├── login/page.tsx                # M4：註冊訊息分支
│   ├── trips/
│   │   ├── page.tsx                  # M2/M3：limit/tiebreaker/通用錯誤 + 連到詳情頁 + 登出
│   │   ├── CreateTripForm.tsx        # M1/S2：trim、成功回饋
│   │   ├── SignOutButton.tsx         # S1：登出（新）
│   │   └── [tripId]/
│   │       ├── page.tsx              # 詳情頁 Server Component（新）
│   │       └── TripView.tsx          # 地圖 + 側欄 + 選取狀態（新，Client）
│   │           ├── PlaceSearch.tsx   # 地點搜尋（新）
│   │           └── StopEditor.tsx    # 停留點編輯（新）
│   └── globals.css                   # M7：字型變數
├── lib/domain/
│   ├── slot.ts / slot.test.ts        # nextDefaultSlot 純函式（新，TDD）
│   └── datetime.ts                   # datetime-local ↔ epoch ms 轉換（新）
supabase/migrations/
└── 20260731000000_title_checks.sql   # M1：title/name 長度約束（新）
e2e/
└── smoke.spec.ts                     # 登入→建行程→開詳情頁（新）
playwright.config.ts                  # 新
```

---

### Task 1: 清理批次（UI/文案/樣式，全部來自 Plan 1 最終審查）

**Files:** Modify: `src/app/layout.tsx`、`src/app/globals.css`、`src/app/login/page.tsx`、`src/app/trips/page.tsx`、`src/app/trips/CreateTripForm.tsx`、`README.md`；Create: `src/app/trips/SignOutButton.tsx`

- [ ] **Step 1: 建立分支**

```bash
git checkout -b feat/plan-2-map-stops
```

- [ ] **Step 2: layout.tsx（M6 metadata/lang）** — 只改 metadata 與 `<html>`：

```tsx
export const metadata: Metadata = {
  title: "Travel Planner",
  description: "把行程表變成時間 × 地圖的旅遊規劃工具",
};
```

`<html lang="en">` → `<html lang="zh-Hant">`

- [ ] **Step 3: globals.css（M7 字型）** — 把 `font-family: Arial, Helvetica, sans-serif;` 改為：

```css
font-family: var(--font-geist-sans), "PingFang TC", "Noto Sans TC", sans-serif;
```

- [ ] **Step 4: 深色模式按鈕（M5）** — `login/page.tsx` 與 `CreateTripForm.tsx` 中所有 `bg-black p-2 text-white` 改為 `bg-foreground p-2 text-background`（共 2 處）。

- [ ] **Step 5: 註冊訊息分支（M4）** — `login/page.tsx` 的 `signUp` 函式整段替換：

```tsx
  async function signUp() {
    setBusy(true)
    const supabase = createClient()
    const { data, error } = await supabase.auth.signUp({ email, password })
    setBusy(false)
    if (error) {
      setNotice({ kind: 'error', text: '註冊失敗，請稍後再試' })
      return
    }
    if (data.user && data.user.identities?.length === 0) {
      setNotice({ kind: 'error', text: '這個 Email 已註冊過，請直接登入' })
      return
    }
    if (data.session) {
      router.push('/trips')
      router.refresh()
      return
    }
    setNotice({ kind: 'success', text: '註冊成功，請到信箱點擊確認連結後登入' })
  }
```

同時把 `signIn` 的錯誤文案改為通用：`setNotice({ kind: 'error', text: '登入失敗，請確認 Email 與密碼' })`（M3：不轉發 Supabase 原始訊息）。

- [ ] **Step 6: 登出按鈕（S1）** — Create `src/app/trips/SignOutButton.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function SignOutButton() {
  const router = useRouter()
  async function signOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }
  return (
    <button className="text-sm text-gray-500 underline" onClick={signOut}>
      登出
    </button>
  )
}
```

- [ ] **Step 7: trips/page.tsx（M2/M3 + 登出 + 詳情頁連結）** — 整檔替換：

```tsx
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import CreateTripForm from './CreateTripForm'
import SignOutButton from './SignOutButton'

export default async function TripsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: trips, error } = await supabase
    .from('trips')
    .select('id, title, start_date, end_date, currency')
    .order('start_date', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(100)

  return (
    <main className="mx-auto mt-12 w-[32rem]">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">我的行程</h1>
        <SignOutButton />
      </div>
      <CreateTripForm />
      {error && <p className="mt-4 text-red-600">読取失敗，請重新整理再試</p>}
      <ul className="mt-6 flex flex-col gap-2">
        {(trips ?? []).map(trip => (
          <li key={trip.id}>
            <Link href={`/trips/${trip.id}`} className="block rounded border p-3 hover:bg-gray-50 dark:hover:bg-gray-900">
              <span className="font-medium">{trip.title}</span>
              <span className="ml-2 text-sm text-gray-500">
                {trip.start_date} ~ {trip.end_date}（{trip.currency}）
              </span>
            </Link>
          </li>
        ))}
        {trips?.length === 0 && <li className="text-gray-500">還沒有行程，建立第一個吧</li>}
      </ul>
    </main>
  )
}
```

（注意第 14 行：`.order('created_at')` 需要 select 有這個欄位嗎？——不需要，PostgREST 允許以未選取欄位排序。）

- [ ] **Step 8: CreateTripForm（M1 trim / M3 / S2 成功回饋）** — 修改三處：

1. `createTrip` 開頭：`const trimmed = title.trim()`，驗證與 insert 一律用 `trimmed`；`if (!trimmed || ...)` 
2. insert 錯誤時：`setMessage('建立失敗，請稍後再試')`
3. 成功分支改為：

```tsx
    setTitle('')
    setMessage('已建立 ✓')
    router.refresh()
```

並把訊息渲染改為依內容配色（成功綠、其他紅）：

```tsx
      {message && (
        <p className={`text-sm ${message.startsWith('已建立') ? 'text-green-600' : 'text-red-600'}`}>{message}</p>
      )}
```

- [ ] **Step 9: README 狀態（M8）** — 「## 專案狀態」段落改為：

```markdown
## 專案狀態

- ✅ Plan 1 地基：帳號系統（Email + Google）、資料庫 schema + RLS、行程 CRUD、26 項測試
- 🚧 Plan 2 進行中：地圖與停留點編輯
```

- [ ] **Step 10: 驗證與 Commit**

```bash
npm run lint && npx tsc --noEmit && npm run build && npm test
```

Expected: 全綠（26 tests）。

```bash
git add -A
git commit -m "fix: Plan 1 審查遺留清理（metadata、深色按鈕、註冊訊息、登出、清單排序上限、通用錯誤文案）"
```

---

### Task 2: title/name 長度約束 migration

**Files:** Create: `supabase/migrations/20260731000000_title_checks.sql`

- [ ] **Step 1: 寫 migration**

```sql
begin;

alter table public.trips
  add constraint trips_title_len check (length(btrim(title)) between 1 and 200);
alter table public.stops
  add constraint stops_name_len check (length(btrim(name)) between 1 and 200);

commit;
```

- [ ] **Step 2: 套用到本地 DB（db reset 在此環境故障，直接 psql）**

```bash
docker exec -i supabase_db_traval psql -U postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260731000000_title_checks.sql
docker exec supabase_db_traval psql -U postgres -c \
  "insert into supabase_migrations.schema_migrations (version, name) values ('20260731000000','title_checks');"
```

- [ ] **Step 3: 驗證約束生效（預期被拒絕）**

```bash
docker exec supabase_db_traval psql -U postgres -c \
  "insert into public.trips (title, start_date, end_date, owner_id) values ('   ', '2026-10-01', '2026-10-02', null);" 2>&1 | grep -c "trips_title_len"
```

Expected: `1`（錯誤訊息含約束名）。

- [ ] **Step 4: `npm test` 全綠後 Commit**

```bash
git add supabase/migrations/20260731000000_title_checks.sql
git commit -m "feat: trips/stops 標題長度約束"
```

---

### Task 3: Playwright E2E 基礎與登入冒煙測試

**Files:** Create: `playwright.config.ts`、`e2e/smoke.spec.ts`；Modify: `package.json`（scripts + devDependency）

- [ ] **Step 1: 安裝**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: 設定檔** — Create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
```

`package.json` scripts 加：`"test:e2e": "playwright test"`

- [ ] **Step 3: 冒煙測試** — Create `e2e/smoke.spec.ts`:

```ts
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
})
```

- [ ] **Step 4: 跑測試**

```bash
npx playwright test
```

Expected: 前四個斷言通過；**最後兩行（點進詳情頁）此時會失敗——詳情頁 Task 4 才存在**。這是刻意的紅燈：先確認測試會失敗在正確的地方（404），Task 4 完成後轉綠。若紅燈原因不是詳情頁 404 而是更早的步驟，那是真的 bug，要修。

- [ ] **Step 5: Commit（帶著已知紅燈，於 Task 4 轉綠）**

```bash
git add playwright.config.ts e2e/ package.json package-lock.json
git commit -m "test: Playwright E2E 基礎與註冊建行程冒煙（詳情頁斷言待 Task 4 轉綠）"
```

---

### Task 4: 地圖載入與行程詳情頁骨架

**Files:** Create: `src/app/trips/[tripId]/page.tsx`、`src/app/trips/[tripId]/TripView.tsx`；Modify: `.env.example`

- [ ] **Step 1: 安裝**

```bash
npm install @vis.gl/react-google-maps
```

`.env.example` 加一行：

```
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=<GCP 建立的 Maps 金鑰（限制 referrer 與 API）>
```

- [ ] **Step 2: 詳情頁 Server Component** — Create `src/app/trips/[tripId]/page.tsx`:

```tsx
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import TripView from './TripView'

export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ tripId: string }>
}) {
  const { tripId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: trip } = await supabase
    .from('trips')
    .select('id, title, start_date, end_date, currency')
    .eq('id', tripId)
    .maybeSingle()
  if (!trip) notFound() // RLS 擋掉的非成員也走這裡，不洩漏行程是否存在

  const { data: stops } = await supabase
    .from('stops')
    .select('id, name, lat, lng, place_id, is_custom, timezone, starts_at, ends_at, locked, notes, estimated_cost')
    .eq('trip_id', tripId)
    .order('starts_at', { ascending: true })

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-baseline gap-3 border-b p-3">
        <Link href="/trips" className="text-sm text-gray-500">← 我的行程</Link>
        <h1 className="text-lg font-bold">{trip.title}</h1>
        <span className="text-sm text-gray-500">{trip.start_date} ~ {trip.end_date}</span>
      </header>
      <TripView trip={trip} stops={stops ?? []} />
    </main>
  )
}
```

- [ ] **Step 3: TripView 骨架（地圖 + 側欄，選取狀態放這層）** — Create `src/app/trips/[tripId]/TripView.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { APIProvider, Map } from '@vis.gl/react-google-maps'

export type Trip = {
  id: string
  title: string
  start_date: string
  end_date: string
  currency: string
}

export type Stop = {
  id: string
  name: string
  lat: number
  lng: number
  place_id: string | null
  is_custom: boolean
  timezone: string
  starts_at: string
  ends_at: string
  locked: boolean
  notes: string | null
  estimated_cost: number | null
}

const FALLBACK_CENTER = { lat: 25.034, lng: 121.5645 } // 台北 101，行程還沒有停留點時的預設視野

export default function TripView({ trip, stops }: { trip: Trip; stops: Stop[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const center = stops.length > 0 ? { lat: stops[0].lat, lng: stops[0].lng } : FALLBACK_CENTER

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-80 shrink-0 overflow-y-auto border-r p-3">
        <ul className="flex flex-col gap-2">
          {stops.map(stop => (
            <li
              key={stop.id}
              onClick={() => setSelectedId(stop.id)}
              className={`cursor-pointer rounded border p-2 ${selectedId === stop.id ? 'border-blue-500' : ''}`}
            >
              <span className="font-medium">{stop.name}</span>
            </li>
          ))}
          {stops.length === 0 && <li className="text-sm text-gray-500">還沒有停留點，用上方搜尋加入第一個景點</li>}
        </ul>
      </aside>
      <div className="min-h-0 flex-1">
        {apiKey ? (
          <APIProvider apiKey={apiKey}>
            <Map
              defaultCenter={center}
              defaultZoom={12}
              mapId="DEMO_MAP_ID"
              gestureHandling="greedy"
              disableDefaultUI={false}
            />
          </APIProvider>
        ) : (
          <div className="flex h-full items-center justify-center text-gray-500">
            尚未設定 NEXT_PUBLIC_GOOGLE_MAPS_API_KEY，地圖無法顯示
          </div>
        )}
      </div>
    </div>
  )
}
```

（`mapId="DEMO_MAP_ID"` 是 Google 提供的開發用 ID，AdvancedMarker 需要它；部署前換成正式 Map ID——記入 README。）

- [ ] **Step 4: 驗證** — `npx tsc --noEmit`、`npm run build` 乾淨；`npx playwright test` **全綠**（Task 3 的紅燈在此轉綠）。有金鑰的話 `npm run dev` 手動確認地圖渲染；沒有金鑰則確認占位訊息顯示。

- [ ] **Step 5: Commit**

```bash
git add src/app/trips/ .env.example package.json package-lock.json
git commit -m "feat: 行程詳情頁骨架（地圖 + 停留點側欄）"
```

---

### Task 5: nextDefaultSlot 純函式（TDD）

**Files:** Create: `src/lib/domain/slot.ts`、`src/lib/domain/slot.test.ts`

- [ ] **Step 1: 失敗測試** — Create `src/lib/domain/slot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { nextDefaultSlot } from './slot'
import type { StopSchedule } from './types'

const HOUR = 60 * 60 * 1000
const HALF_HOUR = 30 * 60 * 1000

function stop(id: string, startMs: number, endMs: number): StopSchedule {
  return { id, startsAt: startMs, endsAt: endMs, locked: false }
}

describe('nextDefaultSlot', () => {
  it('沒有停留點時從 fallback 開始，停留一小時', () => {
    const t0 = 1_000_000
    expect(nextDefaultSlot([], t0)).toEqual({ startsAt: t0, endsAt: t0 + HOUR })
  })

  it('已有停留點時接在最晚結束時間後 30 分鐘', () => {
    const stops = [stop('a', 0, 2 * HOUR), stop('b', 3 * HOUR, 4 * HOUR)]
    expect(nextDefaultSlot(stops, 0)).toEqual({
      startsAt: 4 * HOUR + HALF_HOUR,
      endsAt: 4 * HOUR + HALF_HOUR + HOUR,
    })
  })

  it('不受輸入順序影響（取全域最晚 endsAt）', () => {
    const stops = [stop('b', 3 * HOUR, 6 * HOUR), stop('a', 0, 2 * HOUR)]
    expect(nextDefaultSlot(stops, 0).startsAt).toBe(6 * HOUR + HALF_HOUR)
  })
})
```

- [ ] **Step 2: 跑紅** — `npx vitest run src/lib/domain/slot.test.ts` → FAIL（Cannot find module './slot'）

- [ ] **Step 3: 實作** — Create `src/lib/domain/slot.ts`:

```ts
import type { StopSchedule } from './types'

const HOUR_MS = 60 * 60 * 1000
const GAP_MS = 30 * 60 * 1000

/** 新停留點的預設時段：接在最晚結束的停留點後 30 分鐘、停留 1 小時；空行程從 fallback 開始。 */
export function nextDefaultSlot(
  stops: StopSchedule[],
  fallbackStartMs: number,
): { startsAt: number; endsAt: number } {
  if (stops.length === 0) {
    return { startsAt: fallbackStartMs, endsAt: fallbackStartMs + HOUR_MS }
  }
  const lastEnd = Math.max(...stops.map(s => s.endsAt))
  return { startsAt: lastEnd + GAP_MS, endsAt: lastEnd + GAP_MS + HOUR_MS }
}
```

- [ ] **Step 4: 跑綠 + 全套（29 tests）+ Commit**

```bash
npx vitest run src/lib/domain/slot.test.ts && npm test
git add src/lib/domain/slot.ts src/lib/domain/slot.test.ts
git commit -m "feat: nextDefaultSlot 新停留點預設時段"
```

---

### Task 6: 地點搜尋 → 加入停留點

**Files:** Create: `src/app/trips/[tripId]/PlaceSearch.tsx`、`src/lib/domain/datetime.ts`；Modify: `TripView.tsx`（掛入搜尋框）

- [ ] **Step 1: 安裝時區推定**

```bash
npm install @photostructure/tz-lookup
```

- [ ] **Step 2: datetime 轉換工具** — Create `src/lib/domain/datetime.ts`:

```ts
/** epoch ms → datetime-local input 值（瀏覽器時區）。Plan 3 引入停留點時區顯示後再精算。 */
export function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local input 值 → epoch ms（瀏覽器時區解讀） */
export function fromDatetimeLocalValue(value: string): number {
  return new Date(value).getTime()
}
```

- [ ] **Step 3: PlaceSearch 元件** — Create `src/app/trips/[tripId]/PlaceSearch.tsx`：

使用 Places API (New) 的 `PlaceAutocompleteElement`（新專案無法用舊版 Autocomplete widget）。**實作前先以官方文件核對事件與欄位名**：https://developers.google.com/maps/documentation/javascript/place-autocomplete-new （事件名 `gmp-select`、`placePrediction.toPlace()`、`fetchFields`）。以下為依官方文件撰寫的完整程式碼，若執行時事件未觸發，以文件為準修正事件名並回報：

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { useMapsLibrary } from '@vis.gl/react-google-maps'

type PlacePick = {
  name: string
  lat: number
  lng: number
  placeId: string
}

export default function PlaceSearch({ onPick }: { onPick: (p: PlacePick) => void }) {
  const places = useMapsLibrary('places')
  const containerRef = useRef<HTMLDivElement>(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  useEffect(() => {
    if (!places || !containerRef.current) return
    const container = containerRef.current
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = new (places as any).PlaceAutocompleteElement()
    el.style.width = '100%'
    container.appendChild(el)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = async (event: any) => {
      const place = event.placePrediction.toPlace()
      await place.fetchFields({ fields: ['displayName', 'location', 'id'] })
      if (!place.location) return
      onPickRef.current({
        name: place.displayName ?? '未命名地點',
        lat: place.location.lat(),
        lng: place.location.lng(),
        placeId: place.id,
      })
    }
    el.addEventListener('gmp-select', handler)
    return () => {
      el.removeEventListener('gmp-select', handler)
      container.removeChild(el)
    }
  }, [places])

  return <div ref={containerRef} className="p-2" />
}
```

- [ ] **Step 4: TripView 接上搜尋與寫入** — 修改 `TripView.tsx`：

1. imports 加：

```tsx
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { nextDefaultSlot } from '@/lib/domain/slot'
import PlaceSearch from './PlaceSearch'
import tzlookup from '@photostructure/tz-lookup'
```

2. 元件內加 `const router = useRouter()`，以及新增停留點的函式：

```tsx
  async function addStop(p: { name: string; lat: number; lng: number; placeId: string | null; isCustom: boolean }) {
    const schedule = stops.map(s => ({
      id: s.id,
      startsAt: new Date(s.starts_at).getTime(),
      endsAt: new Date(s.ends_at).getTime(),
      locked: s.locked,
    }))
    // 空行程的預設開場：出發日早上九點（瀏覽器時區推定，Plan 3 隨時間軸精算為當地時區）
    const fallback = new Date(`${trip.start_date}T09:00:00`).getTime()
    const slot = nextDefaultSlot(schedule, fallback)

    let timezone = 'UTC'
    try {
      timezone = tzlookup(p.lat, p.lng)
    } catch {
      // 海上或極端座標查不到時區時保持 UTC
    }

    const supabase = createClient()
    const { error } = await supabase.from('stops').insert({
      trip_id: trip.id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      place_id: p.placeId,
      is_custom: p.isCustom,
      timezone,
      starts_at: new Date(slot.startsAt).toISOString(),
      ends_at: new Date(slot.endsAt).toISOString(),
    })
    if (error) {
      setErrorMsg('加入停留點失敗，請稍後再試')
      return
    }
    setErrorMsg('')
    router.refresh()
  }
```

（TripView 需先加狀態 `const [errorMsg, setErrorMsg] = useState('')`。禁用 alert/confirm——會卡死瀏覽器自動化。）

3. 側欄頂部（`<ul>` 之前）掛入：

```tsx
        {apiKey && (
          <PlaceSearch onPick={p => addStop({ ...p, isCustom: false })} />
        )}
        {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}
```

- [ ] **Step 5: 驗證** — `tsc`/`build`/`npm test` 全綠；有金鑰時手動：搜尋「淺草寺」→ 選取 → 側欄出現、重新整理仍在（DB 落地），Studio 可見該列 `timezone = Asia/Tokyo`。

- [ ] **Step 6: Commit**

```bash
git add src/app/trips/ src/lib/domain/datetime.ts package.json package-lock.json
git commit -m "feat: 地點搜尋加入停留點（Places New + 離線時區推定 + 預設時段）"
```

---

### Task 7: 地圖標記聯動與右鍵自訂停留點

**Files:** Modify: `src/app/trips/[tripId]/TripView.tsx`

- [ ] **Step 1: 標記與聯動** — `Map` 元件內渲染標記（import 加 `AdvancedMarker, Pin`）：

```tsx
              {stops.map((stop, i) => (
                <AdvancedMarker
                  key={stop.id}
                  position={{ lat: stop.lat, lng: stop.lng }}
                  onClick={() => setSelectedId(stop.id)}
                >
                  <Pin
                    background={selectedId === stop.id ? '#2563eb' : '#ef4444'}
                    glyphColor="#fff"
                    borderColor="#fff"
                  >
                    <span className="text-xs font-bold">{i + 1}</span>
                  </Pin>
                </AdvancedMarker>
              ))}
```

側欄項目補上編號徽章（與地圖一致）：`<span className="mr-1 text-xs text-gray-400">{i + 1}.</span>`（map callback 改為 `(stop, i)`）。

- [ ] **Step 2: 右鍵加自訂停留點** — TripView 加狀態 `const [draftPin, setDraftPin] = useState<{ lat: number; lng: number } | null>(null)` 與 `const [draftName, setDraftName] = useState('')`。

`Map` 加事件（@vis.gl/react-google-maps 的 map 事件 prop）：

```tsx
              onContextmenu={e => {
                const latLng = e.detail.latLng
                if (latLng) setDraftPin({ lat: latLng.lat, lng: latLng.lng })
              }}
```

draftPin 存在時在地圖上顯示灰色標記：

```tsx
              {draftPin && (
                <AdvancedMarker position={draftPin}>
                  <Pin background="#9ca3af" glyphColor="#fff" borderColor="#fff" />
                </AdvancedMarker>
              )}
```

側欄頂部（搜尋框之後）渲染確認表單：

```tsx
        {draftPin && (
          <form
            className="flex gap-1 rounded border p-2"
            onSubmit={async e => {
              e.preventDefault()
              const name = draftName.trim()
              if (!name) return
              await addStop({ name, lat: draftPin.lat, lng: draftPin.lng, placeId: null, isCustom: true })
              setDraftPin(null)
              setDraftName('')
            }}
          >
            <input
              className="min-w-0 flex-1 rounded border p-1 text-sm"
              placeholder="自訂地點名稱"
              value={draftName}
              onChange={e => setDraftName(e.target.value)}
              autoFocus
            />
            <button className="rounded bg-foreground px-2 text-sm text-background" type="submit">加入</button>
            <button className="rounded border px-2 text-sm" type="button" onClick={() => setDraftPin(null)}>取消</button>
          </form>
        )}
```

- [ ] **Step 3: 驗證** — `tsc`/`build`/`npm test` 綠；有金鑰手動：點標記 ↔ 側欄高亮同步；右鍵地圖 → 灰標記 + 表單 → 命名加入 → 變正式標記，Studio 中 `is_custom = true`。

- [ ] **Step 4: Commit**

```bash
git add src/app/trips/
git commit -m "feat: 地圖標記聯動與右鍵自訂停留點"
```

---

### Task 8: 停留點編輯與刪除

**Files:** Create: `src/app/trips/[tripId]/StopEditor.tsx`；Modify: `TripView.tsx`（選取的停留點顯示編輯器）

- [ ] **Step 1: StopEditor** — Create `src/app/trips/[tripId]/StopEditor.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '@/lib/domain/datetime'
import type { Stop } from './TripView'

export default function StopEditor({ stop, currency }: { stop: Stop; currency: string }) {
  const router = useRouter()
  const [name, setName] = useState(stop.name)
  const [startsAt, setStartsAt] = useState(toDatetimeLocalValue(new Date(stop.starts_at).getTime()))
  const [endsAt, setEndsAt] = useState(toDatetimeLocalValue(new Date(stop.ends_at).getTime()))
  const [notes, setNotes] = useState(stop.notes ?? '')
  const [cost, setCost] = useState(stop.estimated_cost?.toString() ?? '')
  const [locked, setLocked] = useState(stop.locked)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [msg, setMsg] = useState('')

  async function save() {
    const trimmed = name.trim()
    const startMs = fromDatetimeLocalValue(startsAt)
    const endMs = fromDatetimeLocalValue(endsAt)
    if (!trimmed) return setMsg('名稱不能為空')
    if (!(endMs > startMs)) return setMsg('結束時間必須晚於開始時間')
    const supabase = createClient()
    const { error } = await supabase
      .from('stops')
      .update({
        name: trimmed,
        starts_at: new Date(startMs).toISOString(),
        ends_at: new Date(endMs).toISOString(),
        notes: notes.trim() || null,
        estimated_cost: cost === '' ? null : Number(cost),
        locked,
      })
      .eq('id', stop.id)
    if (error) return setMsg('儲存失敗，請稍後再試')
    setMsg('已儲存 ✓')
    router.refresh()
  }

  async function remove() {
    const supabase = createClient()
    const { error } = await supabase.from('stops').delete().eq('id', stop.id)
    if (error) return setMsg('刪除失敗，請稍後再試')
    router.refresh()
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded border p-2 text-sm">
      <input className="rounded border p-1" value={name} onChange={e => setName(e.target.value)} />
      <label className="flex flex-col gap-1">
        開始
        <input className="rounded border p-1" type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        結束
        <input className="rounded border p-1" type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} />
      </label>
      <textarea className="rounded border p-1" placeholder="備註" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
      <input
        className="rounded border p-1"
        type="number"
        min="0"
        step="0.01"
        placeholder={`預估花費（${currency}，可留空）`}
        value={cost}
        onChange={e => setCost(e.target.value)}
      />
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)} />
        🔒 鎖定時間（航班、訂位等不可順延的行程）
      </label>
      <div className="flex gap-2">
        <button className="flex-1 rounded bg-foreground p-1 text-background" onClick={save}>儲存</button>
        {confirmDelete ? (
          <>
            <button className="rounded bg-red-600 px-2 text-white" onClick={remove}>確認刪除</button>
            <button className="rounded border px-2" onClick={() => setConfirmDelete(false)}>取消</button>
          </>
        ) : (
          <button className="rounded border px-2 text-red-600" onClick={() => setConfirmDelete(true)}>刪除</button>
        )}
      </div>
      {msg && <p className={msg.startsWith('已儲存') ? 'text-green-600' : 'text-red-600'}>{msg}</p>}
    </div>
  )
}
```

- [ ] **Step 2: TripView 掛入** — 側欄 `<li>` 內，`selectedId === stop.id` 時渲染 `<StopEditor key={stop.id} stop={stop} currency={trip.currency} />`（key 用 stop.id 讓切換選取時表單狀態重置；`onClick` 移到名稱那行避免點表單觸發收合——名稱行包一層 `<div onClick={() => setSelectedId(selectedId === stop.id ? null : stop.id)}>`）。

- [ ] **Step 3: 驗證** — `tsc`/`build`/`npm test` 綠；手動：改名/改時間/加備註/花費 → 儲存 → 重新整理仍在；locked 勾選後 Studio 中該列 `locked = true`；刪除兩段式確認正常。

- [ ] **Step 4: Commit**

```bash
git add src/app/trips/
git commit -m "feat: 停留點編輯與刪除"
```

---

### Task 9: E2E 補詳情頁空狀態斷言

**Files:** Modify: `e2e/smoke.spec.ts`

- [ ] **Step 1:** 測試最後追加兩個斷言（開詳情頁後）：

```ts
  await expect(page.getByText('還沒有停留點')).toBeVisible()
  // 無金鑰環境顯示占位訊息；有金鑰環境顯示地圖——兩者擇一存在即可
  const placeholder = page.getByText(/尚未設定 NEXT_PUBLIC_GOOGLE_MAPS_API_KEY/)
  const mapCanvas = page.locator('div[aria-label="地圖"], div[role="region"]').first()
  await expect(placeholder.or(mapCanvas)).toBeVisible({ timeout: 10_000 })
```

（地圖互動不進 E2E——Google Maps canvas 的自動化脆弱且消耗配額，互動部分維持手動驗證。）

- [ ] **Step 2:** `npx playwright test` 全綠 → Commit

```bash
git add e2e/
git commit -m "test: E2E 補詳情頁空狀態斷言"
```

---

### Task 10: 收尾

**Files:** Modify: `README.md`

- [ ] **Step 1:** README「核心功能」下補一段目前進度、開發段補 `npm run test:e2e` 與 Maps 金鑰需求說明（`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`、GCP 需啟用 Maps JavaScript API + Places API (New)、`mapId` 部署前需換正式值）。

- [ ] **Step 2:** 全量驗證：

```bash
npm run lint && npx tsc --noEmit && npm run build && npm test && npx playwright test
```

Expected: lint/tsc/build 乾淨、vitest 29、E2E 綠。

- [ ] **Step 3:** Commit + push 分支：

```bash
git add README.md
git commit -m "docs: Plan 2 開發指引與地圖金鑰需求"
git push -u origin feat/plan-2-map-stops
```

---

## 完成定義（Definition of Done）

- [ ] lint / tsc / build 全乾淨
- [ ] `npm test` 29 綠（26 + slot 3）；`npx playwright test` 綠
- [ ] 手動流程（需金鑰）：開行程 → 搜尋景點加入 → 標記出現且與側欄聯動 → 右鍵加自訂點 → 編輯時間/備註/花費/鎖定 → 刪除 → 重新整理資料仍正確
- [ ] 無金鑰時詳情頁不炸（占位訊息）
- [ ] 全部 commit 推上 feat/plan-2-map-stops
