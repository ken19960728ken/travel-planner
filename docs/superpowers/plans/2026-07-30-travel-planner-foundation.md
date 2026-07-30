# Travel Planner 地基（Plan 1/5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可部署、可測試的產品地基——Next.js 骨架、Supabase schema 與 RLS、行程領域核心純函式（TDD）、登入與行程清單頁。

**Architecture:** Next.js（App Router, TypeScript）+ Supabase（Postgres/Auth/RLS）。核心排程邏輯（時間連鎖順延、衝突偵測、快取鍵、花費加總）全部寫成無副作用純函式放在 `src/lib/domain/`，與框架完全解耦。資料庫權限由 RLS 在資料庫層強制，並以整合測試驗證。

**Tech Stack:** Next.js 15+ / React / TypeScript / Tailwind CSS / Vitest / Supabase CLI（本地開發）/ @supabase/ssr + @supabase/supabase-js

**Spec:** `docs/superpowers/specs/2026-07-30-travel-planner-design.md`

**後續計畫路線圖**（本計畫不實作）：Plan 2 地圖與停留點編輯 → Plan 3 時間軸 UI → Plan 4 交通計算與快取 → Plan 5 共編、分享與快照。

**前置條件**：macOS、已安裝 nvm 與 Docker Desktop（Supabase 本地開發需要，執行前請先啟動 Docker）。

---

## 檔案結構總覽

```
travel-planner/
├── src/
│   ├── lib/
│   │   ├── domain/            # 純函式核心，TDD 主戰場，不碰網路與資料庫
│   │   │   ├── types.ts       # StopSchedule / LegDuration / ScheduleWarning
│   │   │   ├── schedule.ts    # cascadeShift 時間連鎖順延
│   │   │   ├── conflicts.ts   # detectConflicts 重疊與趕不上偵測
│   │   │   ├── cacheKey.ts    # buildRouteCacheKey 路線快取鍵
│   │   │   └── cost.ts        # totalEstimatedCost / perPersonCost
│   │   └── supabase/
│   │       ├── client.ts      # 瀏覽器端 client
│   │       ├── server.ts      # Server Component / Route Handler 用 client
│   │       └── rls.test.ts    # RLS 整合測試（需本地 Supabase）
│   ├── app/
│   │   ├── page.tsx           # 導向 /trips
│   │   ├── login/page.tsx     # 登入/註冊
│   │   ├── auth/callback/route.ts  # OAuth 回呼
│   │   └── trips/
│   │       ├── page.tsx       # 行程清單（Server Component）
│   │       └── CreateTripForm.tsx  # 建立行程表單（Client Component）
│   └── middleware.ts          # Supabase session 刷新
├── supabase/
│   └── migrations/
│       └── 20260730000000_init.sql  # 全部七張表 + RLS + triggers
└── vitest.config.ts
```

---

### Task 1: Node 環境與 Next.js 骨架

**Files:**
- Create: Next.js 專案骨架（`package.json`、`src/app/*`、`tsconfig.json` 等）
- Create: `vitest.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: 確認工作目錄與 Node 環境**

```bash
pwd   # 必須是 travel-planner 專案根目錄（本地資料夾名可能仍是 traval）
nvm install --lts && nvm use --lts
node --version   # 預期 v22+
```

- [ ] **Step 2: 產生 Next.js 骨架（經暫存目錄，避開非空目錄限制）**

create-next-app 拒絕在含衝突檔案（README.md）的目錄執行，所以先建到暫存資料夾再搬回：

```bash
npx create-next-app@latest .tmp-scaffold --typescript --app --src-dir --tailwind --eslint --import-alias "@/*" --use-npm --yes
rsync -a --exclude README.md .tmp-scaffold/ .
rm -rf .tmp-scaffold
npm install
```

注意：rsync 會用 Next.js 的 `.gitignore` 覆蓋原有檔案（內含 `node_modules/`、`.next/`、`.env*`），需補回自訂項目：

```bash
printf '\n.DS_Store\n.env.test.local\n' >> .gitignore
```

- [ ] **Step 3: 驗證骨架可啟動**

```bash
npm run dev
```

Expected: 瀏覽器開 http://localhost:3000 看到 Next.js 預設頁。確認後 Ctrl+C 停止。

- [ ] **Step 4: 安裝並設定 Vitest**

```bash
npm install -D vitest
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

在 `package.json` 的 `scripts` 加入：

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: 跑一次測試確認設定正確**

```bash
npm test
```

Expected: `No test files found`（exit code 非 0 沒關係，這一步只確認 vitest 能啟動；下一個 Task 就會有測試檔）

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: Next.js 骨架與 Vitest 測試環境"
```

---

### Task 2: 領域型別與 cascadeShift（時間連鎖順延）

spec 依據：§5「時間連鎖」——插入或延長時後續行程預設自動順延，鎖定點（🔒）不動。純函式、不可變（回傳新陣列，絕不改動輸入）。

**Files:**
- Create: `src/lib/domain/types.ts`
- Create: `src/lib/domain/schedule.ts`
- Test: `src/lib/domain/schedule.test.ts`

- [ ] **Step 1: 建立領域型別**

Create `src/lib/domain/types.ts`:

```ts
/** 排程計算用的停留點視圖（時間一律為 epoch ms UTC） */
export type StopSchedule = {
  id: string
  startsAt: number
  endsAt: number
  locked: boolean
}

/** 排程計算用的交通段視圖 */
export type LegDuration = {
  fromStopId: string
  toStopId: string
  durationMinutes: number
}

export type ScheduleWarning =
  | { type: 'overlap'; stopIds: [string, string] }
  | {
      type: 'transit_too_tight'
      fromStopId: string
      toStopId: string
      gapMinutes: number
      requiredMinutes: number
    }
```

- [ ] **Step 2: 寫失敗測試**

Create `src/lib/domain/schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { cascadeShift } from './schedule'
import type { StopSchedule } from './types'

const HOUR = 60 * 60 * 1000

function stop(id: string, startHour: number, endHour: number, locked = false): StopSchedule {
  return { id, startsAt: startHour * HOUR, endsAt: endHour * HOUR, locked }
}

describe('cascadeShift', () => {
  it('把被改動停留點之後的所有停留點順延 delta', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12), stop('c', 13, 14)]
    const result = cascadeShift(stops, 'a', HOUR)
    expect(result.find(s => s.id === 'b')!.startsAt).toBe(12 * HOUR)
    expect(result.find(s => s.id === 'c')!.startsAt).toBe(14 * HOUR)
  })

  it('被改動的停留點本身與更早的停留點不動', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12), stop('c', 13, 14)]
    const result = cascadeShift(stops, 'b', HOUR)
    expect(result.find(s => s.id === 'a')!.startsAt).toBe(9 * HOUR)
    expect(result.find(s => s.id === 'b')!.startsAt).toBe(11 * HOUR)
    expect(result.find(s => s.id === 'c')!.startsAt).toBe(14 * HOUR)
  })

  it('鎖定的停留點不順延', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12, true), stop('c', 13, 14)]
    const result = cascadeShift(stops, 'a', HOUR)
    expect(result.find(s => s.id === 'b')!.startsAt).toBe(11 * HOUR)
    expect(result.find(s => s.id === 'c')!.startsAt).toBe(14 * HOUR)
  })

  it('delta 為 0 或找不到 id 時回傳排序後的原內容', () => {
    const stops = [stop('b', 11, 12), stop('a', 9, 10)]
    expect(cascadeShift(stops, 'a', 0).map(s => s.id)).toEqual(['a', 'b'])
    expect(cascadeShift(stops, 'missing', HOUR).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('不改動輸入陣列（不可變）', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12)]
    cascadeShift(stops, 'a', HOUR)
    expect(stops[1].startsAt).toBe(11 * HOUR)
  })
})
```

- [ ] **Step 3: 執行測試確認失敗**

```bash
npx vitest run src/lib/domain/schedule.test.ts
```

Expected: FAIL — `Cannot find module './schedule'`（或同義錯誤）

- [ ] **Step 4: 最小實作**

Create `src/lib/domain/schedule.ts`:

```ts
import type { StopSchedule } from './types'

/**
 * 時間連鎖順延：changedStopId 之後（按開始時間排序）的未鎖定停留點整體平移 deltaMs。
 * 回傳新陣列（按 startsAt 排序），不改動輸入。
 */
export function cascadeShift(
  stops: StopSchedule[],
  changedStopId: string,
  deltaMs: number,
): StopSchedule[] {
  const sorted = [...stops].sort((a, b) => a.startsAt - b.startsAt)
  const idx = sorted.findIndex(s => s.id === changedStopId)
  if (idx === -1 || deltaMs === 0) return sorted
  return sorted.map((s, i) => {
    if (i <= idx || s.locked) return s
    return { ...s, startsAt: s.startsAt + deltaMs, endsAt: s.endsAt + deltaMs }
  })
}
```

- [ ] **Step 5: 執行測試確認通過**

```bash
npx vitest run src/lib/domain/schedule.test.ts
```

Expected: PASS（5 tests）

- [ ] **Step 6: Commit**

```bash
git add src/lib/domain/types.ts src/lib/domain/schedule.ts src/lib/domain/schedule.test.ts
git commit -m "feat: cascadeShift 時間連鎖順延純函式"
```

---

### Task 3: detectConflicts（重疊與趕不上偵測）

spec 依據：§5「警示但不阻擋」——時間重疊、空檔小於交通時間時亮警示。此函式只產生警示資料，UI 呈現屬 Plan 3。

**Files:**
- Create: `src/lib/domain/conflicts.ts`
- Test: `src/lib/domain/conflicts.test.ts`

- [ ] **Step 1: 寫失敗測試**

Create `src/lib/domain/conflicts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { detectConflicts } from './conflicts'
import type { StopSchedule, LegDuration } from './types'

const HOUR = 60 * 60 * 1000

function stop(id: string, startHour: number, endHour: number): StopSchedule {
  return { id, startsAt: startHour * HOUR, endsAt: endHour * HOUR, locked: false }
}

describe('detectConflicts', () => {
  it('偵測時間重疊', () => {
    const stops = [stop('a', 9, 11), stop('b', 10, 12)]
    const warnings = detectConflicts(stops, [])
    expect(warnings).toEqual([{ type: 'overlap', stopIds: ['a', 'b'] }])
  })

  it('偵測空檔小於交通時間（趕不上）', () => {
    const stops = [stop('a', 9, 10), stop('b', 10.5, 12)] // 空檔 30 分
    const legs: LegDuration[] = [{ fromStopId: 'a', toStopId: 'b', durationMinutes: 45 }]
    const warnings = detectConflicts(stops, legs)
    expect(warnings).toEqual([
      {
        type: 'transit_too_tight',
        fromStopId: 'a',
        toStopId: 'b',
        gapMinutes: 30,
        requiredMinutes: 45,
      },
    ])
  })

  it('空檔足夠且無重疊時回傳空陣列', () => {
    const stops = [stop('a', 9, 10), stop('b', 11, 12)]
    const legs: LegDuration[] = [{ fromStopId: 'a', toStopId: 'b', durationMinutes: 45 }]
    expect(detectConflicts(stops, legs)).toEqual([])
  })

  it('沒有對應交通段的相鄰停留點只檢查重疊', () => {
    const stops = [stop('a', 9, 10), stop('b', 10.25, 12)]
    expect(detectConflicts(stops, [])).toEqual([])
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
npx vitest run src/lib/domain/conflicts.test.ts
```

Expected: FAIL — `Cannot find module './conflicts'`

- [ ] **Step 3: 最小實作**

Create `src/lib/domain/conflicts.ts`:

```ts
import type { StopSchedule, LegDuration, ScheduleWarning } from './types'

const MINUTE_MS = 60 * 1000

/** 對按時間排序後的相鄰停留點檢查：重疊、空檔小於交通所需時間。 */
export function detectConflicts(
  stops: StopSchedule[],
  legs: LegDuration[],
): ScheduleWarning[] {
  const sorted = [...stops].sort((a, b) => a.startsAt - b.startsAt)
  const warnings: ScheduleWarning[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]
    const next = sorted[i + 1]
    if (next.startsAt < cur.endsAt) {
      warnings.push({ type: 'overlap', stopIds: [cur.id, next.id] })
    }
    const leg = legs.find(l => l.fromStopId === cur.id && l.toStopId === next.id)
    if (leg) {
      const gapMinutes = (next.startsAt - cur.endsAt) / MINUTE_MS
      if (gapMinutes < leg.durationMinutes) {
        warnings.push({
          type: 'transit_too_tight',
          fromStopId: cur.id,
          toStopId: next.id,
          gapMinutes,
          requiredMinutes: leg.durationMinutes,
        })
      }
    }
  }
  return warnings
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
npx vitest run src/lib/domain/conflicts.test.ts
```

Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/conflicts.ts src/lib/domain/conflicts.test.ts
git commit -m "feat: detectConflicts 重疊與趕不上偵測"
```

---

### Task 4: buildRouteCacheKey（路線快取鍵）

spec 依據：§6 快取鍵＝起訖座標＋交通方式＋出發時段（30 分鐘桶）。座標取 4 位小數（約 11 公尺精度，同一景點不同入口能命中同一鍵）。

**Files:**
- Create: `src/lib/domain/cacheKey.ts`
- Test: `src/lib/domain/cacheKey.test.ts`

- [ ] **Step 1: 寫失敗測試**

Create `src/lib/domain/cacheKey.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRouteCacheKey } from './cacheKey'

const BASE = {
  fromLat: 35.71478,
  fromLng: 139.79665,
  toLat: 35.71006,
  toLng: 139.8107,
  mode: 'transit' as const,
  departureMs: Date.UTC(2026, 9, 1, 9, 10), // 09:10 → 落在 09:00 的 30 分桶
}

describe('buildRouteCacheKey', () => {
  it('同一 30 分鐘桶內的不同出發時間產生相同的鍵', () => {
    const a = buildRouteCacheKey({ ...BASE, departureMs: Date.UTC(2026, 9, 1, 9, 1) })
    const b = buildRouteCacheKey({ ...BASE, departureMs: Date.UTC(2026, 9, 1, 9, 29) })
    expect(a).toBe(b)
  })

  it('跨桶的出發時間產生不同的鍵', () => {
    const a = buildRouteCacheKey({ ...BASE, departureMs: Date.UTC(2026, 9, 1, 9, 29) })
    const b = buildRouteCacheKey({ ...BASE, departureMs: Date.UTC(2026, 9, 1, 9, 31) })
    expect(a).not.toBe(b)
  })

  it('座標第 5 位小數的差異不影響鍵（4 位精度）', () => {
    const a = buildRouteCacheKey(BASE)
    const b = buildRouteCacheKey({ ...BASE, fromLat: 35.714781 })
    expect(a).toBe(b)
  })

  it('交通方式不同則鍵不同', () => {
    const a = buildRouteCacheKey(BASE)
    const b = buildRouteCacheKey({ ...BASE, mode: 'walking' })
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
npx vitest run src/lib/domain/cacheKey.test.ts
```

Expected: FAIL — `Cannot find module './cacheKey'`

- [ ] **Step 3: 最小實作**

Create `src/lib/domain/cacheKey.ts`:

```ts
export type RouteQuery = {
  fromLat: number
  fromLng: number
  toLat: number
  toLng: number
  mode: 'transit' | 'walking' | 'driving'
  departureMs: number
}

const BUCKET_MS = 30 * 60 * 1000
const COORD_DECIMALS = 4

/** route_cache 的主鍵：座標(4位小數) + 交通方式 + 出發時間(30分桶)。 */
export function buildRouteCacheKey(q: RouteQuery): string {
  const r = (n: number) => n.toFixed(COORD_DECIMALS)
  const bucket = Math.floor(q.departureMs / BUCKET_MS) * BUCKET_MS
  return [r(q.fromLat), r(q.fromLng), r(q.toLat), r(q.toLng), q.mode, bucket].join('|')
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
npx vitest run src/lib/domain/cacheKey.test.ts
```

Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/cacheKey.ts src/lib/domain/cacheKey.test.ts
git commit -m "feat: buildRouteCacheKey 路線快取鍵"
```

---

### Task 5: 花費加總

spec 依據：§4 預估花費為可空欄位；總預估與每人預估為衍生顯示。每日分組需搭配停留點時區，屬 Plan 3（時間軸 UI）範圍。

**Files:**
- Create: `src/lib/domain/cost.ts`
- Test: `src/lib/domain/cost.test.ts`

- [ ] **Step 1: 寫失敗測試**

Create `src/lib/domain/cost.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { totalEstimatedCost, perPersonCost } from './cost'

describe('totalEstimatedCost', () => {
  it('加總所有項目，null 視為 0', () => {
    const items = [{ estimatedCost: 1200 }, { estimatedCost: null }, { estimatedCost: 180 }]
    expect(totalEstimatedCost(items)).toBe(1380)
  })

  it('空陣列回傳 0', () => {
    expect(totalEstimatedCost([])).toBe(0)
  })
})

describe('perPersonCost', () => {
  it('總額除以人數', () => {
    expect(perPersonCost(1380, 3)).toBe(460)
  })

  it('人數小於 1 時回傳總額', () => {
    expect(perPersonCost(1380, 0)).toBe(1380)
  })
})
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
npx vitest run src/lib/domain/cost.test.ts
```

Expected: FAIL — `Cannot find module './cost'`

- [ ] **Step 3: 最小實作**

Create `src/lib/domain/cost.ts`:

```ts
export type CostItem = { estimatedCost: number | null }

export function totalEstimatedCost(items: CostItem[]): number {
  return items.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0)
}

export function perPersonCost(total: number, memberCount: number): number {
  if (memberCount < 1) return total
  return total / memberCount
}
```

- [ ] **Step 4: 執行測試確認通過**

```bash
npx vitest run src/lib/domain/cost.test.ts
```

Expected: PASS（4 tests）

- [ ] **Step 5: 跑全部單元測試確認整體綠燈後 Commit**

```bash
npm test
```

Expected: PASS（schedule 5 + conflicts 4 + cacheKey 4 + cost 4 = 17 tests）

```bash
git add src/lib/domain/cost.ts src/lib/domain/cost.test.ts
git commit -m "feat: 預估花費加總純函式"
```

---

### Task 6: Supabase 本地環境與資料庫 Schema（七張表 + RLS）

spec 依據：§4 資料模型全部七張表、RLS 三規則（成員能讀 / editor 以上能寫 / viewer 唯讀）、owner 自動入 membership、route_cache 僅服務端可存取。

**Files:**
- Create: `supabase/config.toml`（CLI 產生）
- Create: `supabase/migrations/20260730000000_init.sql`

- [ ] **Step 1: 安裝 Supabase CLI 並初始化**

```bash
brew install supabase/tap/supabase
supabase init
```

Expected: 產生 `supabase/config.toml`。

- [ ] **Step 2: 啟動本地 Supabase（需 Docker Desktop 執行中）**

```bash
supabase start
```

Expected: 輸出本地各服務 URL 與 anon / service_role key。第一次啟動會拉 Docker 映像，需數分鐘。

- [ ] **Step 3: 撰寫初始 migration**

Create `supabase/migrations/20260730000000_init.sql`:

```sql
-- ============ profiles ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text
);
alter table public.profiles enable row level security;

create policy "authenticated 可讀 profiles"
  on public.profiles for select to authenticated using (true);
create policy "本人可更新 profile"
  on public.profiles for update to authenticated using (id = auth.uid());

-- 註冊時自動建立 profile
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ trips ============
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_date date not null,
  end_date date not null,
  currency text not null default 'TWD',
  owner_id uuid not null references auth.users(id) default auth.uid(),
  share_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- ============ trip_members ============
create table public.trip_members (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

-- 權限判斷函式（security definer 避免 RLS 遞迴）
create function public.is_trip_member(p_trip_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from trip_members
    where trip_id = p_trip_id and user_id = auth.uid()
  )
$$;

create function public.is_trip_editor(p_trip_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from trip_members
    where trip_id = p_trip_id and user_id = auth.uid()
      and role in ('owner', 'editor')
  )
$$;

create function public.is_trip_owner(p_trip_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from trip_members
    where trip_id = p_trip_id and user_id = auth.uid() and role = 'owner'
  )
$$;

alter table public.trips enable row level security;
create policy "成員可讀行程"
  on public.trips for select to authenticated using (public.is_trip_member(id));
create policy "登入者可建行程（owner 是自己）"
  on public.trips for insert to authenticated with check (owner_id = auth.uid());
create policy "editor 以上可改行程"
  on public.trips for update to authenticated using (public.is_trip_editor(id));
create policy "owner 可刪行程"
  on public.trips for delete to authenticated using (public.is_trip_owner(id));

alter table public.trip_members enable row level security;
create policy "成員可讀成員名單"
  on public.trip_members for select to authenticated using (public.is_trip_member(trip_id));
create policy "owner 可管理成員"
  on public.trip_members for insert to authenticated with check (public.is_trip_owner(trip_id));
create policy "owner 可移除成員"
  on public.trip_members for delete to authenticated using (public.is_trip_owner(trip_id));

-- 建行程時 owner 自動入 membership（security definer 繞過上面的 insert policy）
create function public.handle_new_trip() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.trip_members (trip_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end $$;

create trigger on_trip_created
  after insert on public.trips
  for each row execute function public.handle_new_trip();

-- ============ stops ============
create table public.stops (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  place_id text,
  is_custom boolean not null default false,
  place_refreshed_at timestamptz,
  timezone text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  locked boolean not null default false,
  notes text,
  estimated_cost numeric,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index stops_trip_id_idx on public.stops (trip_id);

alter table public.stops enable row level security;
create policy "成員可讀停留點"
  on public.stops for select to authenticated using (public.is_trip_member(trip_id));
create policy "editor 以上可增停留點"
  on public.stops for insert to authenticated with check (public.is_trip_editor(trip_id));
create policy "editor 以上可改停留點"
  on public.stops for update to authenticated using (public.is_trip_editor(trip_id));
create policy "editor 以上可刪停留點"
  on public.stops for delete to authenticated using (public.is_trip_editor(trip_id));

-- ============ legs ============
create table public.legs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  from_stop_id uuid not null references public.stops(id) on delete cascade,
  to_stop_id uuid not null references public.stops(id) on delete cascade,
  mode text not null check (mode in ('transit', 'walking', 'driving', 'custom')),
  duration_minutes integer,
  distance_meters integer,
  polyline text,
  detail jsonb,
  source text not null check (source in ('auto', 'manual')),
  stale boolean not null default false,
  computed_at timestamptz,
  estimated_cost numeric,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index legs_trip_id_idx on public.legs (trip_id);

alter table public.legs enable row level security;
create policy "成員可讀交通段"
  on public.legs for select to authenticated using (public.is_trip_member(trip_id));
create policy "editor 以上可增交通段"
  on public.legs for insert to authenticated with check (public.is_trip_editor(trip_id));
create policy "editor 以上可改交通段"
  on public.legs for update to authenticated using (public.is_trip_editor(trip_id));
create policy "editor 以上可刪交通段"
  on public.legs for delete to authenticated using (public.is_trip_editor(trip_id));

-- ============ trip_snapshots ============
create table public.trip_snapshots (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  label text not null,
  snapshot jsonb not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.trip_snapshots enable row level security;
create policy "成員可讀快照"
  on public.trip_snapshots for select to authenticated using (public.is_trip_member(trip_id));
create policy "editor 以上可建快照"
  on public.trip_snapshots for insert to authenticated with check (public.is_trip_editor(trip_id));
create policy "owner 可刪快照"
  on public.trip_snapshots for delete to authenticated using (public.is_trip_owner(trip_id));

-- ============ route_cache（僅伺服器端以 service role 存取；RLS 開啟且不建 policy = 用戶端全拒） ============
create table public.route_cache (
  cache_key text primary key,
  result jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.route_cache enable row level security;

-- ============ updated_at 自動更新 ============
create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger stops_touch before update on public.stops
  for each row execute function public.touch_updated_at();
create trigger legs_touch before update on public.legs
  for each row execute function public.touch_updated_at();

-- ============ Realtime 廣播（Plan 5 使用，先開好） ============
alter publication supabase_realtime add table public.trips, public.stops, public.legs;
alter table public.stops replica identity full;
alter table public.legs replica identity full;
```

- [ ] **Step 4: 套用 migration 並驗證**

```bash
supabase db reset
```

Expected: 輸出 `Applying migration 20260730000000_init.sql...` 且無錯誤。

```bash
supabase status
```

Expected: 各服務 RUNNING。把輸出中的 `API URL`、`anon key`、`service_role key` 留著，Task 7、8 會用。

- [ ] **Step 5: Commit**

```bash
git add supabase/
git commit -m "feat: 資料庫 schema 七張表與 RLS 權限"
```

---

### Task 7: RLS 整合測試

用兩個真實使用者對本地 Supabase 驗證權限規則。沒設環境變數時自動跳過（CI 與純單元測試環境不受影響）。

**Files:**
- Create: `src/lib/supabase/rls.test.ts`
- Create: `.env.test.local`（不進版控，`.gitignore` 已涵蓋）

- [ ] **Step 1: 安裝 supabase-js 並準備測試環境變數**

```bash
npm install @supabase/supabase-js
```

Create `.env.test.local`（值來自 Task 6 Step 4 的 `supabase status` 輸出）：

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
```

修改 `vitest.config.ts`，讓 vitest 讀入該檔（完整檔案內容）：

```ts
import { defineConfig, loadEnv } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    env: loadEnv('test', process.cwd(), ''),
  },
})
```

（`loadEnv` 第三參數傳空字串表示載入所有變數，含無 `VITE_` 前綴者；`.env.test.local` 屬於 `test` mode 的載入範圍。）

- [ ] **Step 2: 寫失敗測試**

Create `src/lib/supabase/rls.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && anonKey && serviceKey)

function newUserClient(): SupabaseClient {
  return createClient(url!, anonKey!, { auth: { persistSession: false } })
}

describe.skipIf(!hasEnv)('RLS 權限規則（需本地 Supabase）', () => {
  let owner: SupabaseClient
  let stranger: SupabaseClient
  let tripId: string

  beforeAll(async () => {
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    const suffix = Math.random().toString(36).slice(2, 8)
    const password = 'test-password-1234'
    const ownerEmail = `owner-${suffix}@test.local`
    const strangerEmail = `stranger-${suffix}@test.local`
    await admin.auth.admin.createUser({ email: ownerEmail, password, email_confirm: true })
    await admin.auth.admin.createUser({ email: strangerEmail, password, email_confirm: true })

    owner = newUserClient()
    stranger = newUserClient()
    await owner.auth.signInWithPassword({ email: ownerEmail, password })
    await stranger.auth.signInWithPassword({ email: strangerEmail, password })

    const { data, error } = await owner
      .from('trips')
      .insert({ title: 'RLS 測試行程', start_date: '2026-10-01', end_date: '2026-10-05', currency: 'JPY' })
      .select('id')
      .single()
    if (error) throw error
    tripId = data.id
  })

  it('owner 建立行程後自動成為成員並可讀取', async () => {
    const { data: members } = await owner
      .from('trip_members').select('role').eq('trip_id', tripId)
    expect(members).toEqual([{ role: 'owner' }])

    const { data: trips } = await owner.from('trips').select('id').eq('id', tripId)
    expect(trips).toHaveLength(1)
  })

  it('非成員讀不到行程', async () => {
    const { data } = await stranger.from('trips').select('id').eq('id', tripId)
    expect(data).toEqual([])
  })

  it('非成員不能新增停留點', async () => {
    const { error } = await stranger.from('stops').insert({
      trip_id: tripId, name: '偷加的景點', lat: 35.7, lng: 139.8,
      timezone: 'Asia/Tokyo',
      starts_at: '2026-10-01T09:00:00Z', ends_at: '2026-10-01T10:00:00Z',
    })
    expect(error).not.toBeNull()
  })

  it('owner 可以新增停留點', async () => {
    const { error } = await owner.from('stops').insert({
      trip_id: tripId, name: '淺草寺', lat: 35.71478, lng: 139.79665,
      timezone: 'Asia/Tokyo',
      starts_at: '2026-10-01T09:00:00Z', ends_at: '2026-10-01T10:30:00Z',
    })
    expect(error).toBeNull()
  })

  it('用戶端完全碰不到 route_cache', async () => {
    const { error } = await owner.from('route_cache').insert({
      cache_key: 'x', result: {},
    })
    expect(error).not.toBeNull()
  })
})
```

- [ ] **Step 3: 執行測試**

```bash
npx vitest run src/lib/supabase/rls.test.ts
```

Expected: PASS（5 tests）。若 schema 或 policy 有誤會在此暴露——先修 migration 再 `supabase db reset` 重跑，直到綠燈。

（註：此 Task 的「失敗優先」體現在：RLS policy 寫錯時測試立即紅燈。若想確認測試本身有效，可暫時註解掉 migration 中任一條 policy 後 `supabase db reset` 重跑，觀察對應測試變紅，再還原。）

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/rls.test.ts vitest.config.ts package.json package-lock.json
git commit -m "test: RLS 權限整合測試"
```

---

### Task 8: Supabase Client、Session Middleware 與登入頁

spec 依據：§3 Supabase Auth（Email + Google OAuth）。本 Task 完成 Email/密碼登入全流程；Google OAuth 按鈕先做好，供應商設定（GCP OAuth client + Supabase dashboard）屬部署期手動作業，列在 Task 10。

**Files:**
- Create: `src/lib/supabase/client.ts`
- Create: `src/lib/supabase/server.ts`
- Create: `src/middleware.ts`
- Create: `src/app/login/page.tsx`
- Create: `src/app/auth/callback/route.ts`
- Create: `.env.local`

- [ ] **Step 1: 安裝 @supabase/ssr 並設定環境變數**

```bash
npm install @supabase/ssr
```

Create `.env.local`（值同 `.env.test.local`，anon key 本來就是公開金鑰，但仍不進版控）：

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

- [ ] **Step 2: 建立瀏覽器端與伺服器端 client**

Create `src/lib/supabase/client.ts`:

```ts
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
```

Create `src/lib/supabase/server.ts`:

```ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server Component 內呼叫 set 會丟例外，session 刷新交給 middleware，安全忽略
          }
        },
      },
    },
  )
}
```

- [ ] **Step 3: 建立 session 刷新 middleware**

Create `src/middleware.ts`:

```ts
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
        },
      },
    },
  )
  await supabase.auth.getUser() // 觸發過期 token 刷新
  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
```

- [ ] **Step 4: 建立登入頁與 OAuth 回呼**

Create `src/app/login/page.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')

  async function signIn() {
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setMessage(`登入失敗：${error.message}`)
      return
    }
    router.push('/trips')
    router.refresh()
  }

  async function signUp() {
    const supabase = createClient()
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setMessage(`註冊失敗：${error.message}`)
      return
    }
    setMessage('註冊成功，請直接登入')
  }

  async function signInWithGoogle() {
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/callback` },
    })
    if (error) setMessage(`Google 登入失敗：${error.message}`)
  }

  return (
    <main className="mx-auto mt-24 flex w-80 flex-col gap-3">
      <h1 className="text-2xl font-bold">Travel Planner</h1>
      <input
        className="rounded border p-2"
        type="email"
        placeholder="Email"
        value={email}
        onChange={e => setEmail(e.target.value)}
      />
      <input
        className="rounded border p-2"
        type="password"
        placeholder="密碼"
        value={password}
        onChange={e => setPassword(e.target.value)}
      />
      <button className="rounded bg-black p-2 text-white" onClick={signIn}>
        登入
      </button>
      <button className="rounded border p-2" onClick={signUp}>
        註冊
      </button>
      <button className="rounded border p-2" onClick={signInWithGoogle}>
        使用 Google 登入
      </button>
      {message && <p className="text-sm text-red-600">{message}</p>}
    </main>
  )
}
```

Create `src/app/auth/callback/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  if (code) {
    const supabase = await createClient()
    await supabase.auth.exchangeCodeForSession(code)
  }
  return NextResponse.redirect(`${origin}/trips`)
}
```

- [ ] **Step 5: 手動驗證登入流程**

```bash
npm run dev
```

驗證步驟：
1. 開 http://localhost:3000/login
2. 輸入 `demo@test.local` / `demo-password-1234` → 按「註冊」→ 看到「註冊成功，請直接登入」
3. 按「登入」→ 導向 `/trips`（此頁下個 Task 才建立，看到 404 是預期行為；重點是 URL 有跳轉、無錯誤訊息）

Expected: 上述流程無誤。（Google 按鈕此時點了會報錯——供應商尚未設定，屬預期。）

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase/client.ts src/lib/supabase/server.ts src/middleware.ts src/app/login src/app/auth package.json package-lock.json
git commit -m "feat: Supabase 登入流程（email/密碼 + Google OAuth 入口）"
```

---

### Task 9: 行程清單與建立頁

spec 依據：§3 行程 CRUD 的最小切片——列出我的行程、建立行程（標題、日期、幣別）。編輯與刪除在後續計畫隨地圖頁一起做。

**Files:**
- Create: `src/app/trips/page.tsx`
- Create: `src/app/trips/CreateTripForm.tsx`
- Modify: `src/app/page.tsx`（整檔覆蓋）

- [ ] **Step 1: 首頁導向 /trips**

Replace `src/app/page.tsx` 全部內容：

```tsx
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/trips')
}
```

- [ ] **Step 2: 行程清單頁（Server Component）**

Create `src/app/trips/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import CreateTripForm from './CreateTripForm'

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

  return (
    <main className="mx-auto mt-12 w-[32rem]">
      <h1 className="mb-6 text-2xl font-bold">我的行程</h1>
      <CreateTripForm />
      {error && <p className="mt-4 text-red-600">讀取失敗：{error.message}</p>}
      <ul className="mt-6 flex flex-col gap-2">
        {(trips ?? []).map(trip => (
          <li key={trip.id} className="rounded border p-3">
            <span className="font-medium">{trip.title}</span>
            <span className="ml-2 text-sm text-gray-500">
              {trip.start_date} ~ {trip.end_date}（{trip.currency}）
            </span>
          </li>
        ))}
        {trips?.length === 0 && <li className="text-gray-500">還沒有行程，建立第一個吧</li>}
      </ul>
    </main>
  )
}
```

- [ ] **Step 3: 建立行程表單（Client Component）**

Create `src/app/trips/CreateTripForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function CreateTripForm() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [currency, setCurrency] = useState('TWD')
  const [message, setMessage] = useState('')

  async function createTrip() {
    if (!title || !startDate || !endDate) {
      setMessage('標題與起訖日期都要填')
      return
    }
    if (endDate < startDate) {
      setMessage('結束日期不能早於開始日期')
      return
    }
    const supabase = createClient()
    const { error } = await supabase
      .from('trips')
      .insert({ title, start_date: startDate, end_date: endDate, currency })
    if (error) {
      setMessage(`建立失敗：${error.message}`)
      return
    }
    setTitle('')
    setMessage('')
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-2 rounded border p-3">
      <input
        className="rounded border p-2"
        placeholder="行程標題（例如：東京五日遊）"
        value={title}
        onChange={e => setTitle(e.target.value)}
      />
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border p-2"
          type="date"
          value={startDate}
          onChange={e => setStartDate(e.target.value)}
        />
        <input
          className="flex-1 rounded border p-2"
          type="date"
          value={endDate}
          onChange={e => setEndDate(e.target.value)}
        />
        <select
          className="rounded border p-2"
          value={currency}
          onChange={e => setCurrency(e.target.value)}
        >
          <option value="TWD">TWD</option>
          <option value="JPY">JPY</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="KRW">KRW</option>
        </select>
      </div>
      <button className="rounded bg-black p-2 text-white" onClick={createTrip}>
        建立行程
      </button>
      {message && <p className="text-sm text-red-600">{message}</p>}
    </div>
  )
}
```

- [ ] **Step 4: 手動驗證**

```bash
npm run dev
```

驗證步驟：
1. 開 http://localhost:3000 → 未登入自動導向 `/login`，登入後導向 `/trips`
2. 建立行程「東京五日遊」2026-10-01 ~ 2026-10-05、JPY → 清單立即出現
3. 結束日期填早於開始日期 → 顯示錯誤訊息且不送出
4. 登出情境：開無痕視窗直接進 `/trips` → 導向 `/login`

Expected: 全部符合。

- [ ] **Step 5: 跑全部測試確認綠燈後 Commit**

```bash
npm test
```

Expected: PASS（單元 17 + RLS 5 = 22 tests；若本地 Supabase 未啟動則 RLS 5 顯示 skipped，亦為綠燈）

```bash
git add src/app
git commit -m "feat: 行程清單與建立頁"
```

---

### Task 10: 收尾——README 開發指引與推送

**Files:**
- Modify: `README.md`（僅「開發」一節）

- [ ] **Step 1: 更新 README 開發指引**

把 `README.md` 中整段：

````markdown
## 開發

```bash
# 尚未建立程式碼骨架，實作開始後補充開發指引
```
````

替換為：

````markdown
## 開發

前置需求：nvm（Node LTS）、Docker Desktop、Supabase CLI（`brew install supabase/tap/supabase`）。

```bash
nvm use --lts
npm install
supabase start                 # 啟動本地 Supabase（首次會拉 Docker 映像）
supabase db reset              # 套用 migrations
cp .env.example .env.local     # 填入 supabase status 顯示的 URL 與 anon key
npm run dev                    # http://localhost:3000
npm test                       # 單元測試 + RLS 整合測試（需本地 Supabase）
```
````

Create `.env.example`:

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase status 顯示的 anon key>
```

- [ ] **Step 2: 全量驗證**

```bash
npm run build && npm test
```

Expected: build 成功、測試全綠。

- [ ] **Step 3: Commit 並推送**

```bash
git add README.md .env.example
git commit -m "docs: 開發環境指引"
git push
```

- [ ] **Step 4: 記錄部署期手動作業（不在本計畫執行）**

以下屬雲端部署時的一次性手動設定，本計畫僅在此列出、不執行：
1. Supabase 雲端專案建立 + `supabase db push` 套用 migration
2. GCP 建立 OAuth client → Supabase Dashboard 啟用 Google provider
3. Vercel 專案連結 GitHub repo + 設定環境變數（改指向雲端 Supabase）

---

## 完成定義（Definition of Done）

- [ ] `npm run build` 成功
- [ ] `npm test` 全綠（本地 Supabase 啟動時 22 tests，含 RLS 5）
- [ ] 手動流程通過：註冊 → 登入 → 建立行程 → 清單顯示；未登入訪問 `/trips` 被導向 `/login`
- [ ] 非成員無法讀寫他人行程（RLS 測試證明）
- [ ] 全部改動已 commit 並 push
