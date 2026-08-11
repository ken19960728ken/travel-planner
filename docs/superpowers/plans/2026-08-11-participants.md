# 參與人指派 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓行程中的每個停留點可標記「誰會去」，並讓交通生成、衝突偵測、播放、花費、匯出全部改成每個參與人各自一條時間軸。

**Architecture:** 名冊存 `trips.participants` jsonb、指派存 `stops.participant_ids` uuid[]，兩者都放進既有表以沿用現有的 realtime 訂閱、RLS 與單列樂觀鎖。所有「null = 全員 / 未知 id 忽略」的解讀收斂到單一純函式 `resolveStopParticipants`，五個消費端一律走它。交通段不儲存參與人，由前後停留點的交集推導。

**Tech Stack:** Next.js 16 App Router、Supabase(PostgreSQL + RLS)、Google Maps(@vis.gl/react-google-maps)、vitest、Playwright

**設計文件：** `docs/superpowers/specs/2026-08-11-participants-design.md`

---

## 關鍵約束（違反會出事）

1. **`trips` 是欄位級授權。** `20260803000000_invites_and_grants.sql:83` 是 `grant update (title, start_date, end_date, currency) on public.trips to authenticated`。新欄位**必須顯式加進這份清單**，否則寫入被 PostgREST 拒絕。這與 `stops`／`legs` 的表級授權（新欄位自動繼承）不同，是本計畫最容易漏掉的一步。
2. **`get_shared_trip` 不得吐出 `user_id`。** 名冊含 `auth.users` UUID，分享頁對匿名訪客開放。必須逐鍵投影成 `id`/`name`/`color`，不能 `'participants', t.participants`。
3. **`remove_trip_participant` 是 SECURITY DEFINER，必須自帶 `is_trip_editor` 守衛。** 少了它，任何登入者都能清空別人行程的名冊。
4. **禁止跑 `supabase gen types`**（會把其他分支的表混進 diff）。`database.types.ts` 手工加欄位。
5. **`share.test.ts` 的 `TRIP_KEYS`(L20) 與 `STOP_KEYS`(L21-24) 必須同步更新**，`jsonb_build_object` 即使值為 null 仍產生鍵，不加就紅燈。
6. **部署順序**：migration 先推雲端、程式碼後部署（README 順序表；2026-08-03 已因搞反造成線上故障）。
7. **最重要的回歸防線**：所有停留點 `participant_ids` 為 null 時，`participantPairs` 的輸出必須與現行 `adjacentPairs` **逐項相等**。既有的九州行程零變化。

---

## 檔案結構

| 檔案 | 職責 | 新/改 |
|---|---|---|
| `src/lib/domain/participants.ts` | 名冊解析、`resolveStopParticipants`、交通段交集 | 新 |
| `src/lib/domain/participants.test.ts` | 上者測試 | 新 |
| `supabase/migrations/20260811000000_participants.sql` | 兩個欄位 + constraint + grant + RPC + 分享白名單 | 新 |
| `src/lib/supabase/database.types.ts` | trips/stops 的 Row/Insert/Update | 改 |
| `src/app/trips/[tripId]/page.tsx:24,49` | trips 與 stops 的 select 加欄位 | 改 |
| `src/app/trips/[tripId]/TripView.tsx` | `Trip`/`Stop` 型別、多軌播放、看誰下拉、側欄首字圖章 | 改 |
| `src/lib/domain/legSync.ts` | `participantPairs`、`planLegSync` 換 `wanted` 來源 | 改 |
| `src/app/api/trips/[tripId]/legs/sync/route.ts` | 讀 roster 與 `participant_ids` 餵進 planLegSync | 改 |
| `src/lib/domain/conflicts.ts` | 按人分組後聯集去重 | 改 |
| `src/lib/domain/cost.ts` | `costByParticipant` 整數分攤 | 改 |
| `src/app/trips/[tripId]/ParticipantPicker.tsx` | 參與人多選（StopEditor 用） | 新 |
| `src/app/trips/[tripId]/participantUi.ts` | 首字取用、四色輔助色盤（附 ΔE 掃描依據） | 新 |
| `src/app/trips/[tripId]/MembersPanel.tsx` | 參與人名冊管理區塊 | 改 |
| `src/app/trips/[tripId]/StopEditor.tsx` | 參與人多選欄位 | 改 |
| `src/app/trips/[tripId]/CostSummary.tsx` | 每人應付列 | 改 |
| `src/lib/domain/exportRows.ts` | 列型別加參與人欄、`participantTotal` 列別 | 改 |
| `src/app/api/trips/[tripId]/export/xlsx/route.ts` | 新欄位與 `participantTotal` 列的輸出 | 改 |
| `src/lib/domain/snapshot.ts` | 收錄名冊與指派 | 改 |
| `src/lib/supabase/share.test.ts` | 白名單鍵集合 + `user_id` 不外洩斷言 | 改 |
| `src/app/share/view/page.tsx` | `SharedTripPayload` 型別 | 改 |
| `e2e/participants.spec.ts` | 端對端（前綴 `e2e-participants-`） | 新 |

---

## Task 1：domain 純函式

**Files:**
- Create: `src/lib/domain/participants.ts`
- Test: `src/lib/domain/participants.test.ts`

- [ ] **Step 1: 寫失敗的測試**

`src/lib/domain/participants.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseRoster, resolveStopParticipants, legParticipants, MAX_PARTICIPANTS } from './participants'

const ok = { id: 'p1', user_id: null, name: '小明', color: '#e11d48' }

describe('parseRoster', () => {
  it('非陣列一律回空陣列', () => {
    expect(parseRoster(null)).toEqual([])
    expect(parseRoster('x')).toEqual([])
    expect(parseRoster({ id: 'p1' })).toEqual([])
  })

  it('逐個丟棄畸形元素，保留合法的（不整批放棄）', () => {
    expect(parseRoster([ok, null, { id: 'p2' }, { ...ok, id: 'p3', name: '' }, { ...ok, id: 'p4' }]))
      .toEqual([ok, { ...ok, id: 'p4' }])
  })

  it('id 重複時只留第一個', () => {
    expect(parseRoster([ok, { ...ok, name: '重複' }])).toHaveLength(1)
  })

  it('user_id 可為 null（無帳號同行者）或字串', () => {
    expect(parseRoster([{ ...ok, user_id: 'u1' }])[0].user_id).toBe('u1')
    expect(parseRoster([ok])[0].user_id).toBeNull()
  })

  it(`超過 ${MAX_PARTICIPANTS} 人截斷`, () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...ok, id: `p${i}` }))
    expect(parseRoster(many)).toHaveLength(MAX_PARTICIPANTS)
  })
})

describe('resolveStopParticipants', () => {
  const roster = ['p1', 'p2', 'p3']

  it('null 代表全員', () => {
    expect(resolveStopParticipants(null, roster)).toEqual(roster)
    expect(resolveStopParticipants(undefined, roster)).toEqual(roster)
  })

  it('非陣列視同全員（DB 形狀不可信）', () => {
    expect(resolveStopParticipants('p1', roster)).toEqual(roster)
  })

  it('只回傳名冊裡確實存在的 id，順序沿名冊', () => {
    expect(resolveStopParticipants(['p3', 'p1'], roster)).toEqual(['p1', 'p3'])
  })

  it('未知 id 被忽略', () => {
    expect(resolveStopParticipants(['p1', 'ghost'], roster)).toEqual(['p1'])
  })

  it('全部無效時視同全員——否則該停留點不在任何人的鏈上，前後交通段會無聲消失', () => {
    expect(resolveStopParticipants(['ghost'], roster)).toEqual(roster)
    expect(resolveStopParticipants([], roster)).toEqual(roster)
  })

  it('名冊為空時回空陣列（呼叫端據此退回單軌行為）', () => {
    expect(resolveStopParticipants(null, [])).toEqual([])
  })
})

describe('legParticipants', () => {
  it('取交集，順序沿 from', () => {
    expect(legParticipants(['p1', 'p2', 'p3'], ['p3', 'p1'])).toEqual(['p1', 'p3'])
  })

  it('無交集回空陣列', () => {
    expect(legParticipants(['p1'], ['p2'])).toEqual([])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- participants`
Expected: FAIL，`Failed to resolve import "./participants"`

- [ ] **Step 3: 實作**

`src/lib/domain/participants.ts`：

```ts
/** 參與人的名冊解析與指派解讀（設計文件 §3.4）。
 *
 *  【為何是唯一入口】「null = 全員 / 未知 id 忽略 / 全部無效視同全員」這三條規則有五個消費端
 *  （sync、衝突偵測、播放、花費、匯出）。讓每個消費端各寫一次就是五份會各自漂移的邏輯——
 *  比照手繪路徑的 parseCustomPath（routePath.ts），全部收斂到這裡。
 *
 *  屬 domain 層，輸入型別自帶最小欄位、不 import app 層型別（沿 snapshot.ts / exportRows.ts 慣例）。 */

export const MAX_PARTICIPANTS = 20

export type Participant = {
  id: string
  /** 對應 trip_members.user_id；無帳號同行者為 null */
  user_id: string | null
  name: string
  color: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** 從 DB/RPC 讀到的未知形狀 → 乾淨的名冊。畸形元素個別丟棄，不整批放棄。 */
export function parseRoster(raw: unknown): Participant[] {
  if (!Array.isArray(raw)) return []
  const out: Participant[] = []
  const seen = new Set<string>()
  for (const e of raw) {
    if (out.length >= MAX_PARTICIPANTS) break
    if (typeof e !== 'object' || e === null) continue
    const { id, user_id, name, color } = e as Record<string, unknown>
    if (!isNonEmptyString(id) || !isNonEmptyString(name) || !isNonEmptyString(color)) continue
    if (user_id !== null && typeof user_id !== 'string') continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, user_id: user_id ?? null, name, color })
  }
  return out
}

/** 解讀停留點的參與人。回傳一定是 roster 的子集、順序沿 roster；roster 為空時回空陣列。
 *
 *  「全部無效 → 全員」這條不是防禦性冗餘：若某停留點的 id 全部指向已移除的參與人而不套用這條，
 *  它不會出現在任何人的鏈上，於是前後的交通段全部消失，而畫面上看不出原因。 */
export function resolveStopParticipants(participantIds: unknown, roster: readonly string[]): string[] {
  if (roster.length === 0) return []
  if (!Array.isArray(participantIds)) return [...roster]
  const wanted = new Set(participantIds.filter(isNonEmptyString))
  const hit = roster.filter(id => wanted.has(id))
  return hit.length > 0 ? hit : [...roster]
}

/** 交通段的參與人＝前後兩個停留點的交集（設計文件 §2：不獨立儲存，結構上不可能矛盾）。 */
export function legParticipants(fromIds: readonly string[], toIds: readonly string[]): string[] {
  const to = new Set(toIds)
  return fromIds.filter(id => to.has(id))
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- participants`
Expected: PASS（16 個案例）

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/participants.ts src/lib/domain/participants.test.ts
git commit -m "feat: 參與人 domain 純函式（名冊解析與指派解讀）"
```

---

## Task 2：migration

**Files:**
- Create: `supabase/migrations/20260811000000_participants.sql`

- [ ] **Step 1: 寫 migration**

```sql
-- ============ 參與人指派 ============
-- 設計文件：docs/superpowers/specs/2026-08-11-participants-design.md
--
-- ⚠️⚠️ 部署順序（README「migration 與程式碼的部署順序」表的「新程式碼要讀新欄位」列）：
-- **這支 migration 必須先推上雲端，Vercel 程式碼後部署。**
-- 正向：新增欄位對舊程式碼透明，get_shared_trip 多回兩個鍵不會讓舊 client 出錯。
-- 反向：page.tsx 的 select 指名不存在的欄位 → 查詢整個失敗 → 行程頁「停留點讀取失敗」。
-- 本專案 2026-08-03 已因搞反此順序造成線上故障（stops.category）。

begin;

-- ---------- 名冊：trips.participants ----------
-- [{ "id": uuid, "user_id": uuid|null, "name": text, "color": "#rrggbb" }, ...]
-- user_id 為 null＝無帳號同行者。成員也照存 name：trip_members 沒有 display_name 欄位
-- （init.sql:47-53），且成員退出後名字仍該留在歷史紀錄裡。
alter table public.trips add column if not exists participants jsonb not null default '[]'::jsonb;

-- 雙重上限，比照 legs_custom_path_shape（20260810000000:48-57）的教訓：
-- 只限元素個數擋不住「20 個元素、每個 1MB」，整欄可達數十 MB，而分享 RPC 會把它吐給匿名訪客。
alter table public.trips drop constraint if exists trips_participants_shape;
alter table public.trips
  add constraint trips_participants_shape check (
    jsonb_typeof(participants) = 'array'
    and jsonb_array_length(participants) <= 20
    and length(participants::text) <= 4000
  );

-- ⚠️ trips 是**欄位級**授權（20260803000000_invites_and_grants.sql:83），新欄位不會自動繼承，
-- 必須重下一次涵蓋 participants 的 grant。這與 stops/legs（表級授權，新欄位自動繼承，
-- 見 20260803000004_stop_category.sql:10）刻意不同。漏掉這行的症狀是「儲存沒反應」而非報錯。
grant update (title, start_date, end_date, currency, participants) on public.trips to authenticated;

-- ---------- 指派：stops.participant_ids ----------
-- null ＝ 全員。**DB 禁止空陣列**——一種語義只有一種表示，不留 null 與 [] 誰是誰的模糊地帶
-- （雙重表示在每個消費端都要各自判斷一次，遲早有人漏掉一邊）。
-- 既有資料全為 null，行為完全不變。
alter table public.stops add column if not exists participant_ids uuid[];
alter table public.stops drop constraint if exists stops_participant_ids_shape;
alter table public.stops
  add constraint stops_participant_ids_shape check (
    -- ⚠️ 必須用 cardinality 而非 array_length：array_length('{}', 1) 回傳 **NULL** 不是 0，
    -- 而 CHECK 在運算式為 NULL 時視為通過。本機實測：array_length 版本讓空陣列完全通行。
    participant_ids is null or cardinality(participant_ids) between 1 and 20
  );
-- stops 是表級授權（authenticated=arwd，attacl 為空），新欄位自動繼承，不需 column grant。

-- ---------- 移除參與人（名冊 + 指派同一交易） ----------
create or replace function public.remove_trip_participant(p_trip_id uuid, p_participant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- ⚠️ SECURITY DEFINER 繞過 RLS，權限檢查必須自己做。這個函式的 definer 身分只是為了讓兩個
  -- UPDATE 在同一交易內完成，不是要放行給所有人——少了這行，任何登入者都能清空別人行程的名冊。
  if not public.is_trip_editor(p_trip_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- nullif(…, '{}') 是關鍵：最後一個參與人被移除時該停留點回到 null（全員），
  -- 而不是產生會被 stops_participant_ids_shape 擋下的空陣列讓整個交易失敗。
  update public.stops
     set participant_ids = nullif(array_remove(participant_ids, p_participant_id), '{}')
   where trip_id = p_trip_id and participant_ids @> array[p_participant_id];

  update public.trips
     set participants = (
       select coalesce(jsonb_agg(e), '[]'::jsonb)
         from jsonb_array_elements(participants) e
        where e->>'id' <> p_participant_id::text)
   where id = p_trip_id;
end;
$$;

revoke execute on function public.remove_trip_participant(uuid, uuid) from public;
grant execute on function public.remove_trip_participant(uuid, uuid) to authenticated;

-- ---------- 分享白名單 ----------
-- 函式本體逐字沿用 20260810000000，兩處差異：
--   trip  層多 'participants'（**逐鍵投影**，見下）
--   stop  層多 'participant_ids'
--
-- ⚠️⚠️ participants 絕不可整包吐出：它含 user_id（auth.users 的 UUID），而這個 RPC 對匿名訪客
-- 開放。逐鍵投影成 id/name/color 是硬性要求，share.test.ts 有對應斷言鎖住。
create or replace function public.get_shared_trip(p_token uuid) returns jsonb
language sql security definer stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'trip', jsonb_build_object(
      'id', t.id, 'title', t.title, 'start_date', t.start_date,
      'end_date', t.end_date, 'currency', t.currency,
      'participants', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', e->>'id', 'name', e->>'name', 'color', e->>'color'))
        from jsonb_array_elements(t.participants) e), '[]'::jsonb)),
    'stops', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'lat', s.lat, 'lng', s.lng, 'place_id', s.place_id,
        'is_custom', s.is_custom, 'timezone', s.timezone, 'starts_at', s.starts_at,
        'category', s.category,
        'participant_ids', s.participant_ids,
        'ends_at', s.ends_at, 'locked', s.locked,
        'estimated_cost', s.estimated_cost
      ) order by s.starts_at, s.id) from (select * from stops where trip_id = t.id order by starts_at, id limit 500) s), '[]'::jsonb),
    'legs', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'from_stop_id', l.from_stop_id, 'to_stop_id', l.to_stop_id,
        'mode', l.mode, 'duration_minutes', l.duration_minutes,
        'distance_meters', l.distance_meters, 'detail', l.detail,
        'polyline', l.polyline,
        'custom_path', l.custom_path,
        'source', l.source, 'stale', l.stale, 'departs_at', l.departs_at,
        'arrives_at', l.arrives_at, 'estimated_cost', l.estimated_cost,
        'updated_at', l.updated_at
      ) order by l.id) from (select * from legs where trip_id = t.id order by id limit 500) l), '[]'::jsonb)
  )
  from trips t where t.share_token = p_token
$$;

revoke execute on function public.get_shared_trip(uuid) from public;
grant execute on function public.get_shared_trip(uuid) to anon, authenticated;

commit;

-- 回滾（依需要擇一）：
--   僅解除格式限制、保留資料：
--     alter table public.trips drop constraint trips_participants_shape;
--     alter table public.stops drop constraint stops_participant_ids_shape;
--   完整移除（連同所有指派，不可復原）：
--     alter table public.trips drop column participants;
--     alter table public.stops drop column participant_ids;
--     drop function public.remove_trip_participant(uuid, uuid);
--
-- ⚠️ 回滾順序：移除欄位前必須先把 get_shared_trip 還原成 20260810000000 的版本
-- （函式本體引用 t.participants / s.participant_ids，欄位不存在時分享頁全面失效）。
```

- [ ] **Step 2: 本地套用**

Run: `supabase db reset` 或 `supabase migration up`
Expected: 無錯誤

- [ ] **Step 3: 確認冪等（重跑一次）**

Run: `psql "$SUPABASE_DB_URL" -f supabase/migrations/20260811000000_participants.sql`
Expected: 無錯誤（`if not exists` + `drop constraint if exists` + `create or replace` 讓整支可安全重跑）

- [ ] **Step 4: 驗證約束與權限**

```bash
psql "$SUPABASE_DB_URL" -c "
  -- 空陣列被拒
  insert into stops (trip_id, name, lat, lng, timezone, starts_at, ends_at, participant_ids)
    values ('00000000-0000-0000-0000-000000000000','x',0,0,'UTC',now(),now()+interval '1h','{}');
"
```
Expected: `new row for relation "stops" violates check constraint "stops_participant_ids_shape"`

```bash
psql "$SUPABASE_DB_URL" -c "
  select array_agg(a.attname order by a.attname)
  from pg_attribute a
  where a.attrelid = 'public.trips'::regclass
    and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE');
"
```
Expected: 包含 `participants`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260811000000_participants.sql
git commit -m "feat: 參與人 migration（名冊、指派、移除 RPC、分享白名單投影）"
```

---

## Task 3：型別與讀取路徑

**Files:**
- Modify: `src/lib/supabase/database.types.ts`（trips 與 stops 的 Row/Insert/Update）
- Modify: `src/app/trips/[tripId]/page.tsx:24,49`
- Modify: `src/app/trips/[tripId]/TripView.tsx:35-60`

**禁止跑 `supabase gen types`。** 手工加。

- [ ] **Step 1: database.types.ts**

trips 的 `Row` 加 `participants: Json`，`Insert`/`Update` 加 `participants?: Json`。
stops 的 `Row` 加 `participant_ids: string[] | null`，`Insert`/`Update` 加 `participant_ids?: string[] | null`。

- [ ] **Step 2: page.tsx 的 select**

L24：
```ts
.select('id, title, start_date, end_date, currency, share_token, participants')
```

L49：
```ts
.select('id, name, lat, lng, place_id, is_custom, timezone, starts_at, ends_at, locked, notes, estimated_cost, category, participant_ids')
```

- [ ] **Step 3: TripView 型別**

`Trip`（L35-44）加：
```ts
  /** 參與人名冊。**刻意宣告為 unknown**：資料來自 DB 與分享 RPC，形狀不可信，強迫所有消費端
   *  必須先過 parseRoster（src/lib/domain/participants.ts）。同 Leg.custom_path 的理由。 */
  participants: unknown
```

`Stop`（L46-60）加：
```ts
  /** 誰會去。null ＝ 全員。**刻意宣告為 unknown**，一律先過 resolveStopParticipants。 */
  participant_ids: unknown
```

- [ ] **Step 4: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 綠（此時尚無消費端，只是欄位流通）

- [ ] **Step 5: Commit**

```bash
git add src/lib/supabase/database.types.ts src/app/trips/\[tripId\]/page.tsx src/app/trips/\[tripId\]/TripView.tsx
git commit -m "feat: 參與人欄位接上讀取路徑與型別"
```

---

## Task 4：分軌交通段生成

**Files:**
- Modify: `src/lib/domain/legSync.ts`
- Modify: `src/lib/domain/legSync.test.ts`
- Modify: `src/app/api/trips/[tripId]/legs/sync/route.ts`

- [ ] **Step 1: 寫失敗的測試**

追加到 `src/lib/domain/legSync.test.ts`（該檔已 import `adjacentPairs`，只需在既有 import 加 `participantPairs`）：

```ts
import { participantPairs } from './legSync' // 併入既有的 { adjacentPairs, planLegSync, … }

describe('participantPairs', () => {
  const s = (id: string, h: number, participantIds: unknown = null) =>
    ({ id, startsAt: h * 3_600_000, participantIds })

  it('名冊為空時逐項等同 adjacentPairs（既有行程零變化——最重要的回歸防線）', () => {
    const stops = [s('A', 9), s('B', 11), s('C', 13)]
    expect(participantPairs(stops, [])).toEqual(adjacentPairs(stops))
  })

  it('全員同行（participant_ids 全為 null）時逐項等同 adjacentPairs', () => {
    const stops = [s('A', 9), s('B', 11), s('C', 13)]
    expect(participantPairs(stops, ['p1', 'p2'])).toEqual(adjacentPairs(stops))
  })

  it('純 fork：產生 A→B 與 A→C，不產生幻影的 B→C', () => {
    const stops = [s('A', 9), s('B', 11, ['p1']), s('C', 11, ['p2'])]
    const keys = participantPairs(stops, ['p1', 'p2']).map(([f, t]) => `${f.id}→${t.id}`)
    expect(keys.sort()).toEqual(['A→B', 'A→C'])
  })

  it('fork 後會合：兩條鏈各自連回共同的終點', () => {
    const stops = [s('A', 9), s('B', 11, ['p1']), s('C', 11, ['p2']), s('D', 14)]
    const keys = participantPairs(stops, ['p1', 'p2']).map(([f, t]) => `${f.id}→${t.id}`)
    expect(keys.sort()).toEqual(['A→B', 'A→C', 'B→D', 'C→D'])
  })

  it('同一配對只出現一次（兩人走同一段不重複生成）', () => {
    const stops = [s('A', 9, ['p1', 'p2']), s('B', 11, ['p1', 'p2'])]
    expect(participantPairs(stops, ['p1', 'p2'])).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- legSync`
Expected: FAIL，`participantPairs is not a function`

- [ ] **Step 3: 實作**

`legSync.ts` — `SyncStop` 加欄位：

```ts
export type SyncStop = {
  id: string; lat: number; lng: number; startsAt: number; endsAt: number
  /** 誰會去。形狀不可信，一律經 resolveStopParticipants 解讀。 */
  participantIds: unknown
}
```

新函式（放在 `adjacentPairs` 之後）：

```ts
import { resolveStopParticipants } from './participants'

/** 每個參與人各自的相鄰配對，聯集去重（設計文件 §4.1）。
 *
 *  現行的 adjacentPairs 假設整趟行程只有一條時間軸——分頭行動時它會生出「沒有人走過」的
 *  幻影交通段（A、B(甲)、C(乙) 三點會產生 B→C），而真正存在的 A→C 永遠不會被建立。
 *  本函式對每個人各自取鏈，聯集後去重。
 *
 *  名冊為空時直接退回 adjacentPairs——不是特例分支，是「零個參與人＝單一虛擬參與人」的自然結果，
 *  但顯式寫出來讓退化路徑一眼可見（測試逐項鎖住兩者相等）。 */
export function participantPairs<T extends { id: string; startsAt: number; participantIds: unknown }>(
  stops: T[],
  roster: readonly string[],
): Array<[T, T]> {
  if (roster.length === 0) return adjacentPairs(stops)
  // 先算一次：否則內層 filter 會對每個 (參與人 × 停留點) 重跑解讀，上限 20 × 500
  const resolved = new Map(stops.map(s => [s.id, resolveStopParticipants(s.participantIds, roster)]))
  const seen = new Set<string>()
  const out: Array<[T, T]> = []
  for (const p of roster) {
    const mine = stops.filter(s => resolved.get(s.id)!.includes(p))
    for (const pair of adjacentPairs(mine)) {
      const k = `${pair[0].id}→${pair[1].id}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(pair)
    }
  }
  return out
}
```

`planLegSync` 加參數並換 `wanted` 來源（原 L36-37）：

```ts
export function planLegSync(
  stops: SyncStop[],
  legs: SyncLeg[],
  nowMs: number,
  roster: readonly string[] = [],
): LegSyncPlan {
  const key = (f: string, t: string) => `${f}→${t}`
  const wanted = new Map(participantPairs(stops, roster).map(([f, t]) => [key(f.id, t.id), { from: f, to: t }]))
```

其餘 detachAuto／removeAuto／markStale／recompute 判準**一字不改**。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- legSync`
Expected: PASS（既有案例全數維持綠——它們沒傳 roster，走預設 `[]`）

- [ ] **Step 5: sync route 接線**

`src/app/api/trips/[tripId]/legs/sync/route.ts`：

trips 查詢加 `participants`（若目前沒查 trips，另起一個併發查詢）；stops 的 select（L43）加 `participant_ids`；L72-75 的 map 加 `participantIds: s.participant_ids`；L80 改為：

```ts
const roster = parseRoster(tripRow?.participants).map(p => p.id)
const plan = planLegSync(stops, legs, now, roster)
```

- [ ] **Step 6: 全套測試 + 型別**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: 全綠

- [ ] **Step 7: Commit**

```bash
git add src/lib/domain/legSync.ts src/lib/domain/legSync.test.ts src/app/api/trips/\[tripId\]/legs/sync/route.ts
git commit -m "feat: 交通段依參與人分軌生成，修掉分頭行動的幻影路段"
```

---

## Task 5：衝突偵測分軌

**Files:**
- Modify: `src/lib/domain/conflicts.ts`
- Modify: `src/lib/domain/conflicts.test.ts`

- [ ] **Step 1: 寫失敗的測試**

```ts
describe('detectConflicts 分軌', () => {
  const s = (id: string, from: number, to: number, participantIds: unknown = null) =>
    ({ id, startsAt: from * 3_600_000, endsAt: to * 3_600_000, participantIds })

  it('不同人時間重疊＝分頭行動，不報 overlap', () => {
    const stops = [s('A', 11, 12, ['p1']), s('B', 11, 12, ['p2'])]
    expect(detectConflicts(stops, [], ['p1', 'p2'])).toEqual([])
  })

  it('同一個人時間重疊仍是真衝突', () => {
    const stops = [s('A', 11, 13, ['p1']), s('B', 12, 14, ['p1'])]
    expect(detectConflicts(stops, [], ['p1', 'p2']))
      .toEqual([{ type: 'overlap', stopIds: ['A', 'B'] }])
  })

  it('全員的停留點與任何人重疊都算衝突（未指派＝全員）', () => {
    const stops = [s('A', 11, 13), s('B', 12, 14, ['p1'])]
    expect(detectConflicts(stops, [], ['p1', 'p2']))
      .toEqual([{ type: 'overlap', stopIds: ['A', 'B'] }])
  })

  it('同一組衝突被多人各自偵測到時只回報一次', () => {
    const stops = [s('A', 11, 13), s('B', 12, 14)]
    expect(detectConflicts(stops, [], ['p1', 'p2', 'p3'])).toHaveLength(1)
  })

  it('名冊為空時逐項等同現行行為', () => {
    const stops = [s('A', 11, 13), s('B', 12, 14)]
    expect(detectConflicts(stops, [], [])).toEqual(detectConflicts(stops, []))
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- conflicts`
Expected: FAIL（第一個案例回報 overlap）

- [ ] **Step 3: 實作**

`conflicts.ts` — `StopSchedule` 加 `participantIds: unknown`；把現有函式本體改名為內部的 `detectInTrack`，外層改成：

```ts
import { resolveStopParticipants } from './participants'

/** 分軌後的衝突偵測（設計文件 §4.3）：同一個人時間重疊才是真衝突；不同人重疊是分頭行動。
 *  roster 省略或為空時逐項等同分軌前的行為（測試鎖住）。 */
export function detectConflicts(
  stops: StopSchedule[],
  legs: LegDuration[],
  roster: readonly string[] = [],
): ScheduleWarning[] {
  if (roster.length === 0) return detectInTrack(stops, legs)
  const resolved = new Map(stops.map(s => [s.id, resolveStopParticipants(s.participantIds, roster)]))
  const seen = new Set<string>()
  const out: ScheduleWarning[] = []
  for (const p of roster) {
    for (const w of detectInTrack(stops.filter(s => resolved.get(s.id)!.includes(p)), legs)) {
      // 同一組衝突會被同時參與的每個人各自偵測到，以內容去重
      const k = w.type === 'overlap'
        ? `overlap:${[...w.stopIds].sort().join('|')}`
        : `tight:${w.fromStopId}→${w.toStopId}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push(w)
    }
  }
  return out
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- conflicts`
Expected: PASS

- [ ] **Step 5: TripView 呼叫端補 roster**

`TripView.tsx` 呼叫 `detectConflicts` 的地方傳入 `rosterIds`（由 `parseRoster(trip.participants).map(p => p.id)` 以 `useMemo` 算，deps 為 `[trip.participants]`），stops 的 map 補 `participantIds: s.participant_ids`。

- [ ] **Step 6: Commit**

```bash
git add src/lib/domain/conflicts.ts src/lib/domain/conflicts.test.ts src/app/trips/\[tripId\]/TripView.tsx
git commit -m "feat: 衝突偵測按參與人分軌，分頭行動不再誤報時間重疊"
```

---

## Task 6：花費按參與者分攤

**Files:**
- Modify: `src/lib/domain/cost.ts`
- Modify: `src/lib/domain/cost.test.ts`

- [ ] **Step 1: 寫失敗的測試**

```ts
import { costByParticipant } from './cost'

describe('costByParticipant', () => {
  const roster = ['p1', 'p2', 'p3']

  it('未指派（null）＝全員均分', () => {
    expect(costByParticipant([{ estimatedCost: 900, participantIds: null }], roster))
      .toEqual({ p1: 300, p2: 300, p3: 300 })
  })

  it('只有部分人參與時，只分攤給他們', () => {
    expect(costByParticipant([{ estimatedCost: 900, participantIds: ['p1', 'p2'] }], roster))
      .toEqual({ p1: 450, p2: 450, p3: 0 })
  })

  it('除不盡時餘數按 id 字典序分給前幾人，總和嚴格等於原金額', () => {
    const r = costByParticipant([{ estimatedCost: 1000, participantIds: null }], roster)
    expect(r).toEqual({ p1: 334, p2: 333, p3: 333 })
    expect(r.p1 + r.p2 + r.p3).toBe(1000)
  })

  it('null 花費與 0 一律略過', () => {
    expect(costByParticipant([{ estimatedCost: null, participantIds: null }], roster))
      .toEqual({ p1: 0, p2: 0, p3: 0 })
  })

  it('名冊為空時回空物件', () => {
    expect(costByParticipant([{ estimatedCost: 900, participantIds: null }], [])).toEqual({})
  })

  it('不變量：任意組合下 sum(每人應付) === 總額', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      estimatedCost: (i * 37) % 1000,
      participantIds: i % 3 === 0 ? null : ['p1', 'p2', 'p3'].slice(0, (i % 3) + 1),
    }))
    const total = items.reduce((s, i) => s + (i.estimatedCost ?? 0), 0)
    const per = costByParticipant(items, roster)
    expect(Object.values(per).reduce((a, b) => a + b, 0)).toBe(total)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- cost`
Expected: FAIL，`costByParticipant is not a function`

- [ ] **Step 3: 實作**

追加到 `cost.ts`：

```ts
import { resolveStopParticipants } from './participants'

export type ParticipantCostItem = { estimatedCost: number | null; participantIds: unknown }

/** 每筆花費只分攤給該項目的參與人（設計文件 §6）。取代 perPersonCost 的全員均分。
 *
 *  【整數分攤，不用浮點除法】這是要拿去分帳的數字，1000 ÷ 3 再加回來不等於 1000。
 *  base = floor(金額 ÷ 人數)，餘數按 participant id 字典序分給前幾人各 +1——
 *  排序讓分配結果**決定性**（同一份資料每次算出同樣的帳），不是隨呼叫順序漂移。
 *  不變量（下方測試以 50 筆隨機組合鎖住）：sum(每人應付) === totalEstimatedCost(全部)。
 *
 *  金額先 Math.round：JPY/TWD 無小數，這是合理簡化（設計文件 §10 殘留風險）。 */
export function costByParticipant(
  items: ReadonlyArray<ParticipantCostItem>,
  roster: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(roster.map(p => [p, 0]))
  if (roster.length === 0) return out
  for (const item of items) {
    const amount = Math.round(item.estimatedCost ?? 0)
    if (amount <= 0) continue
    const who = [...resolveStopParticipants(item.participantIds, roster)].sort()
    const base = Math.floor(amount / who.length)
    let remainder = amount - base * who.length
    for (const p of who) {
      out[p] += base + (remainder > 0 ? 1 : 0)
      if (remainder > 0) remainder -= 1
    }
  }
  return out
}
```

`perPersonCost` 保留但加註解標示已被取代（它仍無消費端，刪除屬不相關改動）：

```ts
/** @deprecated 2026-08-11 起由 costByParticipant 取代——均分不考慮分頭行動，分帳會算錯。
 *  保留是因為刪除與本次改動無關；沒有任何 UI 消費端。 */
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- cost`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/cost.ts src/lib/domain/cost.test.ts
git commit -m "feat: 花費按實際參與者整數分攤（總和嚴格等於總額）"
```

---

## Task 7：識別樣式（首字 + 輔助色）

**Files:**
- Create: `src/app/trips/[tripId]/participantUi.ts`
- Test: `src/app/trips/[tripId]/participantUi.test.ts`

ΔE 掃描**已於排計畫時執行完畢**（設計文件 §5.3），本任務直接寫入結果，不需重跑。結論：既有 19 個保留色已佔滿紅／藍／紫／橘／粉，八色色盤最多只能到 ΔE 20.6（「需留意」），且最佳解是四個綠色系。故識別主體改為名字首字，顏色降為輔助的四色。

- [ ] **Step 1: 寫失敗的測試**

`src/app/trips/[tripId]/participantUi.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { PARTICIPANT_COLORS, participantColorAt, participantInitial } from './participantUi'

describe('participantColorAt', () => {
  it('依索引取色，超過色盤長度循環', () => {
    expect(participantColorAt(0)).toBe(PARTICIPANT_COLORS[0])
    expect(participantColorAt(PARTICIPANT_COLORS.length)).toBe(PARTICIPANT_COLORS[0])
  })
})

describe('participantInitial', () => {
  it('取名稱第一個字元', () => {
    expect(participantInitial('小明')).toBe('小')
    expect(participantInitial('Ken')).toBe('K')
  })

  it('emoji 等代理對不被截半（用 Array.from 而非 charAt）', () => {
    expect(participantInitial('👨‍💼阿姨')).toBe('👨')
  })

  it('空字串或全空白回退為 ?', () => {
    expect(participantInitial('')).toBe('?')
    expect(participantInitial('   ')).toBe('?')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- participantUi`
Expected: FAIL，`Failed to resolve import "./participantUi"`

- [ ] **Step 3: 實作**

`src/app/trips/[tripId]/participantUi.ts`：

```ts
/** 參與人的識別樣式。
 *
 *  【為何識別主體是首字而不是顏色】選色度量沿 categoryUi.ts:36-39 的 CIE ΔE（**不用 WCAG
 *  對比度**——那衡量明暗差，青與綠亮度幾乎相同卻一眼可辨）。對既有 19 個保留色
 *  （categoryUi 六桶 + RoutePolylines 五個模式色 + 選取/當日/他日/草稿針/選中備選/播放頭/
 *  紅線/步行灰）做全配對掃描並窮舉最佳子集，可達的最小 ΔE：
 *    4 色 28.8（一眼可辨）／5 色 26.1／6 色 23.7（需留意）／8 色 20.6（需留意）
 *  窮舉已確認這是上限。更關鍵的是 5 色最佳解是 lime-500/green-500/lime-700/teal-700 加
 *  fuchsia-500——**四個綠色系**，因為紅藍紫橘粉全被保留色佔走了。ΔE 26 數字上「可辨」，
 *  讀起來卻是「深淺不同的綠」，不是四個不同的人。
 *  故：首字是主要識別（不吃 ΔE 預算、20 人都能區分、不需圖例），顏色只做輔助分組。
 *
 *  新增顏色前必須重跑掃描——保留色一旦增加，這四色的 ΔE 也會跟著變。 */
export const PARTICIPANT_COLORS: readonly string[] = [
  '#84cc16', // lime-500
  '#22c55e', // green-500
  '#d946ef', // fuchsia-500
  '#4d7c0f', // lime-700
]

/** 依名冊順序指派顏色，超過四人循環（首字仍可區分，見上方註解）。 */
export function participantColorAt(index: number): string {
  return PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length]
}

/** 播放圖示上的字。用 Array.from 取第一個**碼位**，避免把 emoji 等代理對截半成亂碼。 */
export function participantInitial(name: string): string {
  return Array.from(name.trim())[0] ?? '?'
}

/** 多人同點時的合併圖示底色（中性，刻意不屬於任何參與人）。 */
export const MERGED_MARKER_COLOR = '#334155'
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- participantUi`
Expected: PASS（5 個案例）

- [ ] **Step 5: Commit**

```bash
git add src/app/trips/\[tripId\]/participantUi.ts src/app/trips/\[tripId\]/participantUi.test.ts
git commit -m "feat: 參與人識別樣式（首字為主、四色輔助，附 ΔE 掃描依據）"
```

---

## Task 8：名冊管理 UI

**Files:**
- Modify: `src/app/trips/[tripId]/MembersPanel.tsx`

- [ ] **Step 1: 新增參與人區塊**

在既有成員清單之後加一個 `<section>`：

- 列出 `parseRoster(trip.participants)`，每列顯示首字圖章（底色為其 `color`）、完整名字、來源標記（成員 / 同行者）。這個清單同時是播放圖示的對照表——兩人首字相同時使用者靠它辨認
- 「加入成員」：從尚未在名冊的 `members` 挑，`name` 取 `profileMap` 的 display_name
- 「加同行者」：純文字輸入，`user_id: null`
- 新增時的顏色：`participantColorAt(roster.length)` 自動指派。顏色存在名冊裡而非每次由索引推算——否則移除一個人會讓後面所有人的顏色跟著位移
- 改名；換色（從 `PARTICIPANT_COLORS` 四色挑，允許重複——首字才是識別主體）
- 移除：先算出受影響的停留點數，二次確認後呼叫 RPC

- [ ] **Step 2: 寫入邏輯**

新增／改名／換色都是整包覆寫 `trips.participants`，走樂觀鎖：

```ts
const next = [...roster, { id: crypto.randomUUID(), user_id: userId, name, color }]
const { data, error } = await supabase
  .from('trips')
  .update({ participants: next })
  .eq('id', tripId)
  // 樂觀鎖：以掛載時讀到的名冊比對，防的是本分頁尚未觀察到的協作者改動
  .eq('participants', JSON.stringify(roster))
  .select('id')
if (!error && data.length === 0) {
  setNotice({ kind: 'error', text: '名冊已被其他人變更，請重新整理後再試' })
  router.refresh()
  return
}
```

⚠️ `.eq()` 比對 jsonb 需要與 DB 的正規化形式逐字相同，`JSON.stringify` 不保證。**改用讀回比對**：先 `select('participants')`，在 client 端比對是否與掛載時相同，不同就要求重新整理。這比不可靠的樂觀鎖誠實。

移除走 RPC：

```ts
const { error } = await supabase.rpc('remove_trip_participant', {
  p_trip_id: tripId,
  p_participant_id: id,
})
```

- [ ] **Step 3: 手動驗證**

`npm run dev` → 開行程 → 加兩個參與人（一個成員、一個同行者）→ 改名 → 換色 → 移除 → 確認名冊與停留點指派同步更新。

- [ ] **Step 4: Commit**

```bash
git add src/app/trips/\[tripId\]/MembersPanel.tsx
git commit -m "feat: 參與人名冊管理（新增成員/同行者、改名換色、移除連帶清掃）"
```

---

## Task 9：停留點指派 UI

**Files:**
- Create: `src/app/trips/[tripId]/ParticipantPicker.tsx`
- Modify: `src/app/trips/[tripId]/StopEditor.tsx`
- Modify: `src/app/trips/[tripId]/TripView.tsx`（側欄首字圖章）

- [ ] **Step 1: ParticipantPicker**

```tsx
/** 參與人多選。「全員」是獨立的一個選項而非「全部勾選」——兩者在 DB 是不同的值
 *  （null vs 完整陣列），而「全員」的語義是「之後加入的人也自動包含」。 */
export default function ParticipantPicker({
  roster, value, onChange,
}: {
  roster: readonly Participant[]
  /** null ＝ 全員 */
  value: string[] | null
  onChange: (next: string[] | null) => void
}) {
```

行為：
- 「全員」核取方塊；勾選時 `onChange(null)`
- 取消「全員」時 `onChange(roster.map(p => p.id))`（不是空陣列——DB 禁止）
- 個別勾選；取消到剩 0 人時**不允許**，顯示「至少要有一位參與人，或選『全員』」
- `roster` 為空時整個元件不渲染

- [ ] **Step 2: StopEditor 接上**

`stop` prop 已有 `participant_ids`。加 state：

```ts
const [participantIds, setParticipantIds] = useState<string[] | null>(
  Array.isArray(stop.participant_ids) ? (stop.participant_ids as string[]) : null,
)
```

`save()` 的 update 物件（L52-60）加 `participant_ids: participantIds`。

JSX 在「鎖定時間」核取方塊（L138-141）之前插入 `<ParticipantPicker …/>`。

新 props：`roster: readonly Participant[]`，由 TripView 傳入。

- [ ] **Step 3: 側欄首字圖章**

TripView 的停留點列渲染處：`resolveStopParticipants(stop.participant_ids, rosterIds)` 的長度**小於** roster 長度時，渲染該些參與人的首字小圖章；等於全員時不渲染。

「全員時不渲染」不只是為了避免每列掛滿圖示——側欄的圖章語義是「這一段只有這些人」，共同行程本來就不需要標註，標了反而讓真正的分頭段落淹沒在雜訊裡。

- [ ] **Step 4: 手動驗證**

指派一個停留點給單一參與人 → 重整後仍在 → 側欄出現該人的首字圖章 → 改回全員 → 圖章消失。

- [ ] **Step 5: Commit**

```bash
git add src/app/trips/\[tripId\]/ParticipantPicker.tsx src/app/trips/\[tripId\]/StopEditor.tsx src/app/trips/\[tripId\]/TripView.tsx
git commit -m "feat: 停留點參與人指派 UI 與側欄首字圖章"
```

---

## Task 10：多軌播放

**Files:**
- Modify: `src/app/trips/[tripId]/TripView.tsx`（L865-940 播放管線、L1444 PlaybackTrail）

這是最大的一塊。現行管線是單軌：`posStops`(L865) → `interpolatePosition`(L874) / `segmentAt`(L878) → `travelPath`(L887) → `travelPos`(L894) → `completedPaths`(L922) → `PlaybackTrail`(L1444)。

- [ ] **Step 1: 把管線提成 per-participant**

新增 `focusedParticipant: string | null` state（null ＝ 全部）。

⚠️ 先確認 `posStops`(L865) 的 map 有帶上 `participantIds: s.participant_ids`——它目前只取 id/startsAt/endsAt/lat/lng，沒補的話下面的 filter 恆為全員，分軌靜默失效而畫面看不出異常。

```ts
/** 播放軌道：每個參與人一條。名冊為空或聚焦單人時只有一條，逐項退回現行單軌行為。 */
const tracks = useMemo(() => {
  const ids: (string | null)[] = focusedParticipant !== null ? [focusedParticipant]
    : rosterIds.length > 0 ? [...rosterIds] : [null]
  return ids.map(pid => ({
    participantId: pid,
    stops: pid === null ? posStops
      : posStops.filter(s => resolveStopParticipants(s.participantIds, rosterIds).includes(pid)),
  }))
}, [focusedParticipant, rosterIds, posStops])

/** 每條軌道在播放頭時刻的位置。L874 的單軌 interpolatePosition 改成對每條軌道各算一次。 */
const trackPositions = useMemo(
  () => tracks.map(t => ({
    participantId: t.participantId,
    pos: clampedPlayheadMs === null ? null : interpolatePosition(t.stops, clampedPlayheadMs),
  })),
  [tracks, clampedPlayheadMs],
)
```

`segmentAt`(L878)／`travelPath`(L887)／`completedPaths`(L922) 同樣改成對 `tracks` 各算一次。`interpolate.ts`、`resolveRoutePath`、`PlaybackTrail` 本身**都不改**——它們接收的都是已 filter 過的停留點陣列。

⚠️ 保持 memo 語義：`tracks` 的參照每 render 變動會讓下游全部重算（L820-821 已為 `stopById` 記錄過同一個坑），deps 必須精確。

- [ ] **Step 2: 圖示合併**

```ts
/** 全員在同一點時 N 個圖示會完全重疊。以四捨五入到小數 5 位（約 1 公尺）分組後合併。 */
const markerGroups = useMemo(() => {
  const key = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
  const groups = new Map<string, { pos: { lat: number; lng: number }; participantIds: (string | null)[] }>()
  for (const t of trackPositions) {
    if (!t.pos) continue
    const k = key(t.pos)
    const g = groups.get(k)
    if (g) g.participantIds.push(t.participantId)
    else groups.set(k, { pos: t.pos, participantIds: [t.participantId] })
  }
  return [...groups.values()]
}, [trackPositions])
```

圖示內容（設計文件 §5.2／§5.3）：

- 組內 1 人 → `participantInitial(name)`，底色 `participantColorAt(名冊索引)`
- 組內 > 1 人 → 人數數字，底色 `MERGED_MARKER_COLOR`
- `participantId` 為 null（名冊為空的退化路徑）→ 沿用現行播放頭樣式，不套任何參與人樣式

軌跡線不合併（重疊時視覺上無差別，分岔時必須各自可見）。

- [ ] **Step 3: 相機**

全部模式改用 `fitBounds` 涵蓋所有 `markerGroups`（分頭自動拉遠、會合自動拉近）；單人模式沿用現行 `CameraFollow`(L113-119)。

- [ ] **Step 4: 「看誰的行程」下拉**

播放列加 `<select>`：「全部」＋ 每個參與人。名冊為空時不渲染。切換時不重置播放頭。

- [ ] **Step 5: 首字對照**

圖示上的首字在多數情況已足夠自我說明，不需要常駐圖例。但兩個人首字相同時（設計文件 §10 允許此情況）需要補救：圖示 hover 顯示完整名字（`title` 屬性），側欄的參與人清單是完整對照表。

- [ ] **Step 6: 手動驗證**

建一個分頭行程 → 播放 → 確認分岔時出現兩個圖示各顯示自己的首字、各走各的線 → 會合時合併成一個顯示「2」→ 切單人只剩一條 → 相機在分岔時拉遠、會合時拉近。

- [ ] **Step 7: Commit**

```bash
git add src/app/trips/\[tripId\]/TripView.tsx
git commit -m "feat: 多軌播放（分頭時多圖示、同點合併、看誰下拉、fitBounds 相機）"
```

---

## Task 11：花費面板、匯出、快照、分享

**Files:**
- Modify: `src/app/trips/[tripId]/CostSummary.tsx`
- Modify: `src/lib/domain/exportRows.ts` + `exportRows.test.ts`
- Modify: `src/app/trips/[tripId]/ExportButtons.tsx`
- Modify: `src/lib/domain/snapshot.ts` + `snapshot.test.ts`
- Modify: `src/lib/supabase/share.test.ts`
- Modify: `src/app/share/view/page.tsx`

- [ ] **Step 1: CostSummary 每人應付**

props 加 `roster: readonly Participant[]`。在「總計」列（L42-45）之後加：

```tsx
{roster.length > 0 && (
  <>
    {roster.map(p => (
      <li key={p.id} className="flex justify-between gap-2 text-gray-600">
        <span>{p.name}</span>
        <span className="tabular-nums">{currency} {perParticipant[p.id] ?? 0}</span>
      </li>
    ))}
  </>
)}
```

- [ ] **Step 2: exportRows 加欄與列別**

`ItineraryRow`（L32-37）：`stop` 與 `leg` 各加 `participants: string`；新增 `| { kind: 'participantTotal'; name: string; cost: number }`。

停留點列的值：`resolveStopParticipants(...)` 長度等於 roster 長度時輸出 `'全員'`，否則名字逗號分隔。
交通列的值：`legParticipants(前, 後)` 同上規則。

`participantTotal` 列排在 `total`(L112) 之後。

測試加不變量：`sum(participantTotal) === total`。

- [ ] **Step 3: xlsx 輸出新欄與新列別**

`src/app/api/trips/[tripId]/export/xlsx/route.ts`：

L49-56 的 `sheet.columns` 在「花費」與「備註」之間插入：

```ts
    { header: '參與人', key: 'participants', width: 18 },
```

⚠️ exceljs 的 `columns` 是位置對應——插入新欄後，**下方所有 `addRow` 的物件都必須補上 `participants` 鍵**（漏掉的列不會報錯，只會空白，而且欄位會靜默錯位）。L64-78 的五個分支逐一補：`day`／`categoryTotal`／`total` 補 `participants: ''`，`stop`／`leg` 補 `participants: row.participants`。

新增第六個分支（放在 `total` 之後）：

```ts
    } else if (row.kind === 'participantTotal') {
      const r = sheet.addRow({ time: '', item: `　${row.name}`, category: '', minutes: '', cost: row.cost, notes: '', participants: '' })
      r.font = { italic: true }
```

⚠️ 參與人名字是使用者輸入，會進 Excel 儲存格。L59 的防公式注入不變量（「一律傳純字串／數字字面值，絕不傳 `{ formula: … }` 物件」）已涵蓋這個新來源——名字以純字串傳入，exceljs 不會把 `=SUM(…)` 這種內容解讀成公式。**不要**為了「讓名字看起來好看」改用 rich text 或 formula 物件。

- [ ] **Step 4: snapshot 收錄**

`SnapshotTrip` 加 `participants`，`SnapshotStop` 加 `participant_ids`，builder 用 `parseRoster` / `resolveStopParticipants` 清洗後才落進凍結副本。

檔頭 L12-15 已為 `custom_path` 寫下「使用者資料的例外條款」，本功能沿用同一段推理，補一句說明參與人同屬此類。

⚠️ `user_id` **不收錄**——下游沒有消費端需要它，減少外洩面。

- [ ] **Step 5: share.test.ts**

`TRIP_KEYS`(L20) 加 `'participants'`；`STOP_KEYS`(L21-24) 加 `'participant_ids'`。

新增斷言鎖住 `user_id` 不外洩：

```ts
it('分享頁的參與人只含 id/name/color——user_id 是 auth.users UUID，絕不可給匿名訪客', async () => {
  const { data } = await anon.rpc('get_shared_trip', { p_token: shareToken })
  for (const p of data.trip.participants) {
    expect(Object.keys(p).sort()).toEqual(['color', 'id', 'name'])
  }
})
```

beforeAll 需先寫入一筆含 `user_id` 的名冊，否則這條斷言在空陣列上恆真而測不到東西。

- [ ] **Step 6: share/view/page.tsx**

`SharedTripPayload` 直接重用 TripView 的 `Trip`/`Stop`（已含新欄位），確認 `participants` 的 `unknown` 型別能吃下投影後的三鍵物件。

- [ ] **Step 7: 全套測試**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: 全綠（含帶 Supabase env 的整合測試——`share.test.ts` 的鍵集合全等斷言是這一步的守門）

- [ ] **Step 8: Commit**

```bash
git add src/app/trips/\[tripId\]/CostSummary.tsx src/lib/domain/exportRows.ts src/lib/domain/exportRows.test.ts src/app/trips/\[tripId\]/ExportButtons.tsx src/lib/domain/snapshot.ts src/lib/domain/snapshot.test.ts src/lib/supabase/share.test.ts src/app/share/view/page.tsx
git commit -m "feat: 參與人接上花費面板、Excel、快照與分享頁"
```

---

## Task 12：E2E、README、總審與部署

**Files:**
- Create: `e2e/participants.spec.ts`
- Modify: `README.md`

- [ ] **Step 1: E2E**

前綴 `e2e-participants-`，afterAll 翻頁清理（比照 `candidates.spec.ts:139-158`）。

流程：
1. 建行程 → 加參與人甲、乙 → 加四個停留點 A(共同)、B(甲)、C(乙)、D(共同)
2. 觸發 sync → **斷言交通段恰為 A→B、A→C、B→D、C→D，且不存在 B→C**
3. 斷言 B 與 C 時間重疊但**沒有**衝突警告
4. 花費：A 標 900 → 斷言每人各 450（甲乙兩人）
5. 播放 → 斷言分岔時段有兩個播放圖示
6. 分享頁可見參與人，且回傳的 participant 物件無 `user_id`
7. 移除甲 → 斷言 B 的指派回到全員

- [ ] **Step 2: 遷移風險的回歸測試**

單獨一條：建行程 → 兩個時間重疊的停留點（無參與人）→ sync 生出幻影段 → 給幻影段填花費 → 加參與人並指派使其脫離配對 → 再 sync → **斷言該段變成 `source='manual'` 而非消失**（`legSync.ts:43-49` 的 detachAuto 規則，設計文件 §4.2）。

- [ ] **Step 3: 跑全套 E2E**

Run: `npx playwright test`
Expected: 全綠

- [ ] **Step 4: 手機實測**

DevTools 375px 或實機：參與人多選在窄螢幕可操作、播放圖示的首字在小尺寸下仍可讀。

- [ ] **Step 5: README**

功能清單加一行；已知限制加「同一對停留點之間只能有一段交通，兩組人搭不同工具需在中間插一個停留點」。

- [ ] **Step 6: 總審**

```
Agent(subagent_type="devteam:critic", prompt="審查參與人指派的完整 diff…")
Agent(subagent_type="devteam:db-expert", prompt="審查 20260811000000_participants.sql…")
```

- [ ] **Step 7: 部署**

1. `supabase db push --linked`（**注意：此指令完成時會 hang，是已知上游 bug——kill 後改用下一步驗證**）
2. `supabase migration list --linked` 確認 local/remote 對齊（應為 17/17）
3. 才合併程式碼觸發 Vercel 部署
4. 線上驗證：既有的九州行程路線與播放**與部署前完全一致**（roster 為空 → 全部退回單軌）

- [ ] **Step 8: Commit**

```bash
git add e2e/participants.spec.ts README.md
git commit -m "test: 參與人 E2E（分軌、幻影段轉存、分享不外洩 user_id）"
```

---

## 驗證

**每個 Task 結束跑**：`npm test`、`npx tsc --noEmit`、`npm run lint`

**全案完成後**：
1. `npx playwright test` 全套
2. `supabase migration list --linked` 17/17 對齊
3. **九州行程零變化**——這是最重要的一條：名冊為空時所有新路徑都必須退回現行行為
4. 清理所有 `e2e-participants-` 測試資料
5. 確認未動到 `九州0802-0808`、`demo@test.local`、`ken19960728ken@gmail.com`

---

## 不在本計畫範圍

- **同一對停留點多段交通**（兩組人搭不同工具）。需放寬 `legs_from_to_unique` 並讓 sync、衝突偵測、手繪路徑全部支援同一配對多段。變通：中間插一個停留點。
- **實際支出記帳**（誰先付、誰欠誰）。本計畫只處理「預估花費該算在誰頭上」。
- **依參與人過濾備選景點**。
