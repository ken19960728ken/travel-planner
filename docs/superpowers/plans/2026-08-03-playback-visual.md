# 播放視覺（分段取景 + 交通工具圖示 + 漸進紅線）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 播放時鏡頭以「當前交通段」取景、播放頭依交通方式換圖示、走過的路線以紅線漸進繪出；同時補上 Plan 5 Task 9 一直未做的靜態路線圖（polyline 實線 + flight 虛線）。

**Architecture:** 純 TS domain 層（polyline 解碼、大圓弧線、路徑取位、分段判定）先行、可完整單測；地圖層兩顆命令式 overlay 元件（RoutePolylines 靜態、PlaybackTrail 漸進）用 effect 管 google.maps.Polyline 生命週期；TripView 只加接線。分享頁重用 TripView，效果自動生效。

**Tech Stack:** Next.js 16、@vis.gl/react-google-maps（AdvancedMarker/useMap）、google.maps.Polyline（命令式）、vitest。

**設計文件：** `docs/superpowers/specs/2026-08-01-playback-visual-design.md`。五項待決已拍板：

| 待決 | 拍板 | 理由 |
|---|---|---|
| 停留期間取景 | (a) 維持前一段的框不動 | 減少鏡頭動作；起播時仍先 fitBounds 全日一次（既有行為保留） |
| 換段過渡 | 瞬間切換（fitBounds 一次到位） | 連續縮放動畫會穿越多層圖磚，正是灰塊事故溫床 |
| PLAYBACK_MAX_ZOOM 分級 | 依 mode：walking 16、其餘 15 | 步行段 fitBounds 天然會拉到 18-19，夾 16 保留街廓脈絡 |
| 圖示旋轉 | 只有 flight 旋轉（SVG 飛機）；地面模式 emoji 不旋轉 | 🚶🚇🚗 旋轉像倒下；✈️ emoji（U+2708+FE0F）跨平台朝向不一且違反 FE0F 約束，SVG 才能控 |
| 分享頁生效 | 生效（零額外程式碼，share/view 重用 TripView） | 分享頁預設自動播放，效果影響最大處 |

**硬性約束（全部任務適用）：**
- main 有分支保護 hook，一律開 feature branch
- lint 用 `npx eslint . --ignore-pattern "supabase/**" --ignore-pattern ".claude/**"`
- 全套驗證 = `npm test`（vitest）+ `npx tsc --noEmit` + 上述 eslint
- polyline 是 Google 衍生內容：**只渲染，不得寫進 snapshot.ts 快照/匯出**（snapshot.ts:10 已明文排除，不碰）
- 保留色不得挪用：`#2563eb` 選取、`#f59e0b` 選中備選、orange-500 播放頭橘點、六桶分類色（categoryUi.ts）

---

### Task 1: domain 層 — polyline 解碼、大圓弧線、路徑取位、分段判定

**Files:**
- Create: `src/lib/domain/polyline.ts`
- Create: `src/lib/domain/polyline.test.ts`
- Modify: `src/lib/domain/interpolate.ts`（新增 `segmentAt`，`interpolatePosition` 改為由它導出，行為不變）
- Modify: `src/lib/domain/interpolate.test.ts`（補 segmentAt 案例；既有案例一字不動，鎖行為不變）

- [ ] **Step 1: 失敗測試 — polyline.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { decodePolyline, greatCirclePoints, pathPosition, pathSlice } from './polyline'

describe('decodePolyline', () => {
  // Google 官方文件 Encoded Polyline Algorithm Format 的標準範例
  it('解碼官方範例', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
    expect(pts).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ])
  })
  it('空字串回空陣列', () => {
    expect(decodePolyline('')).toEqual([])
  })
})

describe('greatCirclePoints', () => {
  it('端點精確等於輸入、點數為 steps+1', () => {
    const from = { lat: 25.08, lng: 121.23 } // 桃園機場
    const to = { lat: 33.585, lng: 130.45 } // 福岡機場
    const pts = greatCirclePoints(from, to, 64)
    expect(pts).toHaveLength(65)
    expect(pts[0].lat).toBeCloseTo(from.lat, 9)
    expect(pts[64].lng).toBeCloseTo(to.lng, 9)
  })
  it('兩點重合時回兩個相同點（不除以零）', () => {
    const p = { lat: 33, lng: 130 }
    const pts = greatCirclePoints(p, p, 64)
    expect(pts[0]).toEqual(p)
    expect(pts[pts.length - 1]).toEqual(p)
    expect(pts.every(q => Number.isFinite(q.lat) && Number.isFinite(q.lng))).toBe(true)
  })
  it('中點在兩端點緯度之外側（大圓北彎，非直線內插）', () => {
    // 東京(35.68,139.77)→舊金山(37.77,-122.42) 的大圓中點緯度遠高於兩端（約 48 度）
    const pts = greatCirclePoints({ lat: 35.68, lng: 139.77 }, { lat: 37.77, lng: -122.42 }, 64)
    const mid = pts[32]
    expect(mid.lat).toBeGreaterThan(45)
  })
})

describe('pathPosition', () => {
  const path = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 1, lng: 1 },
  ]
  it('fraction 0 / 1 取端點', () => {
    expect(pathPosition(path, 0)).toMatchObject({ lat: 0, lng: 0 })
    expect(pathPosition(path, 1)).toMatchObject({ lat: 1, lng: 1 })
  })
  it('fraction 0.25 落在第一段中間、heading 朝東（≈90）', () => {
    const p = pathPosition(path, 0.25)!
    expect(p.lat).toBeCloseTo(0, 5)
    expect(p.lng).toBeCloseTo(0.5, 2)
    expect(p.headingDeg).toBeCloseTo(90, 0)
  })
  it('fraction 0.75 落在第二段、heading 朝北（≈0）', () => {
    const p = pathPosition(path, 0.75)!
    expect(p.lng).toBeCloseTo(1, 5)
    expect(p.headingDeg).toBeCloseTo(0, 0)
  })
  it('界外 fraction 夾回 [0,1]；空/單點路徑', () => {
    expect(pathPosition(path, -1)).toMatchObject({ lat: 0, lng: 0 })
    expect(pathPosition(path, 2)).toMatchObject({ lat: 1, lng: 1 })
    expect(pathPosition([], 0.5)).toBeNull()
    expect(pathPosition([{ lat: 5, lng: 5 }], 0.5)).toMatchObject({ lat: 5, lng: 5, headingDeg: 0 })
  })
})

describe('pathSlice', () => {
  const path = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 1, lng: 1 },
  ]
  it('fraction 0.25：含起點、首段頂點不含次段、末尾是內插目前點', () => {
    const s = pathSlice(path, 0.25)
    expect(s[0]).toEqual({ lat: 0, lng: 0 })
    expect(s[s.length - 1].lng).toBeCloseTo(0.5, 2)
  })
  it('fraction 1 等於整條；fraction 0 只有起點', () => {
    expect(pathSlice(path, 1)).toEqual(path)
    expect(pathSlice(path, 0)).toEqual([{ lat: 0, lng: 0 }])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗** — `npm test -- polyline`，預期 FAIL（模組不存在）。

- [ ] **Step 3: 實作 polyline.ts**

```ts
export type LatLng = { lat: number; lng: number }

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI

/** Google Encoded Polyline Algorithm Format 解碼（純 TS，不依賴 maps geometry library——
 *  播放位置在 render body 計算，SSR 期間碰不到 google 全域，必須自己解）。 */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = []
  let index = 0
  let lat = 0
  let lng = 0
  while (index < encoded.length) {
    for (const axis of ['lat', 'lng'] as const) {
      let result = 0
      let shift = 0
      let byte = 0x20
      while (byte >= 0x20) {
        byte = encoded.charCodeAt(index++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      }
      const delta = result & 1 ? ~(result >> 1) : result >> 1
      if (axis === 'lat') lat += delta
      else lng += delta
    }
    points.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }
  return points
}

/** 兩點間大圓弧線取樣（slerp）：flight 段的弧線與飛機位置共用同一條路徑，畫的線與動的點不會錯位。 */
export function greatCirclePoints(from: LatLng, to: LatLng, steps = 64): LatLng[] {
  const p1 = toRad(from.lat)
  const l1 = toRad(from.lng)
  const p2 = toRad(to.lat)
  const l2 = toRad(to.lng)
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2
  const delta = 2 * Math.asin(Math.min(1, Math.sqrt(a)))
  if (delta === 0) return [from, to]
  const sinDelta = Math.sin(delta)
  const pts: LatLng[] = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const A = Math.sin((1 - f) * delta) / sinDelta
    const B = Math.sin(f * delta) / sinDelta
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2)
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2)
    const z = A * Math.sin(p1) + B * Math.sin(p2)
    pts.push({ lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lng: toDeg(Math.atan2(y, x)) })
  }
  return pts
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function bearingDeg(a: LatLng, b: LatLng): number {
  const p1 = toRad(a.lat)
  const p2 = toRad(b.lat)
  const dl = toRad(b.lng - a.lng)
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** 依累計距離找 fraction 對應的位置與行進方位角（0=北、90=東）。fraction 界外夾回 [0,1]。 */
export function pathPosition(path: LatLng[], fraction: number): (LatLng & { headingDeg: number }) | null {
  if (path.length === 0) return null
  if (path.length === 1) return { ...path[0], headingDeg: 0 }
  const f = Math.min(1, Math.max(0, fraction))
  const segLens = path.slice(1).map((p, i) => haversineMeters(path[i], p))
  const total = segLens.reduce((s, v) => s + v, 0)
  if (total === 0) return { ...path[0], headingDeg: 0 }
  let remain = f * total
  for (let i = 0; i < segLens.length; i++) {
    if (remain <= segLens[i] || i === segLens.length - 1) {
      const r = segLens[i] === 0 ? 0 : Math.min(1, remain / segLens[i])
      const a = path[i]
      const b = path[i + 1]
      return {
        lat: a.lat + (b.lat - a.lat) * r,
        lng: a.lng + (b.lng - a.lng) * r,
        headingDeg: bearingDeg(a, b),
      }
    }
    remain -= segLens[i]
  }
  return { ...path[path.length - 1], headingDeg: bearingDeg(path[path.length - 2], path[path.length - 1]) }
}

/** 已走過的部分路徑（含內插的目前點）：漸進紅線的 path。 */
export function pathSlice(path: LatLng[], fraction: number): LatLng[] {
  if (path.length === 0) return []
  const f = Math.min(1, Math.max(0, fraction))
  if (f === 0) return [path[0]]
  if (f === 1) return [...path]
  const segLens = path.slice(1).map((p, i) => haversineMeters(path[i], p))
  const total = segLens.reduce((s, v) => s + v, 0)
  if (total === 0) return [path[0]]
  let remain = f * total
  const out: LatLng[] = [path[0]]
  for (let i = 0; i < segLens.length; i++) {
    if (remain <= segLens[i]) {
      const r = segLens[i] === 0 ? 0 : remain / segLens[i]
      const a = path[i]
      const b = path[i + 1]
      out.push({ lat: a.lat + (b.lat - a.lat) * r, lng: a.lng + (b.lng - a.lng) * r })
      return out
    }
    out.push(path[i + 1])
    remain -= segLens[i]
  }
  return out
}
```

- [ ] **Step 4: 跑測試確認通過** — `npm test -- polyline`，預期全綠。

- [ ] **Step 5: 失敗測試 — interpolate.test.ts 補 segmentAt 案例（既有案例一字不改）**

```ts
// 追加到既有檔案（import 行補 segmentAt）
describe('segmentAt', () => {
  const stops = [
    { id: 'a', startsAt: 1000, endsAt: 2000, lat: 0, lng: 0 },
    { id: 'b', startsAt: 3000, endsAt: 4000, lat: 1, lng: 1 },
  ]
  it('停留中回 stay', () => {
    expect(segmentAt(stops, 1500)).toEqual({ kind: 'stay', stopId: 'a' })
  })
  it('空檔回 travel + progress', () => {
    expect(segmentAt(stops, 2500)).toEqual({ kind: 'travel', fromStopId: 'a', toStopId: 'b', progress: 0.5 })
  })
  it('界外回端點 stay', () => {
    expect(segmentAt(stops, 500)).toEqual({ kind: 'stay', stopId: 'a' })
    expect(segmentAt(stops, 9999)).toEqual({ kind: 'stay', stopId: 'b' })
  })
  it('空陣列回 null；重疊取開始最早者（與 interpolatePosition 同語義）', () => {
    expect(segmentAt([], 1500)).toBeNull()
    const overlap = [
      { id: 'x', startsAt: 1000, endsAt: 3000, lat: 0, lng: 0 },
      { id: 'y', startsAt: 1200, endsAt: 2000, lat: 5, lng: 5 },
    ]
    expect(segmentAt(overlap, 1500)).toEqual({ kind: 'stay', stopId: 'x' })
  })
})
```

- [ ] **Step 6: 實作 segmentAt 並讓 interpolatePosition 改由它導出（行為不變，單一來源）**

interpolate.ts 重寫為：

```ts
type PosStop = { id: string; startsAt: number; endsAt: number; lat: number; lng: number }

export type PlaybackSegment =
  | { kind: 'stay'; stopId: string }
  | { kind: 'travel'; fromStopId: string; toStopId: string; progress: number }

/** 播放頭時刻的分段判定：停留中 stay（重疊取開始最早者）；空檔 travel（前後點 + 進度比例）；
 *  界外取端點 stay。與 interpolatePosition 同一份分支邏輯——後者已改為由本函式導出位置，
 *  不會再有兩份平行實作漂移。 */
export function segmentAt(
  stops: { id: string; startsAt: number; endsAt: number }[],
  tMs: number,
): PlaybackSegment | null {
  if (stops.length === 0) return null

  const covering = stops.filter(s => tMs >= s.startsAt && tMs <= s.endsAt)
  if (covering.length > 0) {
    const current = covering.reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
    return { kind: 'stay', stopId: current.id }
  }

  const earliest = stops.reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
  if (tMs <= earliest.startsAt) return { kind: 'stay', stopId: earliest.id }

  const latest = stops.reduce((a, b) => (b.endsAt > a.endsAt ? b : a))
  if (tMs >= latest.endsAt) return { kind: 'stay', stopId: latest.id }

  const before = stops.filter(s => s.endsAt <= tMs).reduce((a, b) => (b.endsAt > a.endsAt ? b : a))
  const after = stops.filter(s => s.startsAt >= tMs).reduce((a, b) => (b.startsAt < a.startsAt ? b : a))
  return {
    kind: 'travel',
    fromStopId: before.id,
    toStopId: after.id,
    progress: (tMs - before.endsAt) / (after.startsAt - before.endsAt),
  }
}

/** 播放頭時刻的「我」位置（直線內插版；有 polyline 的段落由呼叫端改用 pathPosition 沿路線取位）。 */
export function interpolatePosition(stops: PosStop[], tMs: number): { lat: number; lng: number } | null {
  const seg = segmentAt(stops, tMs)
  if (!seg) return null
  const byId = new Map(stops.map(s => [s.id, s]))
  if (seg.kind === 'stay') {
    const s = byId.get(seg.stopId)!
    return { lat: s.lat, lng: s.lng }
  }
  const from = byId.get(seg.fromStopId)!
  const to = byId.get(seg.toStopId)!
  return {
    lat: from.lat + (to.lat - from.lat) * seg.progress,
    lng: from.lng + (to.lng - from.lng) * seg.progress,
  }
}
```

- [ ] **Step 7: 全套驗證** — `npm test`（interpolate 既有案例必須全綠：行為不變的證明）+ `npx tsc --noEmit` + eslint。
- [ ] **Step 8: Commit** — `feat: polyline 解碼與播放分段 domain 層（大圓弧線、路徑取位、segmentAt）`

---

### Task 2: RoutePolylines 靜態路線（Plan 4 Task 7 過稿照抄 + flight 改弧線）

**Files:**
- Create: `src/app/trips/[tripId]/RoutePolylines.tsx`
- Modify: `src/app/trips/[tripId]/TripView.tsx`（僅掛載一行，掛在 `<CameraFollow …>` 之前）

依 `docs/superpowers/plans/2026-07-31-travel-planner-transit.md` Task 7 的完整過稿實作，**兩處增量**：
1. flight/無 polyline 段的虛線 path 改用 Task 1 的 `greatCirclePoints(from, to, 64)`（原稿用 geodesic 兩點直線；改弧線後與 Task 3 飛機取位共用同一條路徑，線與點零錯位），`geodesic` 選項移除（弧線已自帶取樣）。
2. 解碼改用 Task 1 的 `decodePolyline(leg.polyline)`，移除 `useMapsLibrary('geometry')` 依賴（少載一個 library）。

- [ ] **Step 1: RoutePolylines.tsx**（Plan 4 過稿為基礎，含上述兩處增量後的全文）

```tsx
'use client'

import { useEffect } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { decodePolyline, greatCirclePoints } from '@/lib/domain/polyline'
import type { Leg, Stop } from './TripView'

const MODE_COLOR: Record<Leg['mode'], string> = {
  transit: '#2563eb', walking: '#059669', driving: '#d97706', flight: '#7c3aed', custom: '#6b7280',
}

/** 選中日的交通段路線：有 polyline（Google 衍生）解碼實線；無 polyline（flight/manual）畫大圓弧虛線。
 *  google.maps.Polyline 非 React 元件，用 effect 管生命週期，cleanup 全量移除。 */
export default function RoutePolylines({
  legs, stops, selectedLegId,
}: {
  legs: Leg[]
  stops: Stop[]
  selectedLegId: string | null
}) {
  const map = useMap()

  useEffect(() => {
    if (!map) return
    const stopById = new Map(stops.map(s => [s.id, s]))
    const overlays: google.maps.Polyline[] = []
    for (const leg of legs) {
      const from = stopById.get(leg.from_stop_id)
      const to = stopById.get(leg.to_stop_id)
      if (!from || !to) continue
      const decoded = leg.polyline ? decodePolyline(leg.polyline) : null
      overlays.push(new google.maps.Polyline({
        map,
        path: decoded ?? greatCirclePoints({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }),
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
  }, [map, legs, stops, selectedLegId])

  return null
}
```

- [ ] **Step 2: TripView 掛載** — `<Map>` 內、`<CameraFollow …>` 之前：

```tsx
                <RoutePolylines
                  legs={legs.filter(l => activeDayStops.some(s => s.id === l.from_stop_id))}
                  stops={stops}
                  selectedLegId={selectedLegId}
                />
```

（import 行補 `import RoutePolylines from './RoutePolylines'`。）

- [ ] **Step 3: 全套驗證 + 手動** — 全套綠；`npm run dev` 開九州行程：選中日路線沿真實道路畫出、flight 段紫色虛弧線、點選交通段線變粗、切 Day 路線跟著換。
- [ ] **Step 4: Commit** — `feat: 選中日地圖路線（polyline 實線 + flight 大圓弧虛線）`

---

### Task 3: 播放頭交通圖示 + 沿路線取位 + 漸進紅線

**Files:**
- Create: `src/app/trips/[tripId]/PlaybackTrail.tsx`
- Modify: `src/app/trips/[tripId]/TripView.tsx`

**接線總覽（TripView）：** 在 `playheadPos` 計算處（`interpolatePosition` 呼叫，約 L636）之後新增「當前分段」推導；`legByPair` 已存在（約 L709）但宣告在 `playheadPos` 之後——**把 `nextByStopId`/`stopById`/`legByPair` 三個 Map 的宣告上移到 `activeDayStops` 之後**（純常量推導，無順序副作用），供分段推導使用。

- [ ] **Step 1: TripView 分段推導（component body，SSR 安全——全部純 TS）**

```tsx
  // 當前播放分段：stay（停留中）或 travel（交通中）。travel 時查對應 leg 取 mode 與 polyline，
  // 位置沿路線取位（有 polyline 走實路徑、flight 走大圓弧、其餘直線），取代單純兩點直線內插
  const posStops = activeDayStops.map(s => ({
    id: s.id, lat: s.lat, lng: s.lng,
    startsAt: new Date(s.starts_at).getTime(), endsAt: new Date(s.ends_at).getTime(),
  }))
  const segment = clampedPlayheadMs === null ? null : segmentAt(posStops, clampedPlayheadMs)
  const travelLeg =
    segment?.kind === 'travel' ? (legByPair.get(`${segment.fromStopId}→${segment.toStopId}`) ?? null) : null
  // 路徑解碼在 render body 每秒發生一次，長 polyline 需 memo（key：leg id + 座標端點）
  const travelPath = useMemo(() => {
    if (!travelLeg) return null
    if (travelLeg.polyline) return decodePolyline(travelLeg.polyline)
    const from = stopById.get(travelLeg.from_stop_id)
    const to = stopById.get(travelLeg.to_stop_id)
    if (!from || !to) return null
    if (travelLeg.mode === 'flight') {
      return greatCirclePoints({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng })
    }
    return null // 無 polyline 的地面段維持直線內插（資料就沒有路線）
  }, [travelLeg, stopById])
  const travelPos =
    segment?.kind === 'travel' && travelPath ? pathPosition(travelPath, segment.progress) : null
  const playheadDisplayPos = travelPos ?? playheadPos // travelPos 缺料時退回既有直線內插
```

（`playheadPos` 的計算改餵 `posStops`（同一份，不再重複 map）；`useMemo` 需補進 react import。`PlaybackCamera` 與「我」標記的 position 改用 `playheadDisplayPos`。）

- [ ] **Step 2: 播放頭標記換圖示** — 既有橘點 AdvancedMarker（約 L1042）改為：

```tsx
                {playheadDisplayPos && (
                  <AdvancedMarker position={playheadDisplayPos} title="目前時刻位置" anchorLeft="-50%" anchorTop="-50%">
                    {travelLeg && travelLeg.mode === 'flight' ? (
                      // SVG 飛機（emoji ✈️ 是 U+2708+FE0F，跨平台朝向不一且會退化黑白字元；SVG 朝向可控）
                      // viewBox 內機頭朝上（北），rotate 直接用方位角
                      <svg
                        width="28" height="28" viewBox="0 0 24 24"
                        style={{ transform: `rotate(${Math.round(travelPos?.headingDeg ?? 0)}deg)` }}
                        className="drop-shadow"
                      >
                        <path
                          d="M12 2 L14 9 L21 12 L14 13.5 L14 19 L16 21.5 L12 20 L8 21.5 L10 19 L10 13.5 L3 12 L10 9 Z"
                          fill="#7c3aed" stroke="#fff" strokeWidth="1"
                        />
                      </svg>
                    ) : travelLeg && travelLeg.mode !== 'custom' ? (
                      // 地面模式：emoji 徽章不旋轉（旋轉的行人/列車違反直覺）。🚇🚶🚗 預設 emoji 呈現，無 FE0F 問題
                      <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-white text-base shadow">
                        {MODE_ICON[travelLeg.mode]}
                      </div>
                    ) : (
                      <div className="h-4 w-4 rounded-full border-2 border-white bg-orange-500 shadow" />
                    )}
                  </AdvancedMarker>
                )}
```

- [ ] **Step 3: PlaybackTrail 漸進紅線元件**

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { pathSlice, type LatLng } from '@/lib/domain/polyline'

/** 播放漸進紅線：已完成的段落畫整條、進行中段落畫到目前位置（pathSlice）。
 *  疊在 RoutePolylines 的模式色細線上方（zIndex 高一層），紅 #dc2626、寬 4。
 *  每秒更新一次 path——重用同一個 Polyline 實例 setPath，不整批重建（重建會閃爍）。 */
export default function PlaybackTrail({
  completedPaths, currentPath, progress, active,
}: {
  /** 本日已走完的各段路徑（依時間順序） */
  completedPaths: LatLng[][]
  /** 進行中段落的完整路徑；null = 目前在停留中或缺料 */
  currentPath: LatLng[] | null
  progress: number
  active: boolean
}) {
  const map = useMap()
  const doneRef = useRef<google.maps.Polyline[]>([])
  const currentRef = useRef<google.maps.Polyline | null>(null)

  useEffect(() => {
    if (!map || !active) return
    const style = { strokeColor: '#dc2626', strokeOpacity: 0.9, strokeWeight: 4, zIndex: 10 }
    doneRef.current = completedPaths.map(p => new google.maps.Polyline({ map, path: p, ...style }))
    currentRef.current = new google.maps.Polyline({ map, path: [], ...style })
    return () => {
      doneRef.current.forEach(o => o.setMap(null))
      doneRef.current = []
      currentRef.current?.setMap(null)
      currentRef.current = null
    }
  }, [map, active, completedPaths])

  useEffect(() => {
    if (!currentRef.current) return
    currentRef.current.setPath(currentPath ? pathSlice(currentPath, progress) : [])
  }, [currentPath, progress])

  return null
}
```

- [ ] **Step 4: TripView 供料 PlaybackTrail** — `completedPaths` 用 useMemo（key：activeDay + 當前分段的識別；只在換段時重算，不逐秒重算）：

```tsx
  // 已走完的段落路徑：當日順序中，結束時刻早於當前分段起點的每一段。逐秒重算浪費（每段路徑固定），
  // memo key 取「當前所在分段的識別」——換段才重算
  const segmentKey =
    segment === null ? 'none' : segment.kind === 'stay' ? `stay:${segment.stopId}` : `travel:${segment.fromStopId}`
  const completedPaths = useMemo(() => {
    if (clampedPlayheadMs === null) return []
    const ordered = [...posStops].sort((a, b) => a.startsAt - b.startsAt)
    const out: LatLng[][] = []
    for (let i = 0; i < ordered.length - 1; i++) {
      const from = ordered[i]
      const to = ordered[i + 1]
      if (to.startsAt > clampedPlayheadMs) break // 這段還沒走完（含進行中——由 currentPath 負責）
      const leg = legByPair.get(`${from.id}→${to.id}`)
      if (leg?.polyline) out.push(decodePolyline(leg.polyline))
      else if (leg?.mode === 'flight') out.push(greatCirclePoints(from, to))
      else out.push([{ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }])
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 逐秒變動的 clampedPlayheadMs 刻意不入 deps，換段（segmentKey）才需要重算
  }, [segmentKey, activeDay, stops, legs])
```

掛載（`<RoutePolylines …>` 之後）：

```tsx
                <PlaybackTrail
                  completedPaths={completedPaths}
                  currentPath={segment?.kind === 'travel' ? (travelPath ?? (() => {
                    const f = stopById.get(segment.fromStopId)
                    const t = stopById.get(segment.toStopId)
                    return f && t ? [{ lat: f.lat, lng: f.lng }, { lat: t.lat, lng: t.lng }] : null
                  })()) : null}
                  progress={segment?.kind === 'travel' ? segment.progress : 0}
                  active={playing}
                />
```

（無 polyline 的地面段 currentPath 用兩點直線——與圖示的直線內插位置一致，紅線仍會漸進。）

- [ ] **Step 5: 全套驗證 + 手動** — 全套綠；手動播放第一天：飛機 SVG 沿弧線移動且機頭朝行進方向、紅線跟在後面長、抵達後停留期間顯示橘點、地面段顯示對應 emoji 徽章、播放結束紅線清除。
- [ ] **Step 6: Commit** — `feat: 播放頭交通圖示與漸進紅線（沿路線取位，flight 大圓弧）`

---

### Task 4: 分段取景（PlaybackCamera 換段 fitBounds + mode 分級 maxZoom）

**Files:** Modify `src/app/trips/[tripId]/TripView.tsx`（PlaybackCamera 元件與其呼叫端）

- [ ] **Step 1: PlaybackCamera 增段落取景**

型別與常量（PLAYBACK_MAX_ZOOM 附近）：

```tsx
/** 換段取景的縮放上限（分 mode）：步行段 fitBounds 天然拉到 18-19，夾 16 保留街廓脈絡；
 *  其餘沿用整日取景的 15。flight 遠距離 fitBounds 天然落在 6-9，上限實際不生效，統一寫上避免特例 */
const SEGMENT_MAX_ZOOM: Record<string, number> = {
  walking: 16, transit: 15, driving: 15, flight: 15, custom: 15,
}
```

PlaybackCamera 新增 props `segmentFitKey: string | null`（travel 段才有值：`travel:${fromStopId}`；stay 為 null）與 `segmentPath: { lat: number; lng: number }[] | null`、`segmentMaxZoom: number`。元件內新增第三個 effect（放在既有兩個 effect 之間）：

```tsx
  // 分段取景（2026-08-03 設計拍板）：播放推進到 travel 段時，以該段完整路徑 fitBounds 一次
  // （瞬間切換，不做連續縮放——zoom 6↔16 的過渡動畫會穿越大量中間層級圖磚，是灰塊事故溫床）。
  // stay 段 segmentFitKey 為 null，不動鏡頭（維持前一段的框，設計拍板 (a)）。
  // deps 只看 segmentFitKey：同一段內 progress 逐秒變動不得觸發 refit。
  // path/maxZoom 用 ref 讀最新值（同 boundsRef 模式——陣列參照每 render 都新）
  const segmentPathRef = useRef(segmentPath)
  const segmentMaxZoomRef = useRef(segmentMaxZoom)
  useEffect(() => {
    segmentPathRef.current = segmentPath
    segmentMaxZoomRef.current = segmentMaxZoom
  }, [segmentPath, segmentMaxZoom])
  useEffect(() => {
    if (!map || !active || !segmentFitKey) return
    const path = segmentPathRef.current
    if (!path || path.length === 0) return
    map.setOptions({ maxZoom: segmentMaxZoomRef.current })
    const b = new google.maps.LatLngBounds()
    for (const p of path) b.extend(p)
    map.fitBounds(b, 60)
    justFittedRef.current = true
  }, [map, active, segmentFitKey])
```

既有「起播 fitBounds 整日」effect 保留不動（起播先看全貌，第一個 travel 段來時才收斂到段落）；其 cleanup 的 `setOptions({ maxZoom: null })` 同時涵蓋本 effect 設的值（active 轉 false 才清，正確）。

- [ ] **Step 2: 呼叫端接線** — `<PlaybackCamera …>` 補三個 props：

```tsx
                <PlaybackCamera
                  lat={playheadDisplayPos?.lat ?? null}
                  lng={playheadDisplayPos?.lng ?? null}
                  active={playing}
                  bounds={playbackBounds}
                  segmentFitKey={playing && segment?.kind === 'travel' ? `travel:${segment.fromStopId}` : null}
                  segmentPath={segment?.kind === 'travel' ? (travelPath ?? (() => {
                    const f = stopById.get(segment.fromStopId)
                    const t = stopById.get(segment.toStopId)
                    return f && t ? [{ lat: f.lat, lng: f.lng }, { lat: t.lat, lng: t.lng }] : null
                  })()) : null}
                  segmentMaxZoom={SEGMENT_MAX_ZOOM[travelLeg?.mode ?? 'custom']}
                />
```

（currentPath 的 fallback IIFE 與 Task 3 Step 4 掛載處重複出現兩次——抽成 component body 的 `const currentTravelPath = …` 一份供兩處共用。）

- [ ] **Step 3: 全套驗證 + 手動壓力點** — 全套綠。手動重點（都是灰塊事故的既往可達路徑）：
  1. 台北→福岡→鹿兒島這種跨量級日：進飛行段鏡頭拉遠收整段弧線、進市區步行段鏡頭收近到街廓、停留中鏡頭不動
  2. 播放中點側欄停留點（CameraFollow 路徑）不引發縮放暴衝
  3. 播放結束/暫停後手動縮放不被 maxZoom 卡住
  4. 手機視窗寬度（DevTools 375px）播放不出現灰塊
- [ ] **Step 4: Commit** — `feat: 播放分段取景（換段 fitBounds、mode 分級 maxZoom、停留定格）`

---

### Task 5: 分享頁驗證 + 文件收尾

**Files:** Modify `README.md`、`docs/superpowers/specs/2026-08-01-playback-visual-design.md`；驗證 `src/app/share/view/page.tsx`（預期零改動）

- [ ] **Step 1: 分享頁手動驗證** — 無痕視窗開分享連結：自動播放時圖示/紅線/分段取景全部生效（TripView 重用，理論上零改動；驗證是防「canEdit gate 誤傷」）。
- [ ] **Step 2: README** — 已知限制移除「polyline 尚未實作／路線圖屬後續」條目；功能清單補「選中日路線圖」與「播放視覺（交通圖示、漸進紅線、分段取景）」。
- [ ] **Step 3: 設計文件** — playback-visual-design.md 狀態行改「已實作（2026-08-03）」，待決事項五項補上拍板結果（照本計畫開頭的表）。
- [ ] **Step 4: 全套綠 → Commit** — `docs: 播放視覺完工記錄與 README 功能清單`
