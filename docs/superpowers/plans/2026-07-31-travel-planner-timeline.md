# Travel Planner 時間軸（Plan 3/5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 時間的維度上線——Day 分頁時間軸、停留點色塊拖曳（連鎖順延 + 鎖定 + 衝突警示）、播放頭與地圖「我」標記、全面改用停留點當地時區顯示，並解除「多日預設時段疊加」與「跨時區顯示」兩個已知限制。

**Architecture:** 延續既有模式。時區精算引入 `date-fns-tz`（wall time ↔ UTC 雙向轉換）；連鎖順延依 spec §6 以資料庫 RPC 原子化執行（TS 的 `cascadeShift` 保留做 UI 預覽）；時間軸為純 client 元件（絕對定位比例布局），拖曳以 Pointer Events 實作；播放位置內插為純函式（TDD）。

**Tech Stack:** date-fns-tz / Postgres RPC（plpgsql）/ Pointer Events

**Spec:** `docs/superpowers/specs/2026-07-30-travel-planner-design.md` §5（時間軸機制、警示不阻擋）、§6（連鎖 RPC 原子化）
**衝刺目標：** 使用者 8/2 九州出發前交付。範圍刻意收斂：交通段屬 Plan 4；播放的鏡頭飛行與分享預設播放屬 Plan 5；時間軸上「拖邊緣改時長」不做（時長調整走既有 StopEditor），只做整塊平移。

**分支：** `git checkout -b feat/plan-3-timeline`（main 已含 Plan 1+2）。

---

## 檔案結構總覽

```
src/
├── lib/domain/
│   ├── tz.ts / tz.test.ts             # 當地時區轉換（新，TDD）
│   ├── days.ts / days.test.ts         # 按當地日期分組（新，TDD）
│   ├── interpolate.ts / .test.ts      # 播放位置內插（新，TDD）
│   └── datetime.ts / datetime.test.ts # 刪除（被 tz.ts 取代）
├── app/trips/[tripId]/
│   ├── TripView.tsx                   # activeDay/playhead 狀態、我標記、day-aware addStop
│   ├── Timeline.tsx                   # 時間軸元件（新）
│   └── StopEditor.tsx                 # datetime-local 時區化
supabase/migrations/
└── 20260801000000_cascade_shift.sql   # 連鎖順延 RPC（新）
src/lib/supabase/
└── rpc.test.ts                        # RPC 整合測試（新）
```

---

### Task 1: 時區轉換工具（TDD）

**Files:** Create `src/lib/domain/tz.ts`、`src/lib/domain/tz.test.ts`

- [ ] **Step 1: 安裝**

```bash
npm install date-fns date-fns-tz
```

（date-fns-tz v3 的 API 名為 `fromZonedTime`／`toZonedTime`；若安裝到 v2 則為 `zonedTimeToUtc`／`utcToZonedTime`——以 `node_modules/date-fns-tz/dist` 實際匯出為準，v2 時同語義替換並回報。）

- [ ] **Step 2: 失敗測試** — Create `src/lib/domain/tz.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { utcMsToWallInput, wallInputToUtcMs, formatLocalTime, localDateKey } from './tz'

// 固定用 Asia/Tokyo（UTC+9，無夏令）與 America/New_York（有夏令）——結果與執行機器的時區無關
describe('tz 轉換', () => {
  it('UTC → 東京牆面時間（datetime-local 格式）', () => {
    expect(utcMsToWallInput(Date.UTC(2026, 9, 1, 0, 0), 'Asia/Tokyo')).toBe('2026-10-01T09:00')
  })

  it('東京牆面時間 → UTC（雙向往返）', () => {
    const ms = wallInputToUtcMs('2026-10-01T09:00', 'Asia/Tokyo')
    expect(ms).toBe(Date.UTC(2026, 9, 1, 0, 0))
    expect(utcMsToWallInput(ms, 'Asia/Tokyo')).toBe('2026-10-01T09:00')
  })

  it('夏令時區的轉換正確（紐約 3 月）', () => {
    // 2026-03-15 紐約為 EDT（UTC-4）
    expect(wallInputToUtcMs('2026-03-15T08:00', 'America/New_York')).toBe(Date.UTC(2026, 2, 15, 12, 0))
  })

  it('formatLocalTime 輸出 HH:mm', () => {
    expect(formatLocalTime(Date.UTC(2026, 9, 1, 0, 30), 'Asia/Tokyo')).toBe('09:30')
  })

  it('localDateKey 依當地日期（跨日邊界）', () => {
    // UTC 10/1 16:00 = 東京 10/2 01:00
    expect(localDateKey(Date.UTC(2026, 9, 1, 16, 0), 'Asia/Tokyo')).toBe('2026-10-02')
  })
})
```

- [ ] **Step 3: 跑紅**（Cannot find module './tz'）→ **Step 4: 實作** — Create `src/lib/domain/tz.ts`:

```ts
import { fromZonedTime, toZonedTime, format } from 'date-fns-tz'

/** 停留點當地牆面時間（datetime-local 值）→ UTC epoch ms */
export function wallInputToUtcMs(input: string, timeZone: string): number {
  return fromZonedTime(input, timeZone).getTime()
}

/** UTC epoch ms → 停留點當地牆面時間（datetime-local 值 yyyy-MM-ddTHH:mm） */
export function utcMsToWallInput(ms: number, timeZone: string): string {
  return format(toZonedTime(ms, timeZone), "yyyy-MM-dd'T'HH:mm", { timeZone })
}

/** UTC epoch ms → 當地 HH:mm（清單/時間軸顯示用） */
export function formatLocalTime(ms: number, timeZone: string): string {
  return format(toZonedTime(ms, timeZone), 'HH:mm', { timeZone })
}

/** UTC epoch ms → 當地日期鍵 yyyy-MM-dd（Day 分組用） */
export function localDateKey(ms: number, timeZone: string): string {
  return format(toZonedTime(ms, timeZone), 'yyyy-MM-dd', { timeZone })
}
```

- [ ] **Step 5: 跑綠（5 tests）→ 全套 38 → Commit** `feat: 當地時區轉換工具`

---

### Task 2: 連鎖順延 RPC（migration + 整合測試）

**Files:** Create `supabase/migrations/20260801000000_cascade_shift.sql`、`src/lib/supabase/rpc.test.ts`

- [ ] **Step 1: migration**

```sql
begin;

-- 連鎖順延（spec §6：必須原子化）。security invoker：RLS 的 editor 政策照常生效。
-- 語義對齊 src/lib/domain/schedule.ts 的 cascadeShift：被改動點自身 + 其後（starts_at 較晚）
-- 且未鎖定的停留點整體平移；starts_at 相同者不動（與 TS 版的穩定排序差異已知且可接受）。
create or replace function public.cascade_shift_stops(
  p_trip_id uuid,
  p_changed_stop_id uuid,
  p_delta_seconds bigint
) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_changed_start timestamptz;
begin
  select starts_at into v_changed_start
  from public.stops
  where id = p_changed_stop_id and trip_id = p_trip_id;

  if v_changed_start is null then
    raise exception 'stop not found in trip';
  end if;

  -- 後續未鎖定停留點
  update public.stops
  set starts_at = starts_at + make_interval(secs => p_delta_seconds),
      ends_at   = ends_at   + make_interval(secs => p_delta_seconds)
  where trip_id = p_trip_id
    and locked = false
    and starts_at > v_changed_start
    and id <> p_changed_stop_id;

  -- 被改動點自身（即使鎖定也移動——是使用者親手拖它）
  update public.stops
  set starts_at = starts_at + make_interval(secs => p_delta_seconds),
      ends_at   = ends_at   + make_interval(secs => p_delta_seconds)
  where id = p_changed_stop_id and trip_id = p_trip_id;
end $$;

grant execute on function public.cascade_shift_stops(uuid, uuid, bigint) to authenticated;

commit;
```

- [ ] **Step 2: 本地套用**（db reset 故障的既有 workaround）：psql 灌檔 + history 記 `('20260801000000','cascade_shift')`。

- [ ] **Step 3: 整合測試** — Create `src/lib/supabase/rpc.test.ts`（比照 rls.test.ts 的模式：skipIf、隨機 email、afterAll 清 trip 與 users）：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const hasEnv = Boolean(url && anonKey && serviceKey)

const HOUR = 60 * 60

describe.skipIf(!hasEnv)('cascade_shift_stops RPC（需本地 Supabase）', () => {
  let admin: SupabaseClient
  let owner: SupabaseClient
  let stranger: SupabaseClient
  let ownerId: string | undefined
  let strangerId: string | undefined
  let tripId: string
  const stopIds: Record<string, string> = {}

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } })
    const suffix = Math.random().toString(36).slice(2, 8)
    const password = 'test-password-1234'
    const o = await admin.auth.admin.createUser({ email: `owner-${suffix}@test.local`, password, email_confirm: true })
    const s = await admin.auth.admin.createUser({ email: `stranger-${suffix}@test.local`, password, email_confirm: true })
    ownerId = o.data.user?.id
    strangerId = s.data.user?.id

    owner = createClient(url!, anonKey!, { auth: { persistSession: false } })
    stranger = createClient(url!, anonKey!, { auth: { persistSession: false } })
    await owner.auth.signInWithPassword({ email: `owner-${suffix}@test.local`, password })
    await stranger.auth.signInWithPassword({ email: `stranger-${suffix}@test.local`, password })

    const { data: trip, error } = await owner
      .from('trips')
      .insert({ title: 'RPC 測試行程', start_date: '2026-10-01', end_date: '2026-10-05', currency: 'JPY' })
      .select('id')
      .single()
    if (error) throw error
    tripId = trip.id

    // a: 09-10, b: 11-12, c(locked): 13-14, d: 15-16（UTC）
    for (const [key, sh, eh, locked] of [
      ['a', 9, 10, false], ['b', 11, 12, false], ['c', 13, 14, true], ['d', 15, 16, false],
    ] as const) {
      const { data, error: e } = await owner
        .from('stops')
        .insert({
          trip_id: tripId, name: `RPC-${key}`, lat: 33.59, lng: 130.4,
          timezone: 'Asia/Tokyo', locked,
          starts_at: new Date(Date.UTC(2026, 9, 1, sh)).toISOString(),
          ends_at: new Date(Date.UTC(2026, 9, 1, eh)).toISOString(),
        })
        .select('id')
        .single()
      if (e) throw e
      stopIds[key] = data.id
    }
  })

  afterAll(async () => {
    if (tripId) await admin.from('trips').delete().eq('id', tripId)
    if (ownerId) await admin.auth.admin.deleteUser(ownerId)
    if (strangerId) await admin.auth.admin.deleteUser(strangerId)
  })

  it('owner 平移 a +1 小時：a、b、d 順延，鎖定的 c 不動', async () => {
    const { error } = await owner.rpc('cascade_shift_stops', {
      p_trip_id: tripId, p_changed_stop_id: stopIds.a, p_delta_seconds: HOUR,
    })
    expect(error).toBeNull()

    const { data } = await owner
      .from('stops').select('name, starts_at').eq('trip_id', tripId).order('name')
    const starts = Object.fromEntries(data!.map(r => [r.name, new Date(r.starts_at).getTime()]))
    expect(starts['RPC-a']).toBe(Date.UTC(2026, 9, 1, 10))
    expect(starts['RPC-b']).toBe(Date.UTC(2026, 9, 1, 12))
    expect(starts['RPC-c']).toBe(Date.UTC(2026, 9, 1, 13)) // 鎖定不動
    expect(starts['RPC-d']).toBe(Date.UTC(2026, 9, 1, 16))
  })

  it('非成員呼叫 RPC 動不了任何列（RLS 生效）', async () => {
    await stranger.rpc('cascade_shift_stops', {
      p_trip_id: tripId, p_changed_stop_id: stopIds.b, p_delta_seconds: HOUR,
    })
    const { data } = await admin
      .from('stops').select('starts_at').eq('id', stopIds.b).single()
    expect(new Date(data!.starts_at).getTime()).toBe(Date.UTC(2026, 9, 1, 12)) // 維持上一測後的值
  })
})
```

（stranger 呼叫時 `select starts_at` 因 RLS 讀不到 → `v_changed_start is null` → raise exception，或 update 影響 0 列——兩種都符合「動不了」。斷言以 DB 實際值為準。）

- [ ] **Step 4: 跑綠（2 tests）→ 全套 40 → Commit** `feat: 連鎖順延 RPC 與整合測試`

---

### Task 3: 側欄與編輯器時區化

**Files:** Modify `TripView.tsx`（側欄時間顯示）、`StopEditor.tsx`（datetime-local 時區化）；Delete `src/lib/domain/datetime.ts` + `datetime.test.ts`

- [ ] **Step 1: StopEditor 換用 tz 工具**

```tsx
import { utcMsToWallInput, wallInputToUtcMs } from '@/lib/domain/tz'
```

- 初始值：`useState(utcMsToWallInput(new Date(stop.starts_at).getTime(), stop.timezone))`（ends 同）
- `save()` 的解析：`const startMs = wallInputToUtcMs(startsAt, stop.timezone)`（ends 同）
- 開始/結束兩個 label 文字改為「開始（當地時間）」「結束（當地時間）」，並在編輯器頂部加一行 `<p className="text-xs text-gray-400">{stop.timezone}</p>`

- [ ] **Step 2: 側欄名稱行加當地時間** — 名稱 button 內、編號徽章後：

```tsx
                <span className="mr-1 text-xs text-gray-400">
                  {formatLocalTime(new Date(stop.starts_at).getTime(), stop.timezone)}
                </span>
```

（import `formatLocalTime`。）

- [ ] **Step 3: 刪除被取代的 datetime.ts 與 datetime.test.ts**（先 grep 確認無其他引用），測試數 40 - 2 = 38。

- [ ] **Step 4: 驗證** lint/tsc/build/vitest 38/playwright → **Commit** `feat: 時間顯示與編輯全面改用停留點當地時區`

---

### Task 4: Day 分組純函式（TDD）+ addStop day-aware

**Files:** Create `src/lib/domain/days.ts`、`days.test.ts`；Modify `TripView.tsx`

- [ ] **Step 1: 失敗測試** — Create `src/lib/domain/days.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tripDayKeys } from './days'

describe('tripDayKeys', () => {
  it('起訖日期展開為連續日期鍵', () => {
    expect(tripDayKeys('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
  })

  it('起訖同日回傳單一鍵', () => {
    expect(tripDayKeys('2026-10-01', '2026-10-01')).toEqual(['2026-10-01'])
  })
})
```

（原設計曾含 groupByLocalDay 分組函式，自審發現 UI 實際只需 `localDateKey` 逐點過濾，未用的抽象依 YAGNI 移除。）

- [ ] **Step 2: 跑紅 → Step 3: 實作** — Create `src/lib/domain/days.ts`:

```ts
/** 行程起訖（yyyy-MM-dd）展開為連續日期鍵；用 UTC 正午避開時區日界問題 */
export function tripDayKeys(startDate: string, endDate: string): string[] {
  const keys: string[] = []
  const cur = new Date(`${startDate}T12:00:00Z`)
  const end = new Date(`${endDate}T12:00:00Z`)
  while (cur.getTime() <= end.getTime()) {
    keys.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return keys
}
```

- [ ] **Step 4: TripView 引入 activeDay 與 day-aware 預設時段** —

1. 狀態：`const [activeDay, setActiveDay] = useState<string | null>(null)`（null = 全部；Timeline 上線後 Task 5 會給它 Day 分頁 UI，本 Task 先接資料流）。
2. `addStop` 的 fallback 與 schedule 改為 day-aware：

```tsx
      const dayKeys = tripDayKeys(trip.start_date, trip.end_date)
      const targetDay = activeDay ?? dayKeys[0]
      // 該日的參考時區：當日已有停留點用其時區，否則沿用全行程最後一個停留點的時區，再不然用瀏覽器時區
      const dayStops = stops.filter(s => localDateKey(new Date(s.starts_at).getTime(), s.timezone) === targetDay)
      const refTz =
        dayStops[dayStops.length - 1]?.timezone ??
        stops[stops.length - 1]?.timezone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone
      const daySchedule = dayStops.map(s => ({
        id: s.id,
        startsAt: new Date(s.starts_at).getTime(),
        endsAt: new Date(s.ends_at).getTime(),
        locked: s.locked,
      }))
      const fallback = wallInputToUtcMs(`${targetDay}T09:00`, refTz)
      if (lastInsertedEndRef.current > 0) {
        daySchedule.push({ id: '__pending__', startsAt: lastInsertedEndRef.current - 1, endsAt: lastInsertedEndRef.current, locked: false })
      }
      const slot = nextDefaultSlot(daySchedule, fallback)
```

（取代原本的全行程 schedule 與 `T09:00:00` 瀏覽器時區 fallback；imports 補 `tripDayKeys`、`localDateKey`、`wallInputToUtcMs`。`lastInsertedEndRef` 在 `setActiveDay` 時一併歸零。）

- [ ] **Step 5: 驗證** vitest 40 全綠 + lint/tsc/build/playwright → **Commit** `feat: Day 分組與 day-aware 預設時段（解除多日疊加限制）`

---

### Task 5: Timeline 骨架（Day 分頁 + 色塊 + 選取聯動）

**Files:** Create `src/app/trips/[tripId]/Timeline.tsx`；Modify `TripView.tsx`

- [ ] **Step 1: Timeline 元件** — Create `src/app/trips/[tripId]/Timeline.tsx`:

```tsx
'use client'

import type { Stop } from './TripView'
import { formatLocalTime, localDateKey } from '@/lib/domain/tz'
import { detectConflicts } from '@/lib/domain/conflicts'

const HOUR_MS = 60 * 60 * 1000

export type TimelineProps = {
  stops: Stop[]
  dayKeys: string[]
  activeDay: string
  onDayChange: (day: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  playheadMs: number | null
  onPlayheadChange: (ms: number | null) => void
  onMove?: (stopId: string, deltaMs: number) => void // Task 6 接上拖曳提交
}

/** 當日視窗：停留點最早前 1h ~ 最晚後 1h；空日 fallback 當地 08:00–20:00 概念上以 UTC 對齊隱藏 */
export function dayWindow(dayStops: Stop[]): { start: number; end: number } | null {
  if (dayStops.length === 0) return null
  const starts = dayStops.map(s => new Date(s.starts_at).getTime())
  const ends = dayStops.map(s => new Date(s.ends_at).getTime())
  return { start: Math.min(...starts) - HOUR_MS, end: Math.max(...ends) + HOUR_MS }
}

export default function Timeline({
  stops, dayKeys, activeDay, onDayChange, selectedId, onSelect, playheadMs, onPlayheadChange,
}: TimelineProps) {
  const dayStops = stops
    .filter(s => localDateKey(new Date(s.starts_at).getTime(), s.timezone) === activeDay)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  const win = dayWindow(dayStops)
  const span = win ? win.end - win.start : 1
  const pct = (t: number) => ((t - (win?.start ?? 0)) / span) * 100

  const warnings = detectConflicts(
    dayStops.map(s => ({
      id: s.id,
      startsAt: new Date(s.starts_at).getTime(),
      endsAt: new Date(s.ends_at).getTime(),
      locked: s.locked,
    })),
    [], // 交通段 Plan 4 接入
  )
  const conflictIds = new Set(
    warnings.flatMap(w => (w.type === 'overlap' ? w.stopIds : [w.fromStopId, w.toStopId])),
  )

  return (
    <div className="border-t bg-background p-2">
      <div className="mb-2 flex items-center gap-1 overflow-x-auto">
        {dayKeys.map((key, i) => (
          <button
            key={key}
            type="button"
            onClick={() => onDayChange(key)}
            className={`shrink-0 rounded px-2 py-1 text-xs ${
              activeDay === key ? 'bg-foreground text-background' : 'border'
            }`}
          >
            D{i + 1} {key.slice(5)}
          </button>
        ))}
      </div>

      {win ? (
        <>
          <div className="relative h-12 rounded border">
            {dayStops.map(stop => {
              const s = new Date(stop.starts_at).getTime()
              const e = new Date(stop.ends_at).getTime()
              return (
                <button
                  key={stop.id}
                  type="button"
                  data-stop-block={stop.id}
                  onClick={() => onSelect(stop.id)}
                  title={`${stop.name} ${formatLocalTime(s, stop.timezone)}–${formatLocalTime(e, stop.timezone)}`}
                  className={`absolute top-1 bottom-1 overflow-hidden rounded px-1 text-left text-xs text-white ${
                    conflictIds.has(stop.id) ? 'bg-red-600' : selectedId === stop.id ? 'bg-blue-600' : 'bg-emerald-600'
                  }`}
                  style={{ left: `${pct(s)}%`, width: `${Math.max(pct(e) - pct(s), 1.5)}%` }}
                >
                  {stop.locked && '🔒'}
                  {stop.name}
                </button>
              )
            })}
            {playheadMs !== null && playheadMs >= win.start && playheadMs <= win.end && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-orange-500"
                style={{ left: `${pct(playheadMs)}%` }}
              />
            )}
          </div>
          <input
            className="mt-1 w-full"
            type="range"
            min={win.start}
            max={win.end}
            step={5 * 60 * 1000}
            value={playheadMs ?? win.start}
            onChange={e => onPlayheadChange(Number(e.target.value))}
            aria-label="時間軸播放頭"
          />
          <div className="flex justify-between text-xs text-gray-400">
            <span>{dayStops[0] && formatLocalTime(win.start, dayStops[0].timezone)}</span>
            <span>
              {playheadMs !== null && dayStops[0]
                ? `▶ ${formatLocalTime(playheadMs, dayStops[0].timezone)}`
                : ''}
            </span>
            <span>{dayStops[0] && formatLocalTime(win.end, dayStops[0].timezone)}</span>
          </div>
        </>
      ) : (
        <p className="p-2 text-xs text-gray-500">這一天還沒有行程，切到地圖加入停留點吧</p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: TripView 掛載** —

1. 狀態補 `const [playheadMs, setPlayheadMs] = useState<number | null>(null)`；`activeDay` 預設改為第一個日期鍵（`useState(() => tripDayKeys(trip.start_date, trip.end_date)[0])`，型別轉 `string`）。
2. 版面：`content` 的外層改為上下結構——上半 `flex min-h-0 flex-1`（側欄+地圖，既有內容），下方掛 `<Timeline ...>`：

```tsx
      <Timeline
        stops={stops}
        dayKeys={tripDayKeys(trip.start_date, trip.end_date)}
        activeDay={activeDay}
        onDayChange={day => {
          setActiveDay(day)
          setPlayheadMs(null)
          lastInsertedEndRef.current = 0
        }}
        selectedId={selectedId}
        onSelect={id => {
          setSelectedId(id)
          const s = stops.find(x => x.id === id)
          if (s) setCameraTarget({ lat: s.lat, lng: s.lng })
        }}
        playheadMs={playheadMs}
        onPlayheadChange={setPlayheadMs}
      />
```

3. 側欄清單改為只顯示 activeDay 的停留點（編號沿用當日順序），空狀態文案维持。

- [ ] **Step 3: 驗證** lint/tsc/build/vitest/playwright（E2E 的「還沒有停留點」斷言若受側欄過濾影響，同步把斷言改為當日空狀態文案——如實回報）→ **Commit** `feat: 時間軸骨架（Day 分頁、色塊、播放頭滑桿、衝突標紅）`

---

### Task 6: 時間軸拖曳平移（連鎖 + RPC 提交）

**Files:** Modify `Timeline.tsx`、`TripView.tsx`

- [ ] **Step 1: Timeline 拖曳** — 色塊 button 加 Pointer Events（拖曳與點擊區分：位移 < SNAP_MS（5 分鐘）視為點擊）：

```tsx
// Timeline 元件內新增狀態與處理器
import { useRef, useState } from 'react'

  const [drag, setDrag] = useState<{ id: string; startX: number; deltaMs: number } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const SNAP_MS = 5 * 60 * 1000

  function beginDrag(e: React.PointerEvent, stopId: string) {
    if (!win) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setDrag({ id: stopId, startX: e.clientX, deltaMs: 0 })
  }
  function moveDrag(e: React.PointerEvent) {
    if (!drag || !trackRef.current || !win) return
    const pxPerMs = trackRef.current.clientWidth / span
    const rawDelta = (e.clientX - drag.startX) / pxPerMs
    setDrag({ ...drag, deltaMs: Math.round(rawDelta / SNAP_MS) * SNAP_MS })
  }
  function endDrag() {
    if (!drag) return
    const { id, deltaMs } = drag
    setDrag(null)
    if (Math.abs(deltaMs) >= SNAP_MS && onMove) onMove(id, deltaMs)
    else onSelect(id) // 位移過小視為點擊
  }
```

- 軌道 div 加 `ref={trackRef}`；每個色塊 button 加 `onPointerDown={e => beginDrag(e, stop.id)} onPointerMove={moveDrag} onPointerUp={endDrag}`，且被拖曳中的色塊位置加上預覽偏移：`left` 計算改為 `pct(s + (drag?.id === stop.id ? drag.deltaMs : 0))`（width 同步用偏移後的 s/e）。拖曳中把原本的 `onClick` 行為交由 endDrag 的位移判斷（onClick 移除，統一走 pointer 流程）。
- 拖曳中軌道上方顯示提示：`{drag && <div className="text-xs text-orange-500">{drag.deltaMs > 0 ? '+' : ''}{Math.round(drag.deltaMs / 60000)} 分鐘（放開套用，之後行程自動順延）</div>}`

- [ ] **Step 2: TripView 提交處理** —

```tsx
  async function moveStop(stopId: string, deltaMs: number) {
    if (busyRef.current || stopsError) return
    busyRef.current = true
    setBusy(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.rpc('cascade_shift_stops', {
        p_trip_id: trip.id,
        p_changed_stop_id: stopId,
        p_delta_seconds: Math.round(deltaMs / 1000),
      })
      if (error) {
        setNotice({ kind: 'error', text: '時間調整失敗，請稍後再試' })
        return
      }
      setNotice(null)
      router.refresh()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
```

Timeline 掛載處傳 `onMove={moveStop}`。

- [ ] **Step 3: 驗證** — 全套自動化綠；手動（dev server）：拖一個色塊 30 分鐘 → 後面未鎖定的跟著動、鎖定的不動、重疊時變紅、Studio 確認 DB 值。→ **Commit** `feat: 時間軸拖曳平移（連鎖順延 RPC、鎖定不動、5 分鐘吸附）`

---

### Task 7: 播放位置內插與地圖「我」標記（TDD）

**Files:** Create `src/lib/domain/interpolate.ts`、`interpolate.test.ts`；Modify `TripView.tsx`

- [ ] **Step 1: 失敗測試** — Create `src/lib/domain/interpolate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { interpolatePosition } from './interpolate'

const HOUR = 60 * 60 * 1000
const stop = (id: string, s: number, e: number, lat: number, lng: number) => ({
  id, startsAt: s * HOUR, endsAt: e * HOUR, lat, lng,
})

describe('interpolatePosition', () => {
  const stops = [stop('a', 9, 10, 35.0, 139.0), stop('b', 12, 13, 36.0, 140.0)]

  it('停留期間回傳該停留點座標', () => {
    expect(interpolatePosition(stops, 9.5 * HOUR)).toEqual({ lat: 35.0, lng: 139.0 })
  })

  it('兩停留點之間線性內插', () => {
    // 10:00–12:00 的中點 11:00 → 座標中點
    expect(interpolatePosition(stops, 11 * HOUR)).toEqual({ lat: 35.5, lng: 139.5 })
  })

  it('第一個停留點之前回傳第一點；最後之後回傳最後點', () => {
    expect(interpolatePosition(stops, 8 * HOUR)).toEqual({ lat: 35.0, lng: 139.0 })
    expect(interpolatePosition(stops, 14 * HOUR)).toEqual({ lat: 36.0, lng: 140.0 })
  })

  it('空陣列回傳 null', () => {
    expect(interpolatePosition([], 0)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑紅 → Step 3: 實作** — Create `src/lib/domain/interpolate.ts`:

```ts
type PosStop = { id: string; startsAt: number; endsAt: number; lat: number; lng: number }

/** 播放頭時刻的「我」位置：停留中在該點；空檔在前後點間線性內插；界外取端點 */
export function interpolatePosition(
  stops: PosStop[],
  tMs: number,
): { lat: number; lng: number } | null {
  if (stops.length === 0) return null
  const sorted = [...stops].sort((a, b) => a.startsAt - b.startsAt)
  if (tMs <= sorted[0].startsAt) return { lat: sorted[0].lat, lng: sorted[0].lng }
  const last = sorted[sorted.length - 1]
  if (tMs >= last.endsAt) return { lat: last.lat, lng: last.lng }
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]
    if (tMs >= cur.startsAt && tMs <= cur.endsAt) return { lat: cur.lat, lng: cur.lng }
    const next = sorted[i + 1]
    if (next && tMs > cur.endsAt && tMs < next.startsAt) {
      const r = (tMs - cur.endsAt) / (next.startsAt - cur.endsAt)
      return { lat: cur.lat + (next.lat - cur.lat) * r, lng: cur.lng + (next.lng - cur.lng) * r }
    }
  }
  return { lat: last.lat, lng: last.lng }
}
```

- [ ] **Step 4: TripView 掛「我」標記 + 播放按鈕** —

1. 我標記（Map 內、CameraFollow 旁）：

```tsx
            {playheadMs !== null && (() => {
              const dayStops = stops
                .filter(s => localDateKey(new Date(s.starts_at).getTime(), s.timezone) === activeDay)
                .map(s => ({
                  id: s.id, lat: s.lat, lng: s.lng,
                  startsAt: new Date(s.starts_at).getTime(),
                  endsAt: new Date(s.ends_at).getTime(),
                }))
              const pos = interpolatePosition(dayStops, playheadMs)
              return pos ? (
                <AdvancedMarker position={pos} title="目前時刻位置">
                  <div className="h-4 w-4 rounded-full border-2 border-white bg-orange-500 shadow" />
                </AdvancedMarker>
              ) : null
            })()}
```

2. 播放按鈕（Timeline 的 Day 分頁列右側，props 增 `playing: boolean; onTogglePlay: () => void`）；TripView：

```tsx
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setPlayheadMs(prev => (prev === null ? null : prev + 10 * 60 * 1000)) // 每秒推進 10 分鐘
    }, 1000)
    return () => clearInterval(timer)
  }, [playing])
```

播放到視窗尾端自動停止：Timeline 的 `onPlayheadChange` 流程外，在 TripView 掛一個 effect——`playheadMs` 超出當日視窗即 `setPlaying(false)`（視窗計算 export 自 Timeline 的 `dayWindow`，以當日 stops 重算）。按鈕文案 `playing ? '⏸ 暫停' : '▶ 播放'`；按下播放時若 `playheadMs === null` 先設為視窗起點。

- [ ] **Step 5: 驗證** vitest 44 全綠 + 其他全套；手動：拖滑桿橘點沿路移動、播放自動前進。→ **Commit** `feat: 播放頭內插與地圖「我」標記、自動播放`

---

### Task 8: E2E 補強

**Files:** Modify `e2e/smoke.spec.ts`

- [ ] **Step 1:** 詳情頁斷言後追加：

```ts
  // 時間軸：Day 分頁存在且可切換
  await expect(page.getByRole('button', { name: /^D1 / })).toBeVisible()
  const d2 = page.getByRole('button', { name: /^D2 / })
  if (await d2.isVisible().catch(() => false)) {
    await d2.click()
  }
```

- [ ] **Step 2:** `npx playwright test` 綠（連跑兩次含清理驗證）→ **Commit** `test: E2E 補時間軸 Day 分頁斷言`

---

### Task 9: 收尾

**Files:** Modify `README.md`、spec

- [ ] **Step 1:** README：功能清單補時間軸段（Day 分頁、拖曳連鎖、播放頭與我標記、當地時區顯示）；「已知限制」**移除**「多日預設時段疊加」與「跨時區顯示」兩條（本 Plan 已解），**保留** mapId 與鏡頭完整運動（Plan 5）兩條，**新增**「時間軸拖曳目前僅支援整塊平移，時長調整請用編輯器」與「播放頭的鏡頭跟隨屬 Plan 5」。專案狀態補 Plan 3 ✅。
- [ ] **Step 2:** spec §8 殘留風險：cascade RPC 與 TS cascadeShift 的「同 starts_at 平手語義差異」記一列（TS 依輸入順序、SQL 不動平手者；實務入口已由 5 分鐘吸附大幅降低同刻機率）。
- [ ] **Step 3:** 全量驗證（lint/tsc/build/vitest 46/playwright）→ Commit `docs: Plan 3 收尾` → push 分支。

---

## 完成定義（Definition of Done)

- [ ] lint / tsc / build 乾淨；vitest 44 綠（33 既有 + tz 5 + rpc 2 − datetime 2 + days 2 + interpolate 4）；Playwright 綠且雙跑零殘留
- [ ] 手動（需金鑰）：Day 分頁切換、時間軸色塊對應當日行程、拖曳 30 分鐘後後續順延且鎖定不動、衝突變紅、播放頭拖動與播放時橘點沿路移動、編輯器顯示當地時間且儲存正確
- [ ] 多日行程在不同 Day 加點各自落在該日 09:00 起（舊「疊加」行為消失）
- [ ] 全部 commit 推上 feat/plan-3-timeline
