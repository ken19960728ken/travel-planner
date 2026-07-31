# Travel Planner 交通段（Plan 4/5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交通的維度上線——相鄰停留點自動計算交通時間（Routes API + 快取 + Google ToS 30 天分層）、時間軸色塊間顯示交通連接條（時長/模式/趕不上警示）、手動修正與 flight 段（台北→福岡航班，跨日跨時區）、選中日地圖 polyline，並收 PR #3 總審遺留清項。

**Architecture:** `legs` 表已在 init migration 建好（RLS、複合 FK、touch trigger 齊備，至今零資料——本 Plan 的 migration 只做擴充，零遷移風險）。核心決策：

1. **相鄰配對 = 全行程按 starts_at 排序的連續配對**（不限同日），跨日的航班段天然支援；**leg 歸屬「from 停留點所屬日」**——跨夜段顯示在出發日末尾（審查 M-4 定案），不存在看得到資料卻摸不到 UI 的段。
2. **auto 段以 `departs_at` 為重算基準**：計算當下記錄 `departs_at := from_stop.ends_at`；sync 時 `from_stop.ends_at ≠ departs_at` 即重算。同一欄位同時服務 flight/manual 段的使用者班次時間，一欄兩用。
3. **manual 段的 stale 標記用 DB statement-level trigger（transition table + 依 id 決定性鎖序）**：停留點時間變動（單列編輯、cascade RPC、任何未來路徑）一體適用且與交易原子，client 不可能漏標。**禁止改回 row-level 版**——row-level AFTER trigger 的逐列 legs UPDATE 已被審查員實測與單列 stop 編輯路徑鎖序成環（40P01 deadlock）；也**不要**改成 trigger 內取 advisory lock（反序換一種 deadlock）。
4. **sync 端點對 legs 一律逐列寫入**（各語句自成交易，不累積多列鎖）：與 trigger 的「依 id 排序取鎖」不變量共同構成 deadlock 防線。任何未來在單一交易內多列寫 legs 的路徑，必須同樣按 id 排序取列鎖（legs 表註解寫死）。
5. **ToS 分層落地**：auto 段的 duration/polyline 為 30 天 TTL 可重建快取（`computed_at`）；manual 段轉存時**清除 polyline/detail**（manual = 使用者資料永存，不得夾帶 Google 衍生資料）；`route_cache` 讀取時逾 30 天視為 miss 並覆寫。
6. **金鑰不落 client**：Routes 呼叫走 server route handler；瀏覽器金鑰（referrer 限制）**不能**用於 server 呼叫（會 REQUEST_DENied），需另建無 referrer 限制、API 限制為 Routes API 的伺服器金鑰 `GOOGLE_MAPS_SERVER_API_KEY`。

**Routes API 事實（2026-07-31 經官方 v2 文件逐條查證，非記憶）：**

- Endpoint：`POST https://routes.googleapis.com/directions/v2:computeRoutes`；金鑰放 header `X-Goog-Api-Key`。
- `X-Goog-FieldMask` header **必填**否則報錯；本專案用 `routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline`。
- Body：`origin.location.latLng.{latitude,longitude}`；`travelMode` enum：`TRANSIT` / `WALK` / `DRIVE`（WALK 為 beta，官方要求顯示警語）。
- `departureTime`（RFC 3339 UTC）**只有 TRANSIT 允許過去時間**（過去 7 天 ~ 未來 100 天）；DRIVE/WALK 帶過去時間會被拒——本專案僅 TRANSIT 帶 departureTime（夾限到允許區間），DRIVE/WALK 一律不帶（結果與出發時間無關，預設 TRAFFIC_UNAWARE）。
- top-level `routingPreference` 只允許 DRIVE/TWO_WHEELER，其餘模式帶了**直接失敗**——一律不帶。
- Response：`routes[].duration` 為 `"165s"` 格式字串；查無路線 = 200 + 空 `routes` 陣列（非 404）。
- 錯誤格式：`{ "error": { "code", "message", "status" } }`。

**Tech Stack:** Routes API v2（server-side fetch）/ Postgres trigger（stale 標記）/ google.maps.Polyline + geometry.encoding（地圖路線）

**Spec:** `docs/superpowers/specs/2026-07-30-travel-planner-design.md` §4（legs 資料模型、ToS 分層）、§6（交通計算與快取生命週期、成本護欄、錯誤處理原則）、§5（交通段互動、警示不阻擋）

**衝刺目標：** 使用者 8/2 九州出發（今天 7/31）。任務分兩級——**【出發前必須】**Task 1-6、8、10（自動計算 + 時間軸顯示最先可用，手動修正與航班段跟上，收尾含正式環境部署）；**【可旅途中補】**Task 7（地圖 polyline）、Task 9（總審遺留清項，可裁）。時間告急時砍 7、9，其餘不砍。

**分支：** `git checkout -b feat/plan-4-transit`（main 已含 Plan 1-3）。

---

## 檔案結構總覽

```
src/
├── lib/domain/
│   ├── legSync.ts / legSync.test.ts      # 相鄰配對 + 同步計畫（新，TDD）
│   ├── rateLimit.ts / rateLimit.test.ts  # 路線代理限流（新，TDD）
│   └── cacheKey.ts                       # 沿用 buildRouteCacheKey（Plan 1 已 TDD）
├── lib/google/
│   └── routes.ts / routes.test.ts        # Routes API 請求組裝/回應解析（新，TDD）
├── lib/supabase/
│   ├── service.ts                        # service role 客戶端（新，server-only）
│   ├── legs.test.ts                      # legs schema + stale trigger 整合測試（新）
│   └── database.types.ts                 # 重生（legs 增欄）
├── app/api/trips/[tripId]/legs/sync/
│   └── route.ts                          # 交通段同步端點（新）
├── app/trips/[tripId]/
│   ├── page.tsx                          # 加 select legs
│   ├── TripView.tsx                      # legs 資料流、sync 觸發、leg 選取、側欄交通列
│   ├── Timeline.tsx                      # 交通連接條、conflicts 接真 legs
│   ├── LegEditor.tsx                     # 交通段編輯器（新：手動修正 + flight）
│   ├── legUi.ts                          # 模式圖示/標籤/no_route 判讀共用（新）
│   └── RoutePolylines.tsx                # 地圖路線（新，Task 7）
supabase/migrations/
└── 20260802000000_legs_transit.sql       # flight 模式、起訖欄位、unique 配對、stale trigger（新）
```

---

### Task 1: legs schema 擴充（migration + 整合測試）【出發前必須】

**Files:** Create `supabase/migrations/20260802000000_legs_transit.sql`、`src/lib/supabase/legs.test.ts`；Regenerate `src/lib/supabase/database.types.ts`

- [ ] **Step 1: migration**

```sql
begin;

-- flight 加入 mode 白名單（init 的 inline check 自動命名為 legs_mode_check）。
-- 'custom' 保留為「使用者自填的其他交通方式」（spec §4 的 mode 用語），不改名。
alter table public.legs drop constraint if exists legs_mode_check;
alter table public.legs add constraint legs_mode_check
  check (mode in ('transit', 'walking', 'driving', 'flight', 'custom'));

-- 起訖時間，一欄兩用：
--   auto 段  = 計算基準（departs_at := 計算當下的 from_stop.ends_at；arrives_at := departs_at + duration），
--              sync 以「from_stop.ends_at 是否偏離 departs_at」判定需要重算
--   manual/flight 段 = 使用者輸入的真實班次時間（可跨日跨時區；duration_minutes 由起訖導出後冗餘儲存供衝突偵測）
alter table public.legs
  add column departs_at timestamptz,
  add column arrives_at timestamptz,
  add constraint legs_departs_arrives_check
    check (departs_at is null or arrives_at is null or arrives_at > departs_at);

-- 同一有向配對只允許一條交通段（sync 演算法的前提；legs 至今零資料，加約束零風險）
alter table public.legs add constraint legs_from_to_unique unique (from_stop_id, to_stop_id);

-- route_cache 過期清理用索引（sync 每次做有界過期刪除，見 Task 4）
create index route_cache_fetched_at_idx on public.route_cache (fetched_at);

-- spec §4：停留點時間變動時，manual 段標 stale（絕不自動覆蓋/刪除）。
-- 用 DB trigger 而非 client 邏輯：單列編輯、cascade RPC、任何未來寫入路徑一體適用且與交易原子。
--
-- 【審查 C-2，本機已復現 40P01】必須是 statement-level trigger + transition table + 依 id 決定性鎖序：
--   row-level AFTER trigger 在 cascade 語句後逐列 UPDATE legs，與單列 stop 編輯路徑的 legs 鎖序
--   互相顛倒成環（已實測 deadlock）。也不要改成 trigger 內取 advisory lock——反序換一種 deadlock。
--   statement-level trigger 不支援引用列值的 WHEN 條件，時間欄位變動的過濾由 changed CTE 承擔。
create function public.mark_manual_legs_stale() returns trigger
language plpgsql set search_path = public as $$
begin
  with changed as (
    select n.id from new_stops n join old_stops o using (id)
    where (n.starts_at, n.ends_at) is distinct from (o.starts_at, o.ends_at)
  ),
  target as (
    select l.id from public.legs l
    where l.source = 'manual' and l.stale = false
      and exists (select 1 from changed c where l.from_stop_id = c.id or l.to_stop_id = c.id)
    order by l.id
    for update
  )
  update public.legs set stale = true where id in (select id from target);
  return null;
end $$;

create trigger stops_mark_manual_legs_stale
  after update on public.stops
  referencing old table as old_stops new table as new_stops
  for each statement execute function public.mark_manual_legs_stale();

comment on table public.legs is
  '鎖序不變量（Plan 4）：stops_mark_manual_legs_stale 為 statement-level trigger，'
  '以 order by id for update 的決定性順序鎖定 legs 列。任何在單一交易內多列寫入本表的路徑，'
  '必須同樣按 id 排序取列鎖，否則與此 trigger 併發時會 deadlock（40P01 已實測）。'
  'sync 端點刻意逐列寫入（各語句自成交易），不受此限。';

commit;
```

- [ ] **Step 2: 本地套用**（`db reset` 故障的既有 workaround）：psql 灌檔 + history 記 `('20260802000000','legs_transit')`：

```bash
docker exec -i supabase_db_traval psql -U postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260802000000_legs_transit.sql
docker exec supabase_db_traval psql -U postgres -c \
  "insert into supabase_migrations.schema_migrations (version, name) values ('20260802000000','legs_transit') on conflict do nothing;"
```

- [ ] **Step 3: 重生型別** — `supabase gen types typescript --local > src/lib/supabase/database.types.ts`。若 CLI 故障（本機已知體質），手動在 legs 的 Row/Insert/Update 各補 `departs_at: string | null` 與 `arrives_at: string | null`（Insert/Update 為可選）並如實回報。

- [ ] **Step 4: 整合測試** — Create `src/lib/supabase/legs.test.ts`（比照 rpc.test.ts 模式：skipIf、隨機 email、afterAll 清 trip 與 user）：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && anonKey && serviceKey)

// 護欄：整合測試會寫入與刪除資料，只允許對本地 Supabase 執行
if (url && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行整合測試（防止誤打正式環境）')
}

describe.skipIf(!hasEnv)('legs schema 與 stale trigger（需本地 Supabase）', () => {
  let admin: SupabaseClient
  let owner: SupabaseClient
  let ownerId: string | undefined
  let tripId: string
  const stopIds: string[] = []
  // 注意（審查 M-1）：Date.UTC 對小數時數做整數截斷（MakeTime 的 ToIntegerOrInfinity），
  // mk(4.5) 會等於 mk(4)——半小時一律用分鐘參數表達
  const mk = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 2, h, m)).toISOString()

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    const suffix = Math.random().toString(36).slice(2, 8)
    const password = 'test-password-1234'
    const o = await admin.auth.admin.createUser({ email: `legs-${suffix}@test.local`, password, email_confirm: true })
    ownerId = o.data.user?.id
    owner = createClient(url!, anonKey!, { auth: { persistSession: false } })
    await owner.auth.signInWithPassword({ email: `legs-${suffix}@test.local`, password })

    const { data: trip, error } = await owner
      .from('trips')
      .insert({ title: 'legs 測試行程', start_date: '2026-08-02', end_date: '2026-08-06', currency: 'JPY' })
      .select('id')
      .single()
    if (error) throw error
    tripId = trip.id

    for (const [name, sh, eh] of [['桃機', 0, 1], ['福岡機場', 4, 5], ['博多', 6, 7]] as const) {
      const { data, error: e } = await owner
        .from('stops')
        .insert({
          trip_id: tripId, name, lat: 33.59, lng: 130.4, timezone: 'Asia/Tokyo',
          starts_at: mk(sh), ends_at: mk(eh),
        })
        .select('id')
        .single()
      if (e) throw e
      stopIds.push(data.id)
    }
  })

  afterAll(async () => {
    if (tripId) await admin.from('trips').delete().eq('id', tripId) // legs 隨 cascade 清掉
    if (ownerId) await admin.auth.admin.deleteUser(ownerId)
  })

  it('flight 段可插入（manual、起訖時間跨時區）', async () => {
    const { error } = await owner.from('legs').insert({
      trip_id: tripId, from_stop_id: stopIds[0], to_stop_id: stopIds[1],
      mode: 'flight', source: 'manual', duration_minutes: 135,
      departs_at: mk(0, 30), arrives_at: mk(2, 45),
    })
    expect(error).toBeNull()
  })

  it('arrives_at 不晚於 departs_at 被 check 擋下（23514）', async () => {
    const { error } = await owner.from('legs').insert({
      trip_id: tripId, from_stop_id: stopIds[1], to_stop_id: stopIds[2],
      mode: 'custom', source: 'manual', departs_at: mk(5), arrives_at: mk(5),
    })
    expect(error?.code).toBe('23514')
  })

  it('同一有向配對第二條 leg 被 unique 擋下（23505）', async () => {
    const { error } = await owner.from('legs').insert({
      trip_id: tripId, from_stop_id: stopIds[0], to_stop_id: stopIds[1],
      mode: 'transit', source: 'auto',
    })
    expect(error?.code).toBe('23505')
  })

  it('停留點時間變動 → manual 段被 trigger 標 stale；auto 段不動', async () => {
    const { error: autoErr } = await owner.from('legs').insert({
      trip_id: tripId, from_stop_id: stopIds[1], to_stop_id: stopIds[2],
      mode: 'transit', source: 'auto', duration_minutes: 12,
    })
    expect(autoErr).toBeNull()

    // 動 stopIds[1]（同時是 manual 段的 to、auto 段的 from）；用分鐘級偏移確保值真的變了（M-1）
    const { error } = await owner.from('stops')
      .update({ starts_at: mk(4, 30), ends_at: mk(5, 30) }).eq('id', stopIds[1])
    expect(error).toBeNull()

    const { data } = await owner.from('legs')
      .select('source, stale').eq('trip_id', tripId).order('source')
    const bySource = Object.fromEntries(data!.map(r => [r.source, r.stale]))
    expect(bySource['manual']).toBe(true)
    expect(bySource['auto']).toBe(false)
  })

  it('停留點非時間欄位變動不觸發 stale', async () => {
    // 依 legs 表的鎖序規約逐列歸零（測試無併發，但規約全專案一體遵守，不留壞範例）
    const { data: allLegs } = await admin.from('legs').select('id').eq('trip_id', tripId).order('id')
    for (const l of allLegs ?? []) await admin.from('legs').update({ stale: false }).eq('id', l.id)
    const { error } = await owner.from('stops').update({ name: '福岡空港' }).eq('id', stopIds[1])
    expect(error).toBeNull()
    const { data } = await owner.from('legs').select('stale').eq('trip_id', tripId)
    expect(data!.every(r => r.stale === false)).toBe(true)
  })

  it('cascade_shift_stops 連鎖平移也會標 stale manual 段（trigger 與 RPC 同交易）', async () => {
    const { error } = await owner.rpc('cascade_shift_stops', {
      p_trip_id: tripId, p_changed_stop_id: stopIds[0], p_delta_seconds: 3600,
    })
    expect(error).toBeNull()
    const { data } = await owner.from('legs').select('source, stale').eq('trip_id', tripId)
    expect(data!.find(r => r.source === 'manual')!.stale).toBe(true)
  })
})
```

- [ ] **Step 5: localhost 護欄回補既有整合測試（原 S-5，審查 M-5 提前至此）** — `rls.test.ts`、`rpc.test.ts`、`constraints.test.ts` 三檔各在模組層加上與 legs.test.ts 完全相同的護欄段（同一標準審查，四檔一致）：

```ts
if (url && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url)) {
  throw new Error('SUPABASE_URL 不是本地位址，拒絕執行整合測試（防止誤打正式環境）')
}
```

- [ ] **Step 6: 跑綠（6 tests）→ 全套 vitest 綠 → Commit** `feat: legs 擴充（flight 模式、起訖欄位、unique 配對、stale trigger）與整合測試 localhost 護欄`

---

### Task 2: 相鄰配對與同步計畫 + 限流（TDD）【出發前必須】

**Files:** Create `src/lib/domain/legSync.ts`、`legSync.test.ts`、`src/lib/domain/rateLimit.ts`、`rateLimit.test.ts`

- [ ] **Step 1: 失敗測試** — Create `src/lib/domain/legSync.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { adjacentPairs, planLegSync, AUTO_TTL_MS, type SyncStop, type SyncLeg } from './legSync'

const H = 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 1, 0)
const stop = (id: string, s: number, e: number): SyncStop =>
  ({ id, lat: 33, lng: 130, startsAt: NOW + s * H, endsAt: NOW + e * H })
const leg = (over: Partial<SyncLeg>): SyncLeg => ({
  id: 'L', fromStopId: 'a', toStopId: 'b', source: 'auto',
  durationMinutes: 10, departsAtMs: NOW + 2 * H, computedAtMs: NOW, stale: false, ...over,
})

describe('adjacentPairs', () => {
  it('按 startsAt 排序取連續配對（不限同日）', () => {
    const pairs = adjacentPairs([stop('b', 3, 4), stop('a', 1, 2), stop('c', 30, 31)])
    expect(pairs.map(([f, t]) => `${f.id}→${t.id}`)).toEqual(['a→b', 'b→c'])
  })
  it('少於兩個停留點回傳空陣列', () => {
    expect(adjacentPairs([stop('a', 1, 2)])).toEqual([])
    expect(adjacentPairs([])).toEqual([])
  })
})

describe('planLegSync', () => {
  const stops = [stop('a', 1, 2), stop('b', 3, 4), stop('c', 5, 6)]

  it('缺 leg 的相鄰配對進 create', () => {
    const plan = planLegSync(stops, [], NOW)
    expect(plan.create).toEqual([
      { fromStopId: 'a', toStopId: 'b' },
      { fromStopId: 'b', toStopId: 'c' },
    ])
  })

  it('配對不再相鄰：auto 段進 removeAuto、manual 段進 markStale', () => {
    const plan = planLegSync(stops, [
      leg({ id: 'L1', fromStopId: 'a', toStopId: 'c' }),
      leg({ id: 'L2', fromStopId: 'c', toStopId: 'a', source: 'manual' }),
    ], NOW)
    expect(plan.removeAuto).toEqual(['L1'])
    expect(plan.markStale).toEqual(['L2'])
  })

  it('已 stale 的 manual 段不重複進 markStale', () => {
    const plan = planLegSync(stops, [leg({ id: 'L2', fromStopId: 'c', toStopId: 'a', source: 'manual', stale: true })], NOW)
    expect(plan.markStale).toEqual([])
  })

  it('auto 段從未計算（computed_at null）進 recompute', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', durationMinutes: null, computedAtMs: null })], NOW)
    expect(plan.recompute).toEqual(['L1'])
  })

  it('no_route 段（duration null 但已計算過）不每次重算，靠 TTL 重試（成本護欄，審查 M-2）', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', durationMinutes: null })], NOW)
    expect(plan.recompute).toEqual([])
  })

  it('auto 段 departs 基準偏離 from.endsAt 進 recompute', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', departsAtMs: NOW + 1 * H })], NOW)
    expect(plan.recompute).toEqual(['L1'])
  })

  it('auto 段 computed_at 超過 30 天 TTL 進 recompute（ToS 分層）', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1', computedAtMs: NOW - AUTO_TTL_MS - 1 })], NOW + 0)
    expect(plan.recompute).toEqual(['L1'])
  })

  it('基準吻合且未過期的 auto 段不動', () => {
    const plan = planLegSync(stops, [leg({ id: 'L1' })], NOW)
    expect(plan).toEqual({ create: [{ fromStopId: 'b', toStopId: 'c' }], removeAuto: [], markStale: [], recompute: [] })
  })

  it('相鄰配對上的 manual 段完全不動（絕不被自動覆蓋）', () => {
    const plan = planLegSync(stops, [
      leg({ id: 'L1', source: 'manual', durationMinutes: null, computedAtMs: NOW - AUTO_TTL_MS * 2 }),
    ], NOW)
    expect(plan.removeAuto).toEqual([])
    expect(plan.markStale).toEqual([])
    expect(plan.recompute).toEqual([])
  })
})
```

- [ ] **Step 2: 跑紅 → Step 3: 實作** — Create `src/lib/domain/legSync.ts`:

```ts
export type SyncStop = { id: string; lat: number; lng: number; startsAt: number; endsAt: number }
export type SyncLeg = {
  id: string
  fromStopId: string
  toStopId: string
  source: 'auto' | 'manual'
  durationMinutes: number | null
  departsAtMs: number | null
  computedAtMs: number | null
  stale: boolean
}
export type LegSyncPlan = {
  create: Array<{ fromStopId: string; toStopId: string }>
  removeAuto: string[]
  markStale: string[]
  recompute: string[]
}

/** auto 段（Google 衍生資料）的 30 天 TTL（spec §4 ToS 分層） */
export const AUTO_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 全行程按 startsAt 排序的連續配對（同刻以 id 決勝求穩定）；跨日配對包含在內（flight 需要） */
export function adjacentPairs<T extends { id: string; startsAt: number }>(stops: T[]): Array<[T, T]> {
  const sorted = [...stops].sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))
  const pairs: Array<[T, T]> = []
  for (let i = 0; i < sorted.length - 1; i++) pairs.push([sorted[i], sorted[i + 1]])
  return pairs
}

/** 比對「應有的相鄰配對」與「現有 legs」，產出同步計畫。純函式，不碰 DB。
 *  規則（spec §4/§6）：manual 段絕不覆蓋/刪除，最多標 stale；auto 段「從未計算、基準偏移、逾 TTL」
 *  三者之一才重算。判準刻意用 computed_at 而非 duration——no_route 段 duration 恆為 null，
 *  若以 duration 判會每次 sync 重打 Google，擊穿成本護欄（審查 M-2）；no_route 靠 TTL 與停留點變動重試。 */
export function planLegSync(stops: SyncStop[], legs: SyncLeg[], nowMs: number): LegSyncPlan {
  const key = (f: string, t: string) => `${f}→${t}`
  const wanted = new Map(adjacentPairs(stops).map(([f, t]) => [key(f.id, t.id), { from: f, to: t }]))
  const plan: LegSyncPlan = { create: [], removeAuto: [], markStale: [], recompute: [] }
  const covered = new Set<string>()

  for (const leg of legs) {
    const pair = wanted.get(key(leg.fromStopId, leg.toStopId))
    if (!pair) {
      if (leg.source === 'auto') plan.removeAuto.push(leg.id)
      else if (!leg.stale) plan.markStale.push(leg.id)
      continue
    }
    covered.add(key(leg.fromStopId, leg.toStopId))
    if (leg.source === 'auto') {
      const neverComputed = leg.computedAtMs === null
      const expired = leg.computedAtMs !== null && nowMs - leg.computedAtMs > AUTO_TTL_MS
      const moved = leg.departsAtMs !== pair.from.endsAt
      if (neverComputed || expired || moved) plan.recompute.push(leg.id)
    }
  }
  for (const [k, pair] of wanted) {
    if (!covered.has(k)) plan.create.push({ fromStopId: pair.from.id, toStopId: pair.to.id })
  }
  return plan
}
```

- [ ] **Step 4: 限流純函式（TDD 同步進行）** — Create `src/lib/domain/rateLimit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { takeToken, type RateWindow } from './rateLimit'

describe('takeToken', () => {
  it('額度內放行並記錄時間戳（不改動輸入）', () => {
    const win: RateWindow = { timestamps: [0] }
    const r = takeToken(win, 1_000, 3, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.window.timestamps).toEqual([0, 1_000])
    expect(win.timestamps).toEqual([0]) // 不可變
  })
  it('額度滿時拒絕', () => {
    const r = takeToken({ timestamps: [0, 1, 2] }, 3, 3, 60_000)
    expect(r.allowed).toBe(false)
  })
  it('視窗外的舊時間戳釋放額度', () => {
    const r = takeToken({ timestamps: [0, 1, 2] }, 60_001, 3, 60_000)
    expect(r.allowed).toBe(true)
  })
})
```

跑紅 → Create `src/lib/domain/rateLimit.ts`:

```ts
export type RateWindow = { timestamps: number[] }

/** 滑動視窗限流：回傳新 window（不改動輸入）。呼叫端自行保存 per-user 狀態。 */
export function takeToken(
  win: RateWindow,
  nowMs: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; window: RateWindow } {
  const kept = win.timestamps.filter(t => nowMs - t < windowMs)
  if (kept.length >= limit) return { allowed: false, window: { timestamps: kept } }
  return { allowed: true, window: { timestamps: [...kept, nowMs] } }
}
```

- [ ] **Step 5: 跑綠（legSync 11 + rateLimit 3）→ 全套綠 → Commit** `feat: 交通段同步計畫與限流純函式`

---

### Task 3: Routes API 請求組裝與回應解析（TDD）【出發前必須】

**Files:** Create `src/lib/google/routes.ts`、`src/lib/google/routes.test.ts`

- [ ] **Step 1: 失敗測試** — Create `src/lib/google/routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  buildComputeRoutesRequest, parseComputeRoutesResponse, clampTransitDeparture,
} from './routes'

const NOW = Date.UTC(2026, 7, 1, 0)
const DAY = 24 * 60 * 60 * 1000
const Q = {
  fromLat: 33.5902, fromLng: 130.4017, toLat: 33.5859, toLng: 130.4201,
  mode: 'transit' as const, departureMs: NOW + DAY,
}

describe('buildComputeRoutesRequest（官方 v2 格式，2026-07-31 查證）', () => {
  it('endpoint、金鑰 header 與必填 FieldMask', () => {
    const r = buildComputeRoutesRequest(Q, 'test-key')
    expect(r.url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes')
    expect(r.headers['X-Goog-Api-Key']).toBe('test-key')
    expect(r.headers['X-Goog-FieldMask']).toBe('routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline')
  })

  it('TRANSIT：latLng 結構 + RFC3339 departureTime；不帶 routingPreference', () => {
    const r = buildComputeRoutesRequest(Q, 'k')
    expect(r.body.origin).toEqual({ location: { latLng: { latitude: Q.fromLat, longitude: Q.fromLng } } })
    expect(r.body.travelMode).toBe('TRANSIT')
    expect(r.body.departureTime).toBe(new Date(Q.departureMs).toISOString())
    expect('routingPreference' in r.body).toBe(false)
  })

  it('DRIVE/WALK：不帶 departureTime（官方：非 TRANSIT 不允許過去時間，且結果與出發時間無關）', () => {
    expect('departureTime' in buildComputeRoutesRequest({ ...Q, mode: 'driving' }, 'k').body).toBe(false)
    expect(buildComputeRoutesRequest({ ...Q, mode: 'walking' }, 'k').body.travelMode).toBe('WALK')
    expect(buildComputeRoutesRequest({ ...Q, mode: 'driving' }, 'k').body.travelMode).toBe('DRIVE')
  })
})

describe('clampTransitDeparture（TRANSIT 允許區間：過去 7 天 ~ 未來 100 天）', () => {
  it('區間內原樣回傳', () => {
    expect(clampTransitDeparture(NOW + DAY, NOW)).toBe(NOW + DAY)
  })
  it('過去超過 7 天夾到下限、未來超過 100 天夾到上限（各留 1 天餘裕）', () => {
    expect(clampTransitDeparture(NOW - 30 * DAY, NOW)).toBe(NOW - 6 * DAY)
    expect(clampTransitDeparture(NOW + 365 * DAY, NOW)).toBe(NOW + 99 * DAY)
  })
})

describe('parseComputeRoutesResponse', () => {
  it('正常回應："165s" 字串轉分鐘（四捨五入、至少 1 分）', () => {
    expect(parseComputeRoutesResponse({
      routes: [{ duration: '165s', distanceMeters: 820, polyline: { encodedPolyline: 'abc' } }],
    })).toEqual({ ok: true, durationMinutes: 3, distanceMeters: 820, polyline: 'abc' })
    expect(parseComputeRoutesResponse({ routes: [{ duration: '10s' }] })).toEqual(
      { ok: true, durationMinutes: 1, distanceMeters: null, polyline: null },
    )
  })
  it('空 routes = 查無路線（官方：無法計算路線時 routes 為空，非 404）', () => {
    expect(parseComputeRoutesResponse({ routes: [] })).toEqual({ ok: false, reason: 'no_route' })
    expect(parseComputeRoutesResponse({})).toEqual({ ok: false, reason: 'no_route' })
  })
  it('duration 格式異常回報 bad_response', () => {
    expect(parseComputeRoutesResponse({ routes: [{ duration: 'oops' }] })).toEqual({ ok: false, reason: 'bad_response' })
    expect(parseComputeRoutesResponse(null)).toEqual({ ok: false, reason: 'bad_response' })
  })
  it('duration 超過 30 天上限（43200 分鐘）視為查無路線（M-4：穩定結論可快取，避免每次重打 Google）', () => {
    expect(parseComputeRoutesResponse({ routes: [{ duration: '2592060s' }] })).toEqual({ ok: false, reason: 'no_route' })
  })
})
```

- [ ] **Step 2: 跑紅 → Step 3: 實作** — Create `src/lib/google/routes.ts`:

```ts
import type { RouteQuery } from '@/lib/domain/cacheKey'

// 官方 v2 文件（2026-07-31 查證）：
// - POST /directions/v2:computeRoutes；金鑰放 X-Goog-Api-Key header
// - X-Goog-FieldMask 必填；不建議萬用字元（延遲）
// - departureTime 僅 TRANSIT 允許過去時間（-7 天 ~ +100 天）；DRIVE/WALK 不帶（帶過去時間會被拒）
// - top-level routingPreference 僅 DRIVE/TWO_WHEELER 可帶，其餘模式帶了直接失敗——一律不帶
// - WALK 為 beta，官方要求對使用者顯示警語（README 收尾補）
const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const FIELD_MASK = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
const TRAVEL_MODE: Record<RouteQuery['mode'], string> = {
  transit: 'TRANSIT',
  walking: 'WALK',
  driving: 'DRIVE',
}
const DAY_MS = 24 * 60 * 60 * 1000
// 30 天份鐘數（R-2）：正常交通時長不可能這麼長，超過視為 Google 回應格式異常（防禦畸形/惡意資料寫進 duration_minutes）
const MAX_DURATION_MINUTES = 30 * 24 * 60

/** TRANSIT 的 departureTime 夾限到官方允許區間（各留 1 天餘裕避開邊界）。
 *  呼叫端以夾限後的值同時組請求與 cache key，兩者永遠一致。 */
export function clampTransitDeparture(departureMs: number, nowMs: number): number {
  return Math.min(Math.max(departureMs, nowMs - 6 * DAY_MS), nowMs + 99 * DAY_MS)
}

export type ComputeRoutesRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 組 computeRoutes 請求（純函式；departureMs 需已夾限）。 */
export function buildComputeRoutesRequest(q: RouteQuery, apiKey: string): ComputeRoutesRequest {
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: q.fromLat, longitude: q.fromLng } } },
    destination: { location: { latLng: { latitude: q.toLat, longitude: q.toLng } } },
    travelMode: TRAVEL_MODE[q.mode],
  }
  if (q.mode === 'transit') body.departureTime = new Date(q.departureMs).toISOString()
  return {
    url: ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body,
  }
}

export type ComputedRoute =
  | { ok: true; durationMinutes: number; distanceMeters: number | null; polyline: string | null }
  | { ok: false; reason: 'no_route' | 'bad_response' }

/** 解析 computeRoutes 回應（純函式）。routes 為空 = 查無路線（官方行為，非 404）。 */
export function parseComputeRoutesResponse(json: unknown): ComputedRoute {
  if (typeof json !== 'object' || json === null) return { ok: false, reason: 'bad_response' }
  const routes = (json as { routes?: unknown }).routes
  if (!Array.isArray(routes) || routes.length === 0) return { ok: false, reason: 'no_route' }
  const route = routes[0] as { duration?: unknown; distanceMeters?: unknown; polyline?: { encodedPolyline?: unknown } }
  const m = typeof route.duration === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(route.duration) : null
  if (!m) return { ok: false, reason: 'bad_response' }
  const durationMinutes = Math.max(1, Math.round(Number(m[1]) / 60))
  // M-4：改回 no_route（穩定結論可快取）——bad_response 在 sync 端點被視為暫時性異常不進 route_cache，
  // 會讓這種畸形回應每次 sync 都重打 Google；異常值本身是穩定的（同一段路線不會忽大忽小），值得快取
  if (durationMinutes > MAX_DURATION_MINUTES) return { ok: false, reason: 'no_route' }
  return {
    ok: true,
    durationMinutes,
    distanceMeters: typeof route.distanceMeters === 'number' ? route.distanceMeters : null,
    polyline: typeof route.polyline?.encodedPolyline === 'string' ? route.polyline.encodedPolyline : null,
  }
}
```

- [ ] **Step 4: 跑綠（9 tests，含 durationMinutes 上限案例：R-2 加入、M-4 改判為 no_route）→ 全套綠 → Commit** `feat: Routes API 請求組裝與回應解析（官方 v2 格式查證）`

---

### Task 4: 交通段同步端點【出發前必須】

**Files:** Create `src/app/api/trips/[tripId]/legs/sync/route.ts`、`src/lib/supabase/service.ts`；Modify `.env.example`

- [ ] **Step 0: 環境設定（一次性，需使用者 GCP 操作）** —
  1. Routes API 已啟用（已確認）。**瀏覽器金鑰（referrer 限制）不能用於 server 呼叫**：在 GCP 另建一把金鑰，「應用程式限制：無」（或 IP 限制）、「API 限制：Routes API」。
  2. `.env.local` 補兩行（server-only，無 `NEXT_PUBLIC_` 前綴、不進 client bundle）：`GOOGLE_MAPS_SERVER_API_KEY=<新金鑰>`、`SUPABASE_SERVICE_ROLE_KEY=<supabase status 的 service_role key>`。
  3. `.env.example` 同步補註解說明兩個新變數。

- [ ] **Step 1: service client** — `npm install server-only`（官方 server-only 保險絲：被 client component 誤 import 時直接編譯失敗），Create `src/lib/supabase/service.ts`:

```ts
import 'server-only'
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

/** server-only：service role 客戶端，僅供 route_cache 等伺服器資料表使用。
 *  絕不可 import 進 client component（金鑰不落 client 是本層存在的理由）。
 *  未設定時回傳 null，呼叫端降級（跳過快取），不擋主流程。 */
export function createServiceClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createSupabaseClient<Database>(url, key, { auth: { persistSession: false } })
}
```

- [ ] **Step 2: sync 端點** — Create `src/app/api/trips/[tripId]/legs/sync/route.ts`（Next 16 route handler：`params` 是 Promise，需 await——與 page.tsx 同慣例，已讀 `node_modules/next/dist/docs/.../route.md` 確認）：

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { planLegSync, type SyncStop, type SyncLeg } from '@/lib/domain/legSync'
import { buildRouteCacheKey, type RouteQuery } from '@/lib/domain/cacheKey'
import {
  buildComputeRoutesRequest, parseComputeRoutesResponse, clampTransitDeparture,
} from '@/lib/google/routes'
import { takeToken, type RateWindow } from '@/lib/domain/rateLimit'

// 逾時保護（審查 M-6）：Vercel function 上限 30 秒，與單次 fetch 5 秒 timeout、每次 sync 最多
// MAX_GOOGLE_CALLS_PER_SYNC 段的分批機制相配合——超出的段以既有 pending 語義留待下次 sync
export const maxDuration = 30

// 成本護欄（spec §6）：每使用者每分鐘最多 30 次 Google 呼叫（快取命中不計）。
// 已知限制：模組層記憶體在 serverless 平台為每實例獨立，護欄弱化——記入 spec §8，商用前換集中式限流。
const GOOGLE_CALL_LIMIT = 30
const RATE_WINDOW_MS = 60_000
const MAX_GOOGLE_CALLS_PER_SYNC = 5 // 額外上限（次要護欄）：即使牆鐘預算未耗盡，單次 sync 最多打 5 次 Google——
                                     // 真正的逾時防線是下方 WALL_CLOCK_BUDGET_MS（審查 I-1）；未算完的段留 pending 下次補
const FETCH_TIMEOUT_MS = 5_000
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // route_cache TTL（Google ToS 上限）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const rateWindows = new Map<string, RateWindow>()

type AutoMode = RouteQuery['mode']
const AUTO_MODES: ReadonlyArray<string> = ['transit', 'walking', 'driving']

export async function POST(_req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  if (!UUID_RE.test(tripId)) return NextResponse.json({ error: 'invalid trip id' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: isEditor } = await supabase.rpc('is_trip_editor', { p_trip_id: tripId })
  if (!isEditor) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // 讀現況（user client：RLS 生效）。兩查詢互不依賴，平行送出（審查 S-1）。
  const [{ data: stopRows, error: stopsErr }, { data: legRows, error: legsErr }] = await Promise.all([
    supabase
      .from('stops')
      .select('id, lat, lng, starts_at, ends_at')
      .eq('trip_id', tripId)
      .order('starts_at')
      .limit(501), // 501 = 500 護欄 + 1 哨兵，藉此偵測「剛好卡在上限」與「真的超過上限」的差異（審查 I-2）
    supabase
      .from('legs')
      .select('id, from_stop_id, to_stop_id, mode, source, duration_minutes, departs_at, computed_at, stale')
      .eq('trip_id', tripId)
      .order('id')
      .limit(501),
  ])
  if (stopsErr || legsErr) {
    if (stopsErr) console.error('[legs/sync] stops read failed', { tripId, code: stopsErr.code, message: stopsErr.message })
    if (legsErr) console.error('[legs/sync] legs read failed', { tripId, code: legsErr.code, message: legsErr.message })
    return NextResponse.json({ error: 'read failed' }, { status: 500 })
  }
  // 哨兵命中（審查 I-2）：行程規模超出同步上限，拒絕處理而非悄悄截斷資料造成配對錯亂
  if ((stopRows?.length ?? 0) > 500 || (legRows?.length ?? 0) > 500) {
    return NextResponse.json({ error: 'trip too large to sync' }, { status: 413 })
  }

  // 牆鐘預算（審查 I-1，R-1 前移）：從 413 閘門之後就起算，讓預算涵蓋下面的結構同步
  // （markStale/removeAuto/create）與計算迴圈——結構同步同樣是逐列 DB 往返，段數多時
  // 一樣可能撞穿 maxDuration=30s；與 maxDuration 留 6s 餘裕給收尾往返與回應序列化。
  const startedAt = Date.now()
  const WALL_CLOCK_BUDGET_MS = 24_000
  const budgetExceeded = () => Date.now() - startedAt > WALL_CLOCK_BUDGET_MS

  const now = Date.now()
  const stops: SyncStop[] = (stopRows ?? []).map(s => ({
    id: s.id, lat: s.lat, lng: s.lng,
    startsAt: new Date(s.starts_at).getTime(), endsAt: new Date(s.ends_at).getTime(),
  }))
  const legs: SyncLeg[] = (legRows ?? []).map(l => ({
    id: l.id, fromStopId: l.from_stop_id, toStopId: l.to_stop_id,
    source: l.source as SyncLeg['source'],
    durationMinutes: l.duration_minutes,
    departsAtMs: l.departs_at ? new Date(l.departs_at).getTime() : null,
    computedAtMs: l.computed_at ? new Date(l.computed_at).getTime() : null,
    stale: l.stale,
  }))
  const plan = planLegSync(stops, legs, now)

  // 結構同步——一律逐列寫入（legs 表註解的鎖序規約），user client（RLS editor 生效）。
  // 【審查 C-1 強制要求】計算對象在寫入成功「當下」連同起訖與模式一起入列 computeQueue，
  // 計算迴圈只讀 queue——絕不用兩個平行陣列的索引對應（insert 失敗靜默略過後索引錯位，
  // 會把路線寫進錯的段）。
  type ComputeItem = { legId: string; fromStopId: string; toStopId: string; mode: string }
  const computeQueue: ComputeItem[] = []
  let changed = false
  let pending = 0
  // incomplete（I-3）：任一迴圈因牆鐘預算中斷即 true，client 據此判斷是否該排下一輪續跑
  let incomplete = false
  // legCount（C-1）：sync 後該 trip 的 leg 數，用結構同步已知的異動量算，不多打一次 DB。
  // 初始值＝client 讀到的舊快照筆數，removeAuto 成功才減、create 成功「或」23505（列已存在）才加。
  let removedCount = 0
  let createdCount = 0

  // R-1：三個結構同步迴圈各自逐項檢查牆鐘預算，段數多時不讓結構同步本身撞穿 maxDuration。
  // markStale/removeAuto 中斷時剩餘項單純留給下次 sync 的結構同步重新判定（它們是「還沒改」，
  // 不是「還沒算」，語義上不算 pending——與這兩迴圈個別寫入失敗時只記 log 不記 pending 一致）。
  for (const id of plan.markStale) {
    if (budgetExceeded()) { incomplete = true; break }
    const { error } = await supabase.from('legs').update({ stale: true }).eq('id', id)
    if (!error) changed = true
    else console.error('[legs/sync] markStale failed', { tripId, code: error.code, message: error.message })
  }
  for (const id of plan.removeAuto) {
    if (budgetExceeded()) { incomplete = true; break }
    // 審查 Critical-1：snapshot 讀取後到這行之間，該段可能已被 LegEditor 改成 manual——
    // 加 .eq('source', 'auto') 讓刪除在 DB 層原子化重新確認，0 列＝已被搶先改 manual，不算變化
    const { data, error } = await supabase.from('legs').delete().eq('id', id).eq('source', 'auto').select('id')
    if (!error) { if ((data ?? []).length > 0) { changed = true; removedCount++ } }
    else console.error('[legs/sync] removeAuto failed', { tripId, code: error.code, message: error.message })
  }
  for (let i = 0; i < plan.create.length; i++) {
    if (budgetExceeded()) {
      // R-1：剩餘配對不建列、不入 computeQueue（下次 sync 的結構同步會重新判定為 create）。
      // 仍計入 pending——這些配對遲早要建 leg 並算 duration，牆鐘用盡而「還沒建」跟計算迴圈
      // 牆鐘用盡而「還沒算」是同一種「還沒完成」，語義上都算未完工作，pending 才如實反映總量。
      pending += plan.create.length - i
      incomplete = true
      break
    }
    const c = plan.create[i]
    const { data, error } = await supabase
      .from('legs')
      .insert({ trip_id: tripId, from_stop_id: c.fromStopId, to_stop_id: c.toStopId, mode: 'transit', source: 'auto' })
      .select('id')
      .single()
    if (!error && data) {
      changed = true
      createdCount++
      computeQueue.push({ legId: data.id, fromStopId: c.fromStopId, toStopId: c.toStopId, mode: 'transit' })
    } else if (error && error.code === '23505') {
      // C-1：併發同開時撞 unique，列已存在但不在這個 client 的快照裡——對 client 仍是一筆變化，
      // 需回報 changed 才會 refresh；該列目前狀態未知（可能已算完也可能還沒），保守計入 pending，
      // 但不入 computeQueue（不知道它的 from/to/mode 是否與本地 plan 假設一致，交還下次 sync 判定）
      changed = true
      createdCount++
      pending++
    } else if (error) {
      console.error('[legs/sync] create leg failed', { tripId, code: error.code, message: error.message })
    }
  }
  const legMetaById = new Map((legRows ?? []).map(l => [l.id, l]))
  for (const legId of plan.recompute) {
    const meta = legMetaById.get(legId)
    if (meta) computeQueue.push({ legId, fromStopId: meta.from_stop_id, toStopId: meta.to_stop_id, mode: meta.mode })
  }
  const legCount = (legRows?.length ?? 0) - removedCount + createdCount

  const stopById = new Map(stops.map(s => [s.id, s]))
  const service = createServiceClient()
  const apiKey = process.env.GOOGLE_MAPS_SERVER_API_KEY
  let computed = 0
  let googleCalls = 0

  // 有界過期清理（審查 M-7）：每次 sync 順手刪最多 50 列逾期快取（fetched_at 已建索引），表不無限成長
  if (service) {
    const cutoff = new Date(now - CACHE_TTL_MS).toISOString()
    const { data: expiredRows } = await service
      .from('route_cache').select('cache_key').lt('fetched_at', cutoff).order('fetched_at').limit(50)
    const keys = (expiredRows ?? []).map(r => r.cache_key)
    if (keys.length > 0) await service.from('route_cache').delete().in('cache_key', keys)
  }
  // 記憶體衛生：清掉整窗過期的使用者條目，rateWindows 不隨歷史使用者數無限成長
  for (const [k, w] of rateWindows) {
    if (w.timestamps.every(t => now - t >= RATE_WINDOW_MS)) rateWindows.delete(k)
  }

  for (let i = 0; i < computeQueue.length; i++) {
    if (budgetExceeded()) {
      // 牆鐘預算耗盡（審查 I-1）：剩餘段一律留 pending，絕不讓迴圈把 maxDuration 撞穿
      pending += computeQueue.length - i
      incomplete = true
      break
    }
    const item = computeQueue[i]
    const from = stopById.get(item.fromStopId)
    const to = stopById.get(item.toStopId)
    if (!from || !to || !AUTO_MODES.includes(item.mode)) {
      pending++ // flight/custom 等非自動模式段本就不會被算，但仍需計入 pending（審查 M-2）
      continue
    }

    if (!apiKey) {
      pending++ // 無伺服器金鑰：leg 維持待計算（外部失敗不阻擋編輯，spec §6）
      continue
    }
    const departureMs = item.mode === 'transit' ? clampTransitDeparture(from.endsAt, now) : 0 // 非 transit 結果與出發時間無關，固定桶提高快取命中
    const query: RouteQuery = {
      fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng,
      mode: item.mode as AutoMode, departureMs,
    }
    const cacheKey = buildRouteCacheKey(query)

    // 快取（service client；未設定時跳過快取直接計算）
    let result: ReturnType<typeof parseComputeRoutesResponse> | null = null
    if (service) {
      const { data: hit } = await service.from('route_cache').select('result, fetched_at').eq('cache_key', cacheKey).maybeSingle()
      if (hit && now - new Date(hit.fetched_at).getTime() <= CACHE_TTL_MS) {
        // 輕量驗形（審查 M-4）：快取列可能因手動改壞 / 未來欄位變更而毀損；不驗形直接信任會讓非法
        // durationMinutes 流入下方 new Date(...) 運算炸出 Invalid time value，殃及整個 handler。
        // 不合格視為 miss，落入下方重算分支，不特別記錄（快取毀損不是呼叫方的錯，重算即自癒）。
        const candidate = hit.result as { ok?: unknown; durationMinutes?: unknown }
        const validShape = typeof candidate.ok === 'boolean' &&
          (candidate.ok === false || (Number.isInteger(candidate.durationMinutes) && (candidate.durationMinutes as number) > 0))
        if (validShape) result = hit.result as ReturnType<typeof parseComputeRoutesResponse>
      }
    }
    if (!result) {
      if (googleCalls >= MAX_GOOGLE_CALLS_PER_SYNC) {
        pending++
        continue // 分批（M-6）：本次額度用完，其餘留待下次 sync
      }
      const win = rateWindows.get(user.id) ?? { timestamps: [] }
      const take = takeToken(win, now, GOOGLE_CALL_LIMIT, RATE_WINDOW_MS)
      rateWindows.set(user.id, take.window)
      if (!take.allowed) {
        pending++
        continue // 超限：留待下次 sync，絕不 500
      }
      googleCalls++
      try {
        const req = buildComputeRoutesRequest(query, apiKey)
        const res = await fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // 單段逾時（M-6），與 maxDuration/分批相配合
        })
        if (!res.ok) {
          pending++ // Google 4xx/5xx：leg 維持待計算可重試（錯誤格式 {error:{code,message,status}}，不透傳細節給 client）
          continue
        }
        result = parseComputeRoutesResponse(await res.json())
      } catch {
        pending++
        continue // 網路失敗/逾時同上
      }
      // 只快取 ok 與 no_route（穩定結論）；bad_response 屬暫時性異常，快取 30 天會毒化該路段
      if (service && result && !(result.ok === false && result.reason === 'bad_response')) {
        await service.from('route_cache').upsert({ cache_key: cacheKey, result, fetched_at: new Date(now).toISOString() })
      }
    }

    if (result.ok) {
      // 審查 Critical-1：Google 呼叫期間（可長達數秒）該段可能已被 LegEditor 改成 manual，
      // .eq('source', 'auto') 讓寫回在 DB 層原子化重新確認，絕不能用「呼叫前讀到的 mode/source」
      // 這種 check-then-act 判斷，那道間隙正是 PoC 復現的缺口
      const { data, error } = await supabase.from('legs').update({
        duration_minutes: result.durationMinutes,
        distance_meters: result.distanceMeters,
        polyline: result.polyline,
        detail: null,
        departs_at: new Date(from.endsAt).toISOString(),
        arrives_at: new Date(from.endsAt + result.durationMinutes * 60_000).toISOString(),
        computed_at: new Date(now).toISOString(),
        stale: false,
      }).eq('id', item.legId).eq('source', 'auto').select('id')
      if (!error) {
        // 0 列＝寫回瞬間已被改成 manual，這段已完工換人負責，不計 computed 也不計 pending
        if ((data ?? []).length > 0) {
          computed++
          changed = true
        }
      } else {
        pending++ // R-3：寫回失敗，leg 仍未真正算完，須計入 pending 才可重試（原本漏記，此段會悄悄消失於統計外）
        console.error('[legs/sync] update computed leg failed', { tripId, code: error.code, message: error.message })
      }
    } else if (result.reason === 'no_route') {
      const { data, error } = await supabase.from('legs').update({
        duration_minutes: null, distance_meters: null, polyline: null,
        detail: { no_route: true },
        departs_at: new Date(from.endsAt).toISOString(), arrives_at: null,
        computed_at: new Date(now).toISOString(), stale: false,
      }).eq('id', item.legId).eq('source', 'auto').select('id')
      if (!error) {
        // 同上：0 列＝已被改成 manual，不算變化也不計 pending（Critical-1 source 守衛）
        if ((data ?? []).length > 0) changed = true
      } else {
        pending++ // M-2：與 R-3 同一種漏記——寫回失敗，leg 仍未真正算完，須計入 pending 才可重試
        console.error('[legs/sync] update no_route leg failed', { tripId, code: error.code, message: error.message })
      }
    } else {
      pending++
    }
  }

  return NextResponse.json({ ok: true, changed, computed, pending, legCount, incomplete })
}
```

（Task 6 審查 Critical-1：`legRows` 讀取那一刻到 Google 呼叫完成寫回之間有數秒的競態窗口，若使用者剛好在這段時間用 LegEditor 把段改成 manual，修復前的 `.eq('id', ...)` 寫法會照樣把 Google 算出的 auto 資料蓋上去——manual 段因此被夾帶 Google 衍生資料且使用者剛存的值消失，違反 spec §4 的 ToS 分層與「manual 絕不被覆蓋」承諾。修復：`removeAuto` 刪除與兩個寫回分支都加 `.eq('source', 'auto').select('id')`，讓「重新確認 source 沒變」與「寫入」在同一條 SQL 內原子化完成；回傳 0 列即代表已被搶先改 manual，此時不計 `computed`、不計 `pending`（語義上這段已完工換人負責），`removedCount` 同步只在真的刪除成功時累加。PoC 於本機以「先把段改 manual，再套用寫回前 / 後兩種寫法」對照驗證：舊寫法 1 列受影響且 manual 值被蓋掉；新寫法 0 列受影響、manual 值與 `polyline` 均完好。）

- [ ] **Step 3: 驗證** — lint / tsc / build 綠；Playwright 走真實登入取得 session cookie，curl 打端點驗證 401（無 cookie）/400（無效 UUID）/403（非成員）/200 降級（無 `GOOGLE_MAPS_SERVER_API_KEY` 時回 `{ ok: true, pending: N }` 不報錯，且冪等）/413（超過 500 筆哨兵）五條路徑；DB 直查確認 leg 結構性建立但 `computed_at` 為 null（未產生假資料）。真 Google 呼叫（`computed>0`、快取命中、`no_route`/`bad_response`、rate-limit 觸發）留待金鑰就位後驗證。→ **Commit** `feat: 交通段同步端點（Routes 代理、route_cache、限流、ToS TTL）` + 審查加固 `fix: sync 端點加固（牆鐘預算、limit 哨兵、吞錯日誌、快取驗形）` + 複審遺留 `fix: sync 牆鐘涵蓋結構同步、duration 上限、寫回失敗計數` + Task 5 審查 `fix: 前端接線加固（併發可見性、連接條死區、sync 去重與續跑）`（route.ts 部分：23505 分支改回報 changed/pending、回應加 legCount/incomplete、no_route 寫回失敗補 pending++）+ Task 6 審查 `fix: 交通段寫回 source 守衛與編輯器樂觀鎖（manual 覆寫保護）`（route.ts 部分：Critical-1 source 守衛，見上）

---

### Task 5: 前端資料流與交通段呈現【出發前必須】

**Files:** Modify `src/app/trips/[tripId]/page.tsx`、`TripView.tsx`、`Timeline.tsx`；Create `legUi.ts`

- [ ] **Step 1: page.tsx 讀 legs** — stops 查詢後追加：

```tsx
  const { data: legs, error: legsError } = await supabase
    .from('legs')
    .select('id, from_stop_id, to_stop_id, mode, duration_minutes, distance_meters, polyline, detail, source, stale, departs_at, arrives_at, estimated_cost, updated_at')
    .eq('trip_id', tripId)
    .order('id', { ascending: true })
    .limit(500)
```

（M-3：`.order('id')` 與 stops 查詢的排序慣例對齊；曾一度誤用 `.limit(501)` 比照 sync route.ts 的哨兵慣例，經複審指出這裡是單純分頁讀取非結構同步護欄，501 那套語義不適用，M-3 回退為 500。`updated_at` 欄位為 Task 6 審查 Important-2/3 追加——LegEditor 的樂觀鎖需要它比對外部改動，見 Task 6 Step 4。）

`<TripView ... legs={(legs ?? []) as Leg[]} />`（page.tsx 補 `import type { Leg } from './TripView'`）。**M-3 定案**：DB 的 `mode`/`source` 是 text 欄位，聯集型別的收斂就在這個邊界以 `as Leg[]` 做一次——值域由 DB check constraint 保證，不引 zod、不逐欄位轉換，其他地方一律不再 cast。legsError 併入現有 stopsError 橫幅語義（讀取失敗提示 + 寫入入口不關閉——legs 讀失敗不影響 stops 編輯，僅交通列缺席，如實顯示「交通段讀取失敗」）。

- [ ] **Step 2: 共用 UI 表** — Create `src/app/trips/[tripId]/legUi.ts`:

```ts
import type { Leg } from './TripView'

export const MODE_ICON: Record<Leg['mode'], string> = {
  transit: '🚇', walking: '🚶', driving: '🚗', flight: '✈️', custom: '✏️',
}
export const MODE_LABEL: Record<Leg['mode'], string> = {
  transit: '大眾運輸', walking: '步行', driving: '開車', flight: '航班', custom: '自訂',
}
/** sync 寫入的查無路線標記（spec §6：查無路線 → 引導手動填寫） */
export function isNoRoute(leg: Leg): boolean {
  return typeof leg.detail === 'object' && leg.detail !== null && (leg.detail as { no_route?: boolean }).no_route === true
}
/** 連接條/側欄的時長文案 */
export function legDurationText(leg: Leg): string {
  if (leg.duration_minutes !== null) return `${leg.duration_minutes} 分`
  return isNoRoute(leg) ? '查無路線' : '待計算'
}
```

- [ ] **Step 3: TripView 接線** —

1. 型別與 props：

```tsx
export type Leg = {
  id: string
  from_stop_id: string
  to_stop_id: string
  mode: 'transit' | 'walking' | 'driving' | 'flight' | 'custom'
  duration_minutes: number | null
  distance_meters: number | null
  polyline: string | null
  detail: unknown
  source: 'auto' | 'manual'
  stale: boolean
  departs_at: string | null
  arrives_at: string | null
  estimated_cost: number | null
  updated_at: string
}
```

（`updated_at` 為 Task 6 審查 Important-2/3 追加，理由同上。）

props 增 `legs: Leg[]`；狀態增 `const [selectedLegId, setSelectedLegId] = useState<string | null>(null)`（`changeDay` 一併歸 null）。

2. sync 觸發（掛載一次 + 每次寫入成功後）：

```tsx
  const syncedRef = useRef(false)
  const syncInFlightRef = useRef(false) // I-2：同時只跑一個 in-flight sync 請求
  const syncQueuedRef = useRef(false) // I-2：in-flight 期間又有新觸發，併成一次補跑（不逐一排隊）
  const syncRoundRef = useRef(0) // I-3：續跑回合數，使用者觸發的全新 sync 會歸零，只有續跑本身遞增
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // I-3：續跑計時器
  const syncNoticeShownRef = useRef(false) // S-1：連線失敗提示只跳一次，避免每輪續跑都打擾使用者
  useEffect(() => {
    if (syncedRef.current) return
    syncedRef.current = true
    void syncLegs()
    return () => {
      // I-3：unmount 時清掉排隊中的續跑計時器，避免對已卸載的元件觸發後續 setState
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
    // 只在掛載時觸發一次；syncLegs 透過 closure 讀最新 props/state，不需要讓這個 effect
    // 隨依賴重跑（M-5）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 交通段同步：結構比對 + 自動計算都在 server（金鑰不落 client）。
  // 失敗靜默：外部服務失敗不能阻止編輯（spec §6），下次寫入或重新整理會再試（HTTP 非 2xx 例外，S-1 跳一次提示）。
  // isRetry=true 代表這是 I-3 排程的續跑，不重置回合額度；使用者操作觸發的呼叫一律 isRetry=false（全新額度）。
  async function syncLegs(isRetry = false) {
    if (syncInFlightRef.current) {
      syncQueuedRef.current = true // I-2：coalescing——已有請求在跑，這次觸發併入下一次補跑
      return
    }
    if (!isRetry) syncRoundRef.current = 0
    syncInFlightRef.current = true
    try {
      const res = await fetch(`/api/trips/${trip.id}/legs/sync`, { method: 'POST' })
      if (!res.ok) {
        if (!syncNoticeShownRef.current) {
          syncNoticeShownRef.current = true
          setNotice({ kind: 'error', text: '交通段暫時無法計算' }) // S-1
        }
        return
      }
      const j: { changed?: boolean; legCount?: number; pending?: number; incomplete?: boolean } = await res.json()
      // C-1：legCount 對不上目前 props 拿到的 legs 筆數，即使這次 sync 自己沒有結構異動
      // （changed=false）也代表 client 的快照落後於 DB（例如併發 sync 已建立該 leg），一樣要 refresh
      if (j.changed || j.legCount !== legs.length) router.refresh()
      if ((j.pending ?? 0) > 0 || j.incomplete) {
        if (syncRoundRef.current < MAX_SYNC_ROUNDS) {
          syncRoundRef.current += 1
          syncTimerRef.current = setTimeout(() => void syncLegs(true), SYNC_RETRY_MS) // I-3：續跑
        }
      }
    } catch {
      // 網路失敗：交通段維持現狀，不打擾使用者
    } finally {
      syncInFlightRef.current = false
      if (syncQueuedRef.current) {
        syncQueuedRef.current = false
        // 補跑取代任何已排的續跑計時器，避免同時有兩條路徑各自觸發下一次 syncLegs
        if (syncTimerRef.current) {
          clearTimeout(syncTimerRef.current)
          syncTimerRef.current = null
        }
        void syncLegs() // 視為新一輪使用者觸發，回合額度重置
      }
    }
  }
```

`SYNC_RETRY_MS = 1_500`、`MAX_SYNC_ROUNDS = 6` 定義在模組層（與 `FALLBACK_CENTER`/`PLAY_STEP_MS` 同層）。

`addStop` 成功（`router.refresh()` 前）、`moveStop` 成功、StopEditor 儲存/刪除後各補 `void syncLegs()`。StopEditor 增可選 prop `onChanged?: () => void`（save 與 remove 成功後呼叫），TripView 傳 `onChanged={() => void syncLegs()}`。

3. imports（TripView.tsx 新增；`Fragment` 併入既有 react import）：

```tsx
import { Fragment, useEffect, useRef, useState } from 'react'
import { MODE_ICON, legDurationText } from './legUi'
import { adjacentPairs } from '@/lib/domain/legSync'
```

4. **leg 歸屬規則（審查 M-4 定案）**：leg 顯示在「from 停留點所屬日」。後繼者取**全行程順序**（不是當日順序），跨夜段因此顯示在出發日末尾、標註去向：

```tsx
  // leg 歸屬「from 停留點所屬日」：後繼者取全行程順序，跨夜段顯示在出發日末尾（M-4）
  // 用 globalThis.Map：本檔已從 @vis.gl/react-google-maps import 了元件 Map，會遮蔽內建建構子
  const nextByStopId = new globalThis.Map(
    adjacentPairs(stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime() })))
      .map(([f, t]) => [f.id, t.id]),
  )
  const stopById = new globalThis.Map(stops.map(s => [s.id, s]))
  const legByPair = new globalThis.Map(legs.map(l => [`${l.from_stop_id}→${l.to_stop_id}`, l]))
```

（實作時發現：TripView.tsx 已從 `@vis.gl/react-google-maps` import 元件 `Map` 用於渲染地圖，會遮蔽內建 `Map` 建構子，`new Map(...)` 會被 tsc 判為呼叫該 React 元件而非建構子（TS7009/TS2559）。改用 `new globalThis.Map(...)`；Timeline.tsx 無此 import 衝突，維持 `new Map(...)` 不變。）

5. 側欄交通列——`activeDayStops.map` 的 li 改用 `<Fragment>` 包裹：**既有停留點卡片（TripView.tsx:286-313）整段原樣搬入，唯一改動是 `key={stop.id}` 從 `<li>` 移到 `<Fragment>`（React 的 list key 必須在最外層元素），li 本身不再帶 key**；卡片之後渲染交通列 li：

```tsx
            {activeDayStops.map((stop, i) => {
              const next = stopById.get(nextByStopId.get(stop.id) ?? '')
              const leg = next ? legByPair.get(`${stop.id}→${next.id}`) : undefined
              const crossDay = Boolean(next && !activeDayStops.some(s => s.id === next.id))
              return (
                <Fragment key={stop.id}>
                  <li className="rounded border p-2 …">{/* TripView.tsx:286-313 原內容，含編號 i+1 與 StopEditor */}</li>
                  {leg && next && (
                    <li className="pl-5 text-xs">
                      <button
                        type="button"
                        aria-pressed={selectedLegId === leg.id}
                        className={`cursor-pointer ${selectedLegId === leg.id ? 'font-medium text-blue-600' : 'text-gray-500'}`}
                        onClick={() => setSelectedLegId(selectedLegId === leg.id ? null : leg.id)}
                      >
                        {MODE_ICON[leg.mode]} {legDurationText(leg)}
                        {leg.estimated_cost !== null && ` · ${trip.currency} ${leg.estimated_cost}`}
                        {crossDay && ` → ${localDateKey(new Date(next.starts_at).getTime(), next.timezone).slice(5)} ${next.name}`}
                        {leg.stale && ' ⚠️ 前後行程變動過，可能過期'}
                      </button>
                      {selectedLegId === leg.id && (
                        <p className="text-gray-400">編輯器 Task 6 接入</p>
                      )}
                    </li>
                  )}
                </Fragment>
              )
            })}
```

（本 Task 只渲染交通列與選取，占位 `<p>` 在 Task 6 換成 `<LegEditor>`——本 Task 不引用尚不存在的元件。`aria-pressed`＝S-5；跨日文案原示「→ 隔日 名稱」經複審 M-1 改為實際日期「→ MM-DD 名稱」，可讀性更高。）

6. Timeline 掛載處補 `legs={legs}`、`selectedLegId={selectedLegId}`、`onSelectLeg={setSelectedLegId}`。

- [ ] **Step 4: Timeline 連接條 + conflicts 接真 legs** —

imports（Timeline.tsx 新增）：

```tsx
import { adjacentPairs } from '@/lib/domain/legSync'
import { MODE_ICON, MODE_LABEL, legDurationText } from './legUi'
import type { Leg } from './TripView'
```

props 增 `legs: Leg[]; selectedLegId: string | null; onSelectLeg: (id: string | null) => void`。元件內（同 M-4 歸屬規則：以「from 停留點在當日」取 leg，後繼者可跨日）：

```tsx
  const nextByStopId = new Map(
    adjacentPairs(stops.map(s => ({ id: s.id, startsAt: new Date(s.starts_at).getTime() })))
      .map(([f, t]) => [f.id, t.id]),
  )
  const stopById = new Map(stops.map(s => [s.id, s]))
  const legByPair = new Map(legs.map(l => [`${l.from_stop_id}→${l.to_stop_id}`, l]))
  const dayLegs = dayStops
    .map(s => {
      const next = stopById.get(nextByStopId.get(s.id) ?? '')
      const leg = next ? legByPair.get(`${s.id}→${next.id}`) : undefined
      return next && leg ? { from: s, to: next, leg } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
```

`detectConflicts` 的第二參數從 `[]` 改為真 legs（Plan 3 預留孔位正式接上，警示語義不變——警示不阻擋）。跨夜 leg 傳入無害：detectConflicts 只對「當日排序後相鄰」的配對查 leg，跨日的 to 停留點不在 dayStops 內，天然不匹配（跨夜尾段不涵蓋於當日衝突偵測，維持 spec §8 既有記載）：

```tsx
    dayLegs
      .filter(x => x.leg.duration_minutes !== null)
      .map(x => ({ fromStopId: x.from.id, toStopId: x.to.id, durationMinutes: x.leg.duration_minutes! })),
```

```tsx
  const tightPairs = new Set(
    warnings.filter(w => w.type === 'transit_too_tight').map(w => `${w.fromStopId}→${w.toStopId}`),
  )
```

軌道 div 內、色塊之後、播放頭之前，渲染連接條（占據兩色塊間的空檔區間；重疊配對不畫——重疊已由紅色色塊警示；跨夜段右端夾到視窗尾，顯示在出發日末尾）：

```tsx
            {dayLegs.map(({ from, to, leg }) => {
              const gs = new Date(from.ends_at).getTime()
              const ge = Math.min(new Date(to.starts_at).getTime(), win.end) // 跨夜段夾到視窗尾（M-4）
              if (ge <= gs) return null
              const tight = tightPairs.has(`${from.id}→${to.id}`)
              const leftPct = pct(gs)
              const rawWidthPct = pct(ge) - leftPct
              // I-1：視覺最小寬度撐寬到 2%，但右緣不可超過軌道（100%），空檔越接近視窗尾越明顯
              const widthPct = Math.min(Math.max(rawWidthPct, 2), 100 - leftPct)
              // I-1：被撐寬出來的死區不該搶走點擊——選取一律走側欄交通列，連接條在此僅供顯示
              const isDeadZone = rawWidthPct < 2
              return (
                <button
                  key={leg.id}
                  type="button"
                  data-leg-connector={leg.id}
                  tabIndex={-1}
                  onClick={() => onSelectLeg(selectedLegId === leg.id ? null : leg.id)}
                  title={`${MODE_LABEL[leg.mode]} ${legDurationText(leg)}`}
                  className={`absolute top-1/2 z-10 -translate-y-1/2 overflow-hidden whitespace-nowrap rounded text-center text-[10px] leading-tight ${
                    isDeadZone ? 'pointer-events-none' : ''
                  } ${tight ? 'bg-red-100 text-red-700' : 'bg-background/80 text-gray-600'} ${
                    selectedLegId === leg.id ? 'ring-1 ring-blue-500' : ''
                  }`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                >
                  {MODE_ICON[leg.mode]}
                  {leg.stale && '⚠️'}
                  {legDurationText(leg)}
                </button>
              )
            })}
```

（審查 I-1：視覺最小寬度 `Math.max(..., 2)` 撐寬出來的死區會蓋住相鄰色塊搶走點擊，改為 `pointer-events-none`——選取一律走側欄交通列；同時右緣夾到 `100 - leftPct` 避免在視窗尾端溢出軌道。播放頭 `<div>` 順手補 `z-20`（M-7），確保疊在連接條的 `z-10` 之上維持可見。）

- [ ] **Step 5: 驗證** — lint/tsc/build/vitest/playwright 全綠；手動（dev server、有伺服器金鑰）：開有兩顆以上停留點的行程 → 數秒後 refresh 出現交通列與連接條、時長合理；拖曳停留點縮短空檔到小於交通時間 → 連接條與色塊變紅（趕不上警示）；無伺服器金鑰環境顯示「待計算」。→ **Commit** `feat: 前端接線（legs 讀取、sync 觸發、時間軸連接條、側欄交通列）` + 審查加固 `fix: 前端接線加固（併發可見性、連接條死區、sync 去重與續跑）`（C-1 legCount/23505 語義、I-1 連接條死區與溢出、I-2 sync in-flight coalescing、I-3 pending/incomplete 續跑上限 6、M-1 跨日文案改實際日期、M-2 route.ts no_route 寫回失敗補 pending++、M-4 routes.ts 超限判定改 no_route、M-5 mount-once effect lint 歸零、M-7 播放頭 z-20、S-1 sync 失敗一次性提示、S-5 側欄交通列 aria-pressed）

---

### Task 6: LegEditor——手動修正與 flight 段【出發前必須】

**Files:** Create `src/app/trips/[tripId]/LegEditor.tsx`；Modify `TripView.tsx`（把 Task 5 的占位換成真元件）

- [ ] **Step 1: LegEditor 元件** — Create `src/app/trips/[tripId]/LegEditor.tsx`:

```tsx
'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { utcMsToWallInput, wallInputToUtcMs } from '@/lib/domain/tz'
import { MODE_LABEL, isNoRoute } from './legUi'
import type { TablesUpdate } from '@/lib/supabase/database.types'
import type { Leg, Stop } from './TripView'

type Notice = { kind: 'error' | 'success'; text: string } | null
const AUTO_MODES = ['transit', 'walking', 'driving'] as const
type Mode = Leg['mode']

export default function LegEditor({
  leg, fromStop, toStop, currency, onChanged,
}: {
  leg: Leg
  fromStop: Stop
  toStop: Stop
  currency: string
  onChanged?: () => void
}) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(leg.mode)
  const [duration, setDuration] = useState(
    leg.source === 'manual' && leg.duration_minutes !== null ? String(leg.duration_minutes) : '',
  )
  // flight/custom 的起訖：出發用起點時區、抵達用終點時區（可跨日跨時區——datetime-local 含日期）
  const [departsAt, setDepartsAt] = useState(
    leg.departs_at && leg.source === 'manual'
      ? utcMsToWallInput(new Date(leg.departs_at).getTime(), fromStop.timezone) : '',
  )
  const [arrivesAt, setArrivesAt] = useState(
    leg.arrives_at && leg.source === 'manual'
      ? utcMsToWallInput(new Date(leg.arrives_at).getTime(), toStop.timezone) : '',
  )
  const [cost, setCost] = useState(leg.estimated_cost?.toString() ?? '')
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const isTimed = mode === 'flight' || mode === 'custom'
  const isAutoMode = (AUTO_MODES as ReadonlyArray<string>).includes(mode)

  // patch 型別用生成的 TablesUpdate<'legs'>（審查 M-3：Record<string, unknown> 過不了
  // supabase-js 的 update 泛型，tsc 實測編譯失敗）
  async function write(patch: TablesUpdate<'legs'>, successText: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const supabase = createClient()
      // 樂觀鎖（審查 Important-2/3，比照 StopEditor.tsx:56-76）：以「當下 props 值」比對
      // updated_at，防的是本分頁尚未觀察到的外部改動（sync 併發寫回、其他分頁/協作者）——
      // 比對不到列時 data 為空陣列且無 error，不可再靜默覆寫或假裝成功。
      const { data, error } = await supabase
        .from('legs')
        .update(patch)
        .eq('id', leg.id)
        .eq('updated_at', leg.updated_at)
        .select('id')
      if (error) {
        setNotice(
          error.code === '23514' || error.code === '22003'
            ? { kind: 'error', text: '輸入內容不符限制，請檢查數值' }
            : { kind: 'error', text: '儲存失敗，請稍後再試' },
        )
        return
      }
      if (data.length === 0) {
        setNotice({ kind: 'error', text: '此交通段已被其他操作變更或刪除，請重新整理後再編輯' })
        router.refresh()
        return
      }
      setNotice({ kind: 'success', text: successText })
      onChanged?.()
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 三種儲存形態：
  // A. auto 模式、時長留空 → 交還自動計算（source=auto、清 Google 衍生欄位與起訖，sync 重算）
  // B. auto 模式、填了時長 → source=manual，只存使用者資料；清 polyline/detail——
  //    ToS 分層：manual 段永久保存，不得夾帶 Google 衍生資料（spec §4）
  // C. flight/custom → source=manual，起訖必填且訖 > 起；duration 由起訖導出（衝突偵測用）
  async function save() {
    const costNum = cost === '' ? null : Number(cost)
    if (costNum !== null && (Number.isNaN(costNum) || costNum < 0)) {
      return setNotice({ kind: 'error', text: '花費必須是不小於 0 的數字' })
    }
    if (isTimed) {
      if (!departsAt || !arrivesAt) return setNotice({ kind: 'error', text: '請填出發與抵達時間' })
      const dep = wallInputToUtcMs(departsAt, fromStop.timezone)
      const arr = wallInputToUtcMs(arrivesAt, toStop.timezone)
      if (!(arr > dep)) return setNotice({ kind: 'error', text: '抵達必須晚於出發（注意兩地時區）' })
      // Important-4（軟警示，spec §5：警示不阻擋）：出發早於起點停留點結束、或抵達晚於終點停留點開始，
      // 代表班機時刻與停留點時段兜不起來，可能是使用者輸錯——仍允許儲存，只是提示確認
      const outOfWindow = dep < new Date(fromStop.ends_at).getTime() || arr > new Date(toStop.starts_at).getTime()
      return write({
        mode, source: 'manual',
        departs_at: new Date(dep).toISOString(),
        arrives_at: new Date(arr).toISOString(),
        duration_minutes: Math.max(1, Math.round((arr - dep) / 60_000)),
        distance_meters: null, polyline: null, detail: null, computed_at: null,
        stale: false, estimated_cost: costNum,
      }, outOfWindow ? '已儲存，但班機時間落在停留點時段之外，請確認行程銜接' : '已儲存 ✓')
    }
    if (duration.trim() !== '') {
      const n = Number(duration)
      if (!Number.isInteger(n) || n < 0) return setNotice({ kind: 'error', text: '時長必須是不小於 0 的整數分鐘' })
      if (n > 43200) return setNotice({ kind: 'error', text: '時長需在 0–43200 分鐘之間' }) // M-5：上界 30 天
      return write({
        mode, source: 'manual', duration_minutes: n,
        distance_meters: null, polyline: null, detail: null, computed_at: null,
        departs_at: null, arrives_at: null,
        stale: false, estimated_cost: costNum,
      }, '已儲存（手動時長不會被自動計算覆蓋）✓')
    }
    return write({
      mode, source: 'auto', duration_minutes: null,
      distance_meters: null, polyline: null, detail: null, computed_at: null,
      departs_at: null, arrives_at: null,
      stale: false, estimated_cost: costNum,
    }, '已交還自動計算，稍候更新 ✓')
  }

  return (
    <div className="mt-1 flex flex-col gap-2 rounded border p-2 text-sm">
      {leg.stale && (
        <div className="flex items-center justify-between rounded bg-amber-50 p-1 text-xs text-amber-700">
          ⚠️ 前後行程變動過，此交通資訊可能過期
          <button type="button" className="rounded border px-1 disabled:opacity-50" disabled={busy}
            onClick={() => write({ stale: false }, '已確認 ✓')}>已重新確認</button>
        </div>
      )}
      {isNoRoute(leg) && (
        <p className="text-xs text-amber-700">查無路線：可改用其他交通方式，或切為航班/自訂手動填寫</p>
      )}
      <label className="flex items-center gap-2 text-xs">
        交通方式
        <select className="rounded border p-1" value={mode} onChange={e => setMode(e.target.value as Mode)}>
          {(Object.keys(MODE_LABEL) as Mode[]).map(m => (
            <option key={m} value={m}>{MODE_LABEL[m]}</option>
          ))}
        </select>
      </label>
      {mode === 'walking' && (
        <p className="text-xs text-gray-400">步行路線為 Google Beta 功能，可能缺乏人行道資訊，請留意實地狀況</p>
      )}
      {isAutoMode && (
        <label className="flex flex-col gap-1 text-xs">
          時長（分鐘；留空 = 自動計算，填寫 = 手動覆寫且不被自動蓋掉）
          <input className="rounded border p-1" type="number" min="0" step="1"
            placeholder={leg.duration_minutes !== null ? `目前自動計算：${leg.duration_minutes} 分` : ''}
            value={duration} onChange={e => setDuration(e.target.value)} />
        </label>
      )}
      {isTimed && (
        <>
          <label className="flex flex-col gap-1 text-xs">
            出發（{fromStop.timezone} 當地時間）
            <input className="rounded border p-1" type="datetime-local" value={departsAt} onChange={e => setDepartsAt(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            抵達（{toStop.timezone} 當地時間）
            <input className="rounded border p-1" type="datetime-local" value={arrivesAt} onChange={e => setArrivesAt(e.target.value)} />
          </label>
        </>
      )}
      <input className="rounded border p-1" type="number" min="0" step="0.01"
        placeholder={`預估花費（${currency}，可留空）`} value={cost} onChange={e => setCost(e.target.value)} />
      <button className="rounded bg-foreground p-1 text-background disabled:opacity-50" onClick={save} disabled={busy}>
        儲存
      </button>
      {notice && (
        <p className={`text-xs ${notice.kind === 'error' ? 'text-red-600' : 'text-green-600'}`}>{notice.text}</p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: TripView 換占位為真元件** — `import LegEditor from './LegEditor'`，Task 5 Step 5 的占位 `<p>` 換成：

```tsx
                      {selectedLegId === leg.id && (
                        <LegEditor
                          key={leg.id}
                          leg={leg}
                          fromStop={stop}
                          toStop={next}
                          currency={trip.currency}
                          onChanged={() => void syncLegs()}
                        />
                      )}
```

- [ ] **Step 3: 驗證** — 全套自動化綠；手動：
  - 切換交通方式（transit → driving）→ 儲存 → sync 重算出新時長。
  - 填手動時長 → 儲存 → 拖曳前後停留點 → 交通列出現 ⚠️ 但**時長維持手動值**（manual 不被覆蓋 + trigger stale）。
  - 建台北→福岡的兩顆停留點（桃機 Asia/Taipei、福岡機場 Asia/Tokyo）→ 交通段切 flight → 填 08:55 出發（台北時間）/ 11:55 抵達（東京時間）→ 時長 120 分（跨時區換算正確）→ 衝突警示按此時長運作。
  - **跨午夜段（M-4 驗證案例）**：from 停留點 23:30（Asia/Taipei）、to 停留點隔日 08:00（Asia/Tokyo）→ 交通列顯示在出發日末尾並標「→ 隔日 <名稱>」、時間軸連接條右端夾到視窗尾；切 flight 填跨日起訖（如 23:55 出發、隔日 03:10 抵達）儲存正確、隔日視角不重複出現。
  - 「已重新確認」清 stale；「留空時長儲存」交還自動計算。
  → **Commit** `feat: 交通段編輯器（手動修正不被覆蓋、flight 跨日跨時區起訖）`

- [ ] **Step 4: 審查修復（Critical-1 換人負責之外的前端側）** — LegEditor 過稿本身 byte-identical、多時區驗算全過，但複審揪出 1 Important 級併發缺口與若干 Minor：

  1. **`page.tsx`** 的 legs 查詢 `.select(...)` 補一個欄位 `updated_at`（其餘欄位不動）；`TripView.tsx` 的 `Leg` type 對應補 `updated_at: string`。

  2. **`LegEditor.tsx` 樂觀鎖（Important-2/3）**：`write()` 的 `.eq('id', leg.id)` 後加 `.eq('updated_at', leg.updated_at).select('id')`，`data.length === 0` 視為「已被其他操作變更或刪除」，走與 StopEditor.tsx:56-76 相同模式（設 error notice + `router.refresh()`，不可靜默覆寫或假裝成功）。完整程式碼見上方 Step 1 程式碼區塊（已回寫最終版）。

  3. **flight 軟警示（Important-4）**：`save()` 的 `isTimed` 分支算出 `dep`/`arr` 後，若 `dep < fromStop.ends_at` 或 `arr > toStop.starts_at`（班機時刻落在停留點時段之外）——**仍允許儲存**（spec §5：警示不阻擋），只是 `successText` 換成提示文案。

  4. **M-5**：手動時長輸入補上界 `n > 43200`（30 天）擋下；`write()` 的錯誤分支把 `22003`（numeric 溢位，主要來自 `estimated_cost`）併入 `23514` 的「輸入內容不符限制」文案。

  5. **M-7**：`TripView.tsx` 補一段 render-phase 比對（**不是** `useEffect`——line 296 已有「避免另開 effect 直接 setState 觸發連鎖渲染 lint 錯誤」的前例）：用 `useRef` 記錄前一輪 `legs` 參照，`legs` 參照變動的那一輪，若 `selectedLegId` 指向的段已不在新的 `legs` 裡就 `setSelectedLegId(null)`，避免結構同步移除/重建該段後選取殘留成 dangling id。程式碼緊接在 `legByPair` 之後、`content = (` 之前：

```tsx
  const prevLegsRef = useRef(legs)
  if (prevLegsRef.current !== legs) {
    prevLegsRef.current = legs
    if (selectedLegId !== null && !legs.some(l => l.id === selectedLegId)) setSelectedLegId(null)
  }
```

  6. **S-9**：LegEditor 的 auto 模式時長欄補 `placeholder={leg.duration_minutes !== null ? \`目前自動計算：${leg.duration_minutes} 分\` : ''}`，留空時能看到目前的自動計算值當參考。

  **遺留（不在本輪範圍，記入 spec §8 / Plan 5）**：M-6（跨 DST 邊界的 flight 起訖換算，`date-fns-tz` 已處理但無專屬測試案例覆蓋）、S-8（custom 模式目前與 flight 共用「必填起訖」表單，未來若要支援「custom 也能只填時長」需要拆兩種子表單）。

  **驗證**：lint/tsc/build/vitest（維持 80，本輪不新增常駐案例）/smoke 全綠；PoC 重測 Critical-1（見 Task 4 Step 2 後的說明）+ 用 Playwright 臨時腳本重跑一次跨午夜案例確認樂觀鎖與軟警示不誤傷正常流程（在邊界值 dep=fromStop.ends_at/arr=toStop.starts_at 恰好不觸發 Important-4 警示文案；`updated_at` 刷新後仍可正常再次儲存；外部併發改動時正確擋下並提示重新整理）。→ **Commit** `fix: 交通段寫回 source 守衛與編輯器樂觀鎖（manual 覆寫保護）`

---

### Task 7: 地圖 polyline（選中日路線）【可旅途中補】

**Files:** Create `src/app/trips/[tripId]/RoutePolylines.tsx`；Modify `TripView.tsx`

- [ ] **Step 1: RoutePolylines 元件** —

```tsx
'use client'

import { useEffect } from 'react'
import { useMap, useMapsLibrary } from '@vis.gl/react-google-maps'
import type { Leg, Stop } from './TripView'

const MODE_COLOR: Record<Leg['mode'], string> = {
  transit: '#2563eb', walking: '#059669', driving: '#d97706', flight: '#7c3aed', custom: '#6b7280',
}

/** 選中日的交通段路線：有 polyline（Google 衍生）解碼實線；無 polyline（flight/manual）畫大圓虛線。
 *  google.maps.Polyline 非 React 元件，用 effect 管生命週期，cleanup 全量移除。 */
export default function RoutePolylines({
  legs, stops, selectedLegId,
}: {
  legs: Leg[]
  stops: Stop[]
  selectedLegId: string | null
}) {
  const map = useMap()
  const geometry = useMapsLibrary('geometry')

  useEffect(() => {
    if (!map || !geometry) return
    const stopById = new Map(stops.map(s => [s.id, s]))
    const overlays: google.maps.Polyline[] = []
    for (const leg of legs) {
      const from = stopById.get(leg.from_stop_id)
      const to = stopById.get(leg.to_stop_id)
      if (!from || !to) continue
      const decoded = leg.polyline ? geometry.encoding.decodePath(leg.polyline) : null
      overlays.push(new google.maps.Polyline({
        map,
        path: decoded ?? [{ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }],
        geodesic: !decoded,
        strokeColor: MODE_COLOR[leg.mode],
        // 虛線：主線透明 + repeat icon（Google Maps 官方 dashed line 做法）
        strokeOpacity: decoded ? 0.75 : 0,
        strokeWeight: leg.id === selectedLegId ? 5 : 3,
        ...(decoded ? {} : {
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.6, strokeColor: MODE_COLOR[leg.mode], scale: 3 }, offset: '0', repeat: '14px' }],
        }),
      }))
    }
    return () => overlays.forEach(o => o.setMap(null))
  }, [map, geometry, legs, stops, selectedLegId])

  return null
}
```

- [ ] **Step 2: TripView 掛載** — `<Map>` 內（CameraFollow 旁）：

```tsx
              <RoutePolylines
                legs={legs.filter(l => activeDayStops.some(s => s.id === l.from_stop_id))}
                stops={stops}
                selectedLegId={selectedLegId}
              />
```

- [ ] **Step 3: 驗證** — 全套自動化綠；手動：選中日的路線沿真實道路畫出、flight 段為紫色虛線直線、點選交通段線變粗、切 Day 路線跟著換。→ **Commit** `feat: 選中日地圖路線（polyline 實線 + flight 虛線）`

---

### Task 8: E2E 補強（含 M-7）【出發前必須】

**Files:** Modify `e2e/smoke.spec.ts`

- [ ] **Step 1: M-7——drag 段的 insert 補 error 檢查、reload 依賴顯式化**：

```ts
    // reload 依賴顯式：admin 直插不觸發 client refresh，必須 reload 才看得到新停留點（下方斷言依賴此行為）
    const { error: insertErr } = await admin.from('stops').insert([...])
    expect(insertErr).toBeNull()
```

- [ ] **Step 2: 交通段斷言（防假綠：UI 與 DB 同時斷言）** — drag 斷言後追加：

```ts
    // 交通段：掛載 sync 會為相鄰配對建 leg。無伺服器金鑰的環境 duration 為空、顯示「待計算」——
    // 斷言連接條存在（UI）+ legs 落地（DB），兩者缺一都是紅燈，不依賴外部 Google 呼叫（確定性）
    await page.reload()
    await expect(page.locator('[data-leg-connector]').first()).toBeVisible({ timeout: 15_000 })
    const legsInDb = await admin.from('legs').select('id, source').eq('trip_id', createdTripId)
    expect(legsInDb.error).toBeNull()
    expect(legsInDb.data!.length).toBeGreaterThanOrEqual(1)
    expect(legsInDb.data!.every(l => l.source === 'auto')).toBe(true)
```

（連接條僅在兩色塊間有正向空檔時渲染；本測試的拖曳後 A/B 仍保有 1 小時空檔，斷言穩定。若拖曳距離導致空檔歸零，改斷言 DB 即可——以實跑結果為準，如實回報。）

- [ ] **Step 3:** `npx playwright test` 連跑兩次（清理驗證零殘留）→ **Commit** `test: E2E 交通段斷言與 M-7 插入錯誤檢查`

---

### Task 9: PR #3 總審遺留清項【可旅途中補，可裁】

**Files:** Modify `Timeline.tsx`、`TripView.tsx`、`README.md`、`src/lib/domain/schedule.ts`

一次 commit 收七項（S-5 已提前併入 Task 1 Step 5），全部是小改；每項改完即刻跑全套（互不相干，壞了好定位）：

- [ ] **M-1 拖曳回彈 pendingDelta** — Timeline 的 endDrag 現在等 onMove 完成才清 drag，但 RPC 成功到 refresh 落地間仍有短暫回彈。TripView 增狀態 `pendingShift: { changedStopId: string; deltaMs: number; baselineStartMs: number } | null`：moveStop 於 RPC 前設定（baseline = 被拖點當下 starts_at）、於 `useEffect([stops])` 觀察到被拖點的 starts_at ≈ baseline + delta 時清空。Timeline 增可選 prop `pendingShift`，色塊 offset 計算：被拖點與「未鎖定且 baseline 上晚於被拖點」的色塊都加 deltaMs（語義對齊 cascade RPC）。
- [ ] **M-3 moveStop 靜默返回補 notice** — `if (busyRef.current || stopsError) return` 改為 busy 時 `setNotice({ kind: 'error', text: '另一項操作進行中，請稍候再拖曳' })` 後 return（stopsError 分支維持靜默——寫入入口本來就整組關閉）。
- [ ] **M-4 addStop 手寫過濾改用 filterDayStops** — `stops.filter(s => localDateKey(...) === targetDay)` 換成 `filterDayStops(stops, targetDay)`（順帶獲得排序，refTz 的「當日最後一個」語義更準確）。
- [ ] **M-5 加點落他日後 activeDay 跟隨** — addStop 成功後：`const landedDay = localDateKey(slot.startsAt, timezone)`，若 `landedDay !== activeDay` 則 `setActiveDay(landedDay)` 並重置 playhead/playing/selectedLegId（**不**歸零 lastInsertedEndRef——連續加點的墊底基準要跨日延續）。
- [ ] **M-6 時間軸起訖標籤跨時區** — 底部三個標籤：左標籤用 `dayStops[0].timezone`（起點）、右標籤改用 `dayStops[dayStops.length - 1].timezone`（終點）、播放頭標籤維持起點時區並在 title 註記。
- [ ] **M-8 README 鎖定語義** — 「可鎖定不可動的時間點」改為「可鎖定時間點（🔒 不被他人的連鎖順延波及；自己直接拖曳仍會移動）」，與 StopEditor 文案對齊。
- [ ] **S-4 schedule.ts 檔頭註記** — 檔頭補：「注意：cascadeShift 目前無生產呼叫端——連鎖順延的權威實作是 DB 的 cascade_shift_stops RPC；本函式保留作為語義文件與未來 UI 預覽用（M-1 的 pendingShift 即其近似）。」
- [ ] **驗證** — 全套綠 + 手動抽驗 M-1（拖曳後不回彈）與 M-5（在滿日加點跳到落地日）。→ **Commit** `fix: PR #3 總審遺留清項（M-1/M-3/M-4/M-5/M-6/M-8/S-4）`

---

### Task 10: 收尾與部署【出發前必須】

**Files:** Modify `README.md`、spec §8；正式環境操作

- [ ] **Step 1: README** —
  - 功能清單補交通段（自動計算 + 手動修正 + flight 段 + 趕不上警示）；專案狀態補 Plan 4 ✅。**地圖路線只在 Task 7 實際完成時列入功能清單；若 Task 7 被裁，改記入已知限制「選中日路線圖屬後續」**（與 DoD 的「如實記載」對齊）。
  - 開發段補伺服器環境變數說明：`GOOGLE_MAPS_SERVER_API_KEY`（**另建**的無 referrer 限制金鑰，API 限制 Routes API——瀏覽器金鑰不能共用）、`SUPABASE_SERVICE_ROLE_KEY`。
  - 已知限制補：步行路線為 Google Beta（可能缺人行道資訊）；**刪除停留點會連帶刪除其相鄰交通段（FK cascade），含手動填寫的 manual/flight 段——重要班次資訊留意**；跨夜交通段顯示歸屬出發日（隔日視角不顯示延續）；路線代理限流為單機記憶體（serverless 弱化）；交通段轉乘細節（detail）本版未取用。
- [ ] **Step 2: spec §8 殘留風險表補列** —

| 項目 | 說明 | 處理時機 |
|------|------|---------|
| 路線代理限流為實例級記憶體 | Vercel serverless 每實例獨立視窗，護欄弱化；成本主防線是 route_cache + 單次 sync 分批上限 | 商用前換集中式（Upstash/DB）限流 |
| legs 鎖序不變量 | stale trigger 以 order by id for update 決定性鎖序；sync 刻意逐列寫入；未來單一交易內多列寫 legs 必須同樣按 id 排序取鎖（legs 表註解） | 每次新增 legs 批次寫入時 |
| 跨夜配對交通段的顯示歸屬 | 跨夜配對照常建立與計算，UI 歸屬出發日（M-4 規則），隔日視角無延續視覺、當日衝突偵測不涵蓋跨日尾段 | 時間軸後續迭代 |
| 多 editor 同開重複 sync | 每個 editor 開頁都觸發 sync；快取命中與 create 撞 unique 的靜默略過吸收大部分重複，但仍有重複 Google 呼叫的窗口 | Plan 5 Realtime 上線後指定單一觸發者（spec §6 原則） |
| auto leg 冷資料逾期殘留 | 超過 30 天未被開啟的行程，其 auto 段的 polyline/duration 逾期後仍留在 legs 直到下次開啟才重算——ToS 曝險殘留 | 商用前補背景清理 job（與 spec §4「行程被開啟時重算」的既有語義一致） |
| TRANSIT departureTime 夾限 | 出發時間離現在超過 100 天的行程，transit 以夾限後時間查詢，結果可能與實際班表有偏差 | 記錄即可（超前規劃 100 天以上屬邊緣） |

- [ ] **Step 3: 正式環境部署** —
  1. migration 推上雲端：`supabase db push`——已知收尾會卡死：背景執行，輪詢確認 `supabase migration list` 顯示 `20260802000000` 已套用後 kill 程序，再以 SQL editor 抽查 `legs` 新欄位與 trigger 存在（kill+verify workaround）。
  2. Vercel 環境變數補 `GOOGLE_MAPS_SERVER_API_KEY`、`SUPABASE_SERVICE_ROLE_KEY` → redeploy。
  3. 線上冒煙：開正式站行程 → 交通段出現、時長合理、手動修正可存。
- [ ] **Step 4: 回滾方案（審查 M-8，寫進 README 部署段，出事時照抄）** —
  - **前端**：Vercel Instant Rollback 回上一個 deployment（新環境變數殘留無害——舊版程式不讀它們）。
  - **migration**：純新增（新欄位/約束/索引/trigger），舊版程式完全不讀新欄位，**免 down migration**；回滾前端後資料庫原樣保留即可。
  - **應急開關**：stale trigger 若在生產出現異常（鎖等待/意外標記），單條 SQL 立即停用、不需部署：
    `alter table public.stops disable trigger stops_mark_manual_legs_stale;`（恢復用 `enable trigger`）。
  - unique 配對約束若意外擋住正常寫入：`alter table public.legs drop constraint legs_from_to_unique;`（查明根因後補回）。
- [ ] **Step 5: 全量驗證**（lint/tsc/build/vitest 全綠/playwright 雙跑零殘留）→ **Commit** `docs: Plan 4 收尾（README、spec 殘留風險、部署與回滾）` → push 分支。

---

## 完成定義（Definition of Done）

- [ ] lint / tsc / build 乾淨；vitest 全綠（基線 51 + legs 整合 6 + legSync 11 + rateLimit 3 + google routes 9（含 R-2/M-4 duration 上限案例）≈ **80**，以實跑為準）；Playwright 綠且雙跑零殘留
- [ ] 手動（需雙金鑰）：開行程自動出現交通段與時長 → 拖曳停留點後 auto 段重算、manual 段標 ⚠️ 且數值不變 → 空檔不足時連接條與色塊變紅（警示不阻擋）→ flight 段跨時區起訖換算正確 → 交還自動計算可逆 →（Task 7 完成時）選中日路線與 flight 虛線正確
- [ ] ToS 分層可驗證：manual 段的 polyline/detail 為 null（DB 抽查）；route_cache 逾期列被覆寫（可改 fetched_at 倒推驗證）
- [ ] 正式環境：migration 已套用、Vercel 雙環境變數已設、線上冒煙通過；**回滾路徑已記載於 README（Instant Rollback、trigger 應急停用），migration 確認為純新增免 down**
- [ ] 全部 commit 推上 feat/plan-4-transit；若裁掉 Task 7/9，README 已知限制與回報中如實記載
