# Travel Planner 共編・分享・匯出（Plan 5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 共編與分享的維度上線——邀請旅伴（token 連結 + editor/viewer 角色 + 成員管理）、唯讀分享預覽（免註冊）、Excel 行程表匯出（旅途急用）、定稿快照 + JSON 匯出，並根治 PR #4 總審 Important-1~4 與 PR #3/#4 遺留清項；Realtime 共編（refresh-based + presence）收尾。

**排序鐵律（使用者 8/2–8/8 九州旅途中真實使用，今天 8/1；經計畫審查 C-1/C-2 定案）：**

- **部署檢查點 A（今晚出發前上線）＝ Task 1 → Task 2 → Task 3 → Task 4**：花費轉存保護（Important-1/2，花費被刪是不可逆資料損失）→ Excel 匯出 → **定稿快照（不可裁——8/2 之後任何一次編輯都會讓「出發前原計畫」的基準線永久消失，而 `trip_snapshots` 表/policy/grant 在 init.sql 全就緒、零 migration，成本一顆純函式）** → 側欄警示（Important-3）。**時間告急砍 Task 4，絕不砍 Task 3。**
- viewer 唯讀化（Important-4）下移為 Task 5：production 目前物理上不存在 viewer（成員只有 owner 本人），今晚零觸發率；它是邀請功能的地基，在 Task 6-7 之前完成即可（旅途中）。
- 邀請旅伴 Task 6-7 次之（旅途中可用）；分享預覽、polyline、清項、Realtime 殿後（回國後）。

**Architecture:** 核心決策：

1. **邀請 = token 表 + SECURITY DEFINER RPC 接受**：`trip_invites` 的 `id` 即 token（`gen_random_uuid()`，122 bit 隨機不可枚舉），RLS 僅 owner 可讀寫；接受走 `accept_trip_invite(p_token)` RPC——匿名不可呼叫、無效/過期一律回 `null` 不區分原因（不給枚舉者訊號）、已是成員時 `on conflict do nothing`（**不升不降**，角色調整是 owner 的權力）。撤銷 = 刪除邀請列（不留 revoked_at 欄，Simplicity First）。
2. **共編上線前先收緊寫入面**：(a) trips 的 UPDATE policy 無欄位限制，editor 可竄改 `share_token`/`owner_id`——用**欄位級 GRANT** 收到 `(title, start_date, end_date, currency)`，`share_token` 重生成改走 owner-only RPC；(b) **trip_members 的「owner 可調整成員角色」policy 的 with check 未限制新值**，owner 可把成員 role 改成 `'owner'` 造成多 owner 提權（審查 M-2）——重建 policy 補 `role in ('editor','viewer')` 與 `user_id <> auth.uid()` 進 with check。兩者與 invites 同一 migration 處理。
3. **分享預覽 = SECURITY DEFINER RPC，不給 anon 任何表級權限**：`get_shared_trip(p_token)` 以**顯式欄位白名單**（`jsonb_build_object` 逐欄，審查 M-3）回傳 trip/stops/legs 唯讀 jsonb；token 錯誤回 `null` → 「連結已失效」頁（spec §6 錯誤處理表）。否決「anon RLS policy 讀表」——RLS 無法接收 URL token 參數，繞道 JWT claim/header 的複雜度不值。頁面重用 Task 5 的唯讀 TripView（分享頁 = 沒有帳號的 viewer）。
4. **viewer 唯讀化在 client 是 UX、在 DB 是既有 RLS**：`is_trip_editor` 早已在資料庫層擋住 viewer 寫入與 sync 端點（403）；本 Plan 補的是 UI 誠實化——隱藏編輯入口、viewer **完全不觸發** legs sync（403 的 S-1 錯誤提示誤導 viewer = 總審 Important-4 根治）。
5. **auto 段花費保護 = 轉存而非豁免刪除**：帶花費的 auto 段在配對脫離時**轉存 manual**（清除全部 Google 衍生欄位——polyline/detail/distance/duration/computed_at/departs/arrives——只留使用者的花費與模式，標 stale）。否決「跳過刪除留在原地」：脫離的 auto 段若保留 Google 資料，sync 不再重算它，30 天後變成 ToS 逾期殘留。轉存後與隱藏的 manual 段一起收進側欄「已脫離順序」區塊（Important-2 一體根治）；**附「改回自動計算」鈕**（審查 M-1：轉存段在恢復相鄰後仍是 manual 不會自動復原，必須給使用者一條回頭路——**以 UPDATE 把段轉回 auto 空殼**：相鄰時 legSync 判 neverComputed 原地重算、不相鄰時花費已清走 removeAuto 自然收斂，兩態皆閉環；按鈕同時出現在脫離段區塊與正常交通列的 manual 段）。
6. **Excel 產生走 server route（exceljs 不進 client bundle，`serverExternalPackages` 顯式外部化）**；行別模型 `buildItineraryRows` 為純函式 TDD（Day 分組沿用 `filterDayStops`/`localDateKey`、leg 歸屬 from 日與 UI M-4 規則一致）。**JSON 匯出與定稿快照走 client**（資料就在 props，零新端點；快照 builder 純函式 TDD）。
7. **快照嚴守 spec §4 ToS 分層，但地點名稱納入快照（審查 M-8 選項 b，主動修訂 spec）**：沒有名稱的快照無法離線閱讀、無法當匯出格式——快照收錄 `name`，同步修訂 spec §4 的凍結欄位清單並在 §8 增列「Google 地點名稱長期保存屬灰色地帶」殘留風險（明示決策，不迴避）。其餘鐵律不變：Google 地點不存經緯度（`is_custom` 地點座標是使用者資料，照存）；auto 段只存 mode/花費（時長由前後停留點時間隱含）；manual 段全欄；一律不含 polyline/detail/distance。
8. **Realtime 用 postgres_changes + presence，商用前再遷 Broadcast**：publication 與 replica identity 在 init migration 已就緒，零 migration 上線；官方對規模化場景建議改用 Broadcast from Database（每事件對每訂閱者做授權檢查，吞吐隨訂閱者數縮放，門檻約數千併發訂閱）。本產品現階段訂閱者 = 同行旅伴個位數，postgres_changes 成本可忽略。**DELETE 事件不能 filter、不套 RLS，payload 僅含 PK（id）**（spec §8 既有記載）——client 以「本地 id 集合有此 id 才反應」冪等處理，絕不信 payload 的其他欄位。

**選型與行為查證（2026-08-01 經 WebSearch 查證，非記憶）：**

- **xlsx 套件選 exceljs 4.4.0**。取捨全貌：
  - SheetJS CE 的 npm `xlsx` 套件停更在 0.18.5，帶兩個未修 CVE：CVE-2023-30533（讀取惡意檔案的 prototype pollution）與 CVE-2024-22363（ReDoS）；修復版（0.19.3 / 0.20.2+）只發佈在自家 `cdn.sheetjs.com` registry，不上 npm——lockfile 指向第三方 registry 的供應鏈與重現性代價不可接受。**否決。**
  - exceljs：npm 最新 4.4.0，約兩年未發版（分析平台標為 Inactive），但週下載 1,200 萬+、寫入 API 完整穩定；Snyk 顯示的公告屬 medium 級且集中在**解析**路徑。本專案**只用產生（寫入）路徑、絕不解析外部上傳檔案**，read-path 風險不適用。**採用**，安裝時 `npm audit` 的傳遞依賴告警如實記載（DoD 項），維護停滯記入 spec §8 殘留風險（若未來需要解析功能再重評，屆時候選含 @e965/xlsx 等社群 fork）。
  - 來源：security.snyk.io/package/npm/exceljs、secure.software/npm/packages/exceljs、cdn.sheetjs.com/advisories/CVE-2023-30533、cdn.sheetjs.com/advisories/CVE-2024-22363、git.sheetjs.com/sheetjs/sheetjs/issues/2961。
- **Supabase Realtime**（supabase.com/docs/guides/realtime/postgres-changes、…/subscribing-to-database-changes、…/broadcast）：postgres_changes 未廢棄，但官方建議規模化場景改用 Broadcast from Database（`realtime.broadcast_changes` DB trigger + private channel）；postgres_changes 對**每個訂閱者逐一做授權檢查**；**DELETE 事件無法 filter、不套 RLS，以僅含 PK 的 payload 廣播給該表所有訂閱者**。→ 決策見 Architecture 8；實作 Task 11 時仍須照 AGENTS.md 慣例重讀官方 quickstart 確認 API 簽名。

**Tech Stack:** Postgres RLS + SECURITY DEFINER RPC（invites/share）/ exceljs（server route 產生 xlsx）/ Supabase Realtime postgres_changes + presence / Next 16 route handlers（`params` 是 Promise 需 await；新增 route/page 前先讀 `node_modules/next/dist/docs/` 對應章節——AGENTS.md 鐵律）

**Spec:** `docs/superpowers/specs/2026-07-30-travel-planner-design.md` §2（Excel 匯出與 JSON 匯出同批）、§4（trip_members + RLS、share_token、快照分層）、§5（共編即時回饋）、§6（即時共編同步、錯誤處理表）、§7（定稿快照——「不做以後會後悔」）、§8（Realtime DELETE 不套 RLS、多 editor 重複 sync、M-6 DST）

**分支：** `git checkout -b feat/plan-5-sharing`（main 已含 Plan 1-4）。逐任務 critic 審查；**兩個 migration 任務（Task 6、Task 8）額外過 db-expert，Task 6 的 RLS/越權面再由 vuln-verifier 寫 PoC 驗證**（token 表與角色提權的權限錯誤 = 直接的資料外洩/越權面）。

---

## 檔案結構總覽

```
src/
├── lib/domain/
│   ├── exportRows.ts / exportRows.test.ts   # xlsx 行別模型（新，TDD）
│   ├── snapshot.ts / snapshot.test.ts       # 快照/JSON 匯出 builder（新，TDD）
│   ├── legSync.ts / legSync.test.ts         # planLegSync 增 detachAuto（改，TDD）
│   └── tz.test.ts                           # 補 DST 邊界案例（改）
├── lib/supabase/
│   ├── invites.test.ts                      # trip_invites + RPC 整合/RLS 測試（新）
│   ├── share.test.ts                        # get_shared_trip RPC 測試（新）
│   └── database.types.ts                    # 重生（invites 表 + RPC）
├── app/api/trips/[tripId]/
│   ├── legs/sync/route.ts                   # detachAuto 迴圈（改）
│   └── export/xlsx/route.ts                 # Excel 下載端點（新）
├── app/trips/[tripId]/
│   ├── page.tsx                             # role/share_token/成員/邀請資料、匯出/成員入口（改）
│   ├── TripView.tsx                         # canEdit 資料流、脫離段區塊、側欄警示、快照鈕、播放鏡頭跟隨（改）
│   ├── Timeline.tsx                         # dayView 整包改由上層傳入、唯讀 guard（改）
│   ├── dayView.ts                           # 當日 leg 配對 + 警示共用 helper（新）
│   ├── MembersPanel.tsx                     # 成員列表/角色/移除/退出/邀請管理（新）
│   ├── ExportButtons.tsx                    # xlsx 下載 + JSON 匯出 + 出發！快照（新）
│   └── RoutePolylines.tsx                   # 地圖路線（新，照 Plan 4 Task 7 過稿）
├── app/invite/[token]/page.tsx              # 邀請接受頁（新）
├── app/share/[token]/page.tsx               # 唯讀分享頁（新，含失效頁狀態）
├── app/trips/[tripId]/TripRealtime.tsx      # Realtime 訂閱 + presence（新，Task 11）
next.config.ts                               # serverExternalPackages: ['exceljs']（改）
supabase/migrations/
├── 20260803000000_invites_and_grants.sql    # invites 表 + accept RPC + trips/trip_members 收緊 + regenerate RPC（新）
└── 20260804000000_share_rpc.sql             # get_shared_trip RPC（新，Task 8）
e2e/
├── smoke.spec.ts                            # 清理改 e2e-smoke- 前綴 + listUsers 分頁（改，Task 7）
└── invite.spec.ts                           # 邀請流程 E2E（新，e2e-invite- 前綴）
```

migration 本地套用一律沿用既有 workaround（`db reset` 故障）：`docker exec -i supabase_db_traval psql ... < migration.sql` + 手動補 `supabase_migrations.schema_migrations` 列；型別重生失敗時手動補型別並如實回報（Plan 4 Task 1 慣例）。

---

### Task 1: auto 段花費轉存保護與脫離段區塊（總審 Important-1/2 根治）【檢查點 A・出發前必須】

**Files:** Modify `src/lib/domain/legSync.ts`、`legSync.test.ts`、`src/app/api/trips/[tripId]/legs/sync/route.ts`、`TripView.tsx`、`README.md`

- [ ] **Step 1: 失敗測試** — legSync.test.ts：`SyncLeg` 增 `estimatedCost: number | null`；`LegSyncPlan` 增 `detachAuto: string[]`。案例：配對脫離的 auto 段**有花費 → detachAuto（不進 removeAuto）**；無花費 → removeAuto（現行為不變）；manual 段照舊 markStale；相鄰配對上的帶費 auto 段完全不動。既有案例的 leg builder 補 `estimatedCost: null` 預設。
- [ ] **Step 2: 跑紅 → 實作** — planLegSync 的 `!pair` 分支三分派：`source === 'auto' && estimatedCost !== null` → detachAuto；`source === 'auto'` → removeAuto；manual → markStale（維持已 stale 不重複）。
- [ ] **Step 3: sync 端點** — route.ts 讀取 legs 的 select 補 `estimated_cost`；映射補 `estimatedCost`；在 removeAuto 迴圈旁新增 detachAuto 迴圈（同樣逐項檢查牆鐘預算、逐列寫入、失敗記 log）：

```ts
// Important-1 根治：帶花費的 auto 段脫離配對時轉存 manual——花費是使用者資料必須保留；
// Google 衍生欄位全清（脫離段不再被 sync 重算，留著就是 30 天後的 ToS 逾期殘留）。
// .eq('source','auto') 原子守衛沿 Critical-1 慣例：已被使用者搶先改 manual 就不動它
const { data, error } = await supabase.from('legs').update({
  source: 'manual', duration_minutes: null, distance_meters: null,
  polyline: null, detail: null, computed_at: null,
  departs_at: null, arrives_at: null, stale: true,
}).eq('id', id).eq('source', 'auto').select('id')
```

  成功計 `changed = true`（不動 legCount——列仍在）。
- [ ] **Step 4: 側欄「已脫離順序的交通段」區塊（Important-2 根治）** — TripView：以既有 `nextByStopId` 判定「`from_stop_id→to_stop_id` 不在相鄰配對中」的 legs 為脫離段，過濾出 from 停留點屬 activeDay 者（歸屬規則與 M-4 一致），在停留點清單之後渲染折疊區塊，每列：
  - 顯示 `MODE_ICON`＋from→to 名稱＋manual 起訖（有值時，`formatLocalTime` 各自時區）＋時長＋花費＋⚠️ stale 說明「已脫離行程順序，資料保留」。
  - 「刪除」鈕（confirm 兩段式，比照 StopEditor；刪除後 `void syncLegs()` + `router.refresh()`）。
  - **「改回自動計算」鈕（審查 M-1：堵死路；審查員預核方案 B）**——轉存段恢復相鄰後仍是 manual，不會自動復原成 auto。此鈕 confirm 文案「會清除此段的手動內容與花費」→ **UPDATE 轉回 auto 空殼（不是 DELETE）**：

```ts
.from('legs').update({ source: 'auto', stale: false, estimated_cost: null,
  duration_minutes: null, computed_at: null, departs_at: null, arrives_at: null })
.eq('id', legId).eq('source', 'manual')
```

    之後 `void syncLegs()` + `router.refresh()`。兩態皆收斂：配對相鄰時 legSync 判 neverComputed 原地重算；不相鄰時 estimatedCost 已清為 null，走 removeAuto 自然清掉。**按鈕同時放兩處**：脫離段區塊每列，以及正常交通列的 manual 段（`leg.source === 'manual'` 時顯示——放 LegEditor 內或交通列皆可，實作擇一並保持一致）。
  - 不提供編輯（脫離段沒有時間基準，編輯無意義）。
- [ ] **Step 5: README** — 已知限制刪除「auto 段花費隨段刪除」與「manual 段暫時隱藏」兩條，改記：「脫離行程順序的交通段收在側欄專屬區塊（資料保留、可刪除）；**恢復相鄰後保留為手動段，可一鍵改回自動計算（花費將清除）**」。
- [ ] **Step 6: 驗證** — vitest 全綠；手動：auto 段填花費 → 在兩端之間插入停留點 → 段轉存 manual、花費保留、出現在脫離區塊且 polyline 為 null（DB 抽查 ToS 分層）；manual/flight 段同場景出現在脫離區塊不再不可見；移除中間停留點後段回到正常交通列（manual 顯示）→ 按「改回自動計算」→ auto 段重建並算出時長。→ **Commit** `fix: auto 段花費轉存保護與脫離段區塊（總審 Important-1/2 根治）`

---

### Task 2: Excel 行程表匯出【檢查點 A・出發前必須・旅途中可用】

**Files:** Create `src/lib/domain/exportRows.ts`、`exportRows.test.ts`、`src/app/api/trips/[tripId]/export/xlsx/route.ts`、`src/app/trips/[tripId]/ExportButtons.tsx`；Modify `page.tsx`、`next.config.ts`

- [ ] **Step 0:** `npm install exceljs`（選型論證見計畫頭「查證」節；只用寫入路徑）；`next.config.ts` 補 `serverExternalPackages: ['exceljs']`（顯式外部化，不讓 bundler 內聯大型 CJS 套件）；跑 `npm audit` 並把傳遞依賴告警**如實記載**於回報與 DoD（預期有 medium 級解析路徑公告，不阻擋——理由見查證節）。
- [ ] **Step 1: 失敗測試** — `exportRows.test.ts`。行別模型是 discriminated union：

```ts
export type ItineraryRow =
  | { kind: 'day'; label: string }                      // Day 2・2026-08-03
  | { kind: 'stop'; time: string; name: string; stayMinutes: number; cost: number | null; notes: string | null }
  | { kind: 'leg'; modeLabel: string; durationText: string; cost: number | null; crossDay: string | null; detached: boolean }
  | { kind: 'total'; cost: number }                     // totalEstimatedCost(stops+legs)
```

  測試案例（≈9）：Day 分組依停留點自身時區（`filterDayStops`/`tripDayKeys` 語義）；停留點行含當地 HH:mm–HH:mm 與停留分鐘；leg 行插在 from 停留點之後（`adjacentPairs` 全行程配對、歸屬 from 日 = UI M-4 同規則）；跨夜 leg 標「→ MM-DD 名稱」；`duration_minutes` null 時顯示「待計算/查無路線」文案（沿 `legUi.legDurationText` 邏輯，但 exportRows 屬 domain 層自帶最小輸入型別，不 import app 層）；脫離配對的 leg（Task 1 轉存後存在）列該日末尾標 `detached: true`；花費 null 與總計列；空行程回傳只有 total 0。
- [ ] **Step 2: 跑紅 → 實作** `buildItineraryRows(trip, stops, legs): ItineraryRow[]`（純函式；輸入型別自定義最小欄位，如 SyncStop 前例）。
- [ ] **Step 3: 下載端點** — Create `export/xlsx/route.ts`（**先讀 `node_modules/next/dist/docs/` route handler 章節**）：GET → `await params` → auth（無 user 401）→ `is_trip_member` RPC 檢查（false 404，不洩漏存在性；**RPC 權限檢查模式引 `legs/sync/route.ts:36` 的 `is_trip_editor` 前例**）→ user client（RLS）讀 trip/stops/legs（沿 page.tsx 的 select 欄位與 `.limit(500)`）→ `buildItineraryRows` → exceljs 組 workbook：單一 worksheet「行程表」，欄＝時間｜項目｜分鐘｜花費（{currency}）｜備註；day 列粗體底色、total 列粗體；`workbook.xlsx.writeBuffer()` → `new Response(new Uint8Array(buffer))`，headers：`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`、`Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(title)}.xlsx`（中文檔名走 RFC 5987，不可只用裸 filename）、**`Cache-Control: private, no-store`**（行程含花費/備註，不得進任何共享快取）。
- [ ] **Step 4: 入口** — Create `ExportButtons.tsx`（client；本 Task 只放「下載 Excel」`<a href={/api/trips/${id}/export/xlsx}>`，JSON/快照鈕 Task 3 加入）；page.tsx header 掛載。
- [ ] **Step 5: 驗證** — vitest 綠；lint/tsc/build 綠；手動：下載九州行程 xlsx，用 Numbers/Excel 開啟確認 Day 分組、當地時間、交通列、總計正確；非成員（無痕視窗直打 URL）得 401/404。→ **Commit** `feat: Excel 行程表匯出（exceljs、Day 分組、停留點與交通欄）`

---

### Task 3: 定稿快照 + JSON 匯出【檢查點 A・出發前必須・不可裁】

> 為什麼不可裁（審查 C-1）：8/2 出發後的**任何一次編輯**（旅途中改時間、補交通）都會覆寫原計畫，「出發前定稿」的基準線一旦錯過就永久消失，「計畫 vs 實際」（spec §7：不做以後會後悔）再也做不出來。而成本極低：`trip_snapshots` 表、RLS policy、GRANT 在 init.sql 全部就緒，**零 migration**，只需一顆純函式加兩顆按鈕。時間告急時砍 Task 4，不砍本任務。

**Files:** Create `src/lib/domain/snapshot.ts`、`snapshot.test.ts`；Modify `ExportButtons.tsx`、`page.tsx`（ExportButtons 需增傳 stops/legs 兩個 prop）、spec §4/§8

- [ ] **Step 1: 失敗測試 → 實作** — `buildTripSnapshot(trip, stops, legs)` 純函式（TDD，≈6 案例）。**ToS 分層鐵律（spec §4，含 M-8 名稱決策）**：
  - trip：title/start_date/end_date/currency；`snapshot_version: 1`。
  - stops：**name（見 Step 2 的 spec 修訂）**/place_id/is_custom/timezone/starts_at/ends_at/locked/notes/estimated_cost；**經緯度僅 `is_custom` 地點收錄**（Google 地點的座標屬 30 天快取類別，快照以 place_id 代表；測試明確斷言非 custom 停留點無 lat/lng 鍵）。
  - legs：auto 段只存 `{ from_stop_id, to_stop_id, mode, source, estimated_cost }`（時長由前後停留點時間隱含——spec §4 推導性質）；manual 段全存使用者欄位（+ duration_minutes/departs_at/arrives_at）；**一律無 polyline/detail/distance_meters/computed_at**（測試逐鍵斷言）。
- [ ] **Step 2: spec 修訂（審查 M-8 選項 b，明示決策）** — spec §4「快照只凍結使用者計畫資料」的欄位清單把**地點名稱**納入（理由寫進 spec：沒有名稱的快照無法離線閱讀、無法作為 JSON 匯出格式；名稱同時可能是使用者改過的自訂名）；spec §8 增列殘留風險：「快照內含 Google 地點名稱的長期保存屬條款灰色地帶（非 is_custom 地點）——商用前與 30 天 TTL 解讀同批向 Google 書面確認」。
- [ ] **Step 3: 按鈕** — ExportButtons 增：「匯出 JSON」（client：`buildTripSnapshot` → Blob 下載，不落 DB）；「出發！定稿」（canEdit 限定——本 Task 時點 page.tsx 尚未查 role，先以 owner 本人使用為前提直接顯示，Task 5 接上 canEdit 後補條件；confirm → `supabase.from('trip_snapshots').insert({ trip_id, label: '出發前定稿 ' + 今天, snapshot, snapshot_version: 1 })`——RLS editor insert policy 已存在，零 migration；成功提示，重複按各自成列——快照本就允許多份）。
- [ ] **Step 4: 驗證** — vitest 綠；手動：定稿後 DB 抽查 snapshot jsonb 無任何 Google 衍生鍵、非 custom 停留點無 lat/lng；JSON 下載內容與 DB 快照同構。→ **Commit** `feat: 定稿快照與 JSON 匯出（ToS 分層快照 builder、spec §4 名稱欄位修訂）`

---

### Task 4: 側欄交通列趕不上警示（總審 Important-3 根治）【檢查點 A・時間告急唯一可砍項】

**Files:** Create `src/app/trips/[tripId]/dayView.ts`；Modify `TripView.tsx`、`Timeline.tsx`、`README.md`

- [ ] **Step 1: 抽共用 helper** — Create `dayView.ts`：把 Timeline.tsx 內的 dayLegs 組裝 + `detectConflicts` 呼叫 + `tightPairs`/`conflictIds` 推導原樣搬出為純 helper，**回傳整包**（審查 M-4：dayLegs 除了餵 detectConflicts 還是 Timeline 連接條的渲染來源，只傳 warnings 移不掉 Timeline 的組裝 import）：

```ts
export type DayView = {
  dayLegs: Array<{ from: Stop; to: Stop; leg: Leg }>
  warnings: ScheduleWarning[]
  conflictIds: Set<string>
  tightPairs: Set<string>
}
export function buildDayView(dayStops: Stop[], stops: Stop[], legs: Leg[]): DayView
```

  （邏輯零改動——這是搬家不是重寫。）
- [ ] **Step 2: 單一計算來源** — TripView 對 activeDay 呼叫 `buildDayView`，以**單一 prop `dayView`** 傳給 Timeline；Timeline 刪除內部的 nextByStopId/legByPair/dayLegs/detectConflicts/tightPairs/conflictIds 計算與 `detectConflicts`/`adjacentPairs` import，改讀 `dayView`。**影響分析：Timeline 的紅色色塊/紅色連接條行為不得有任何變化**（同輸入同輸出，用手動回歸確認）。
- [ ] **Step 3: 側欄警示** — 側欄交通列（TripView 的 leg button）當 `dayView.tightPairs` 命中 `${stop.id}→${next.id}` 時整列紅字並追加文案：`⚠ 趕不上：空檔 ${Math.round(gapMinutes)} 分＜交通 ${requiredMinutes} 分`（兩值取自對應 warning 物件，非重新計算；gapMinutes 可能是小數，顯示前 `Math.round`）。
- [ ] **Step 4: README 宣稱修正** — 核心功能第 9 行**只刪除**「側欄交通列警示屬 Plan 5」那一小段文字；「警示不阻擋編輯」的敘述**保留**（語義仍成立）。
- [ ] **Step 5: 驗證** — lint/tsc/build/vitest 綠；手動：拖曳停留點壓縮空檔 → 時間軸連接條、色塊、**側欄交通列**三處同步變紅；空檔恢復後三處同步復原。（已知邊界：跨夜段不在當日衝突偵測範圍——spec §8 既有記載，本任務不改變。）→ **Commit** `fix: 側欄交通列趕不上警示接入 detectConflicts（總審 Important-3 根治）`

---

### 🚀 部署檢查點 A（今晚出發前執行）

- [ ] 完成 Task 1 → 2 → 3 →（時間允許）4 後：push 分支 → PR → critic 總審本批 diff → merge（依 auto-merge 授權）→ Vercel 自動部署。**零 migration、零 DB 操作。**
- [ ] 線上冒煙：Excel 下載開啟正常、auto 段花費轉存（插入停留點驗證）、**「出發！定稿」按下並 DB 抽查快照落庫**、側欄警示（若 Task 4 完成）。
- [ ] 時間告急的底線：Task 1-3 必須上線；Task 4 被砍時在 README 已知限制與回報如實記載，旅途中補。

---

### Task 5: viewer 唯讀化與 sync 403 根治（總審 Important-4）【次優先・旅途中可用；Task 6-7 邀請功能的地基】

> 位置說明（審查 C-2）：production 目前物理上不存在 viewer（唯一成員是 owner），本任務今晚零觸發率，故不佔檢查點 A 檔期；但邀請功能上線後 viewer 立即真實存在，**必須在 Task 6-7 之前完成**。

**Files:** Modify `src/app/trips/[tripId]/page.tsx`、`TripView.tsx`、`Timeline.tsx`、`ExportButtons.tsx`

- [ ] **Step 1: role 資料流** — page.tsx 在 trip 查詢後補：

```ts
const { data: membership } = await supabase
  .from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', user.id).maybeSingle()
const canEdit = membership?.role === 'owner' || membership?.role === 'editor'
```

  （查無 membership 列——例如帳號刪除語義下的孤兒行程 owner_id 路徑——一律視為唯讀，安全預設。）`<TripView canEdit={canEdit} …>`；header 在非 canEdit 時顯示「👁 檢視模式」badge；ExportButtons 的「出發！定稿」補 `canEdit` 條件（Task 3 預留）。
- [ ] **Step 2: TripView 唯讀 guard** — props 增 `canEdit: boolean`。`!canEdit` 時：不渲染 PlaceSearch/草稿表單、地圖 `onContextmenu` 不設 draftPin、StopEditor 與 LegEditor 不渲染（停留點/交通列點擊仍可選取＋鏡頭跟隨——唯讀不是不能看）、脫離段區塊的刪除/改回自動鈕隱藏、`syncLegs` 頂部 `if (!canEdit) return`（**403 根治的核心：viewer 從一開始就不打 sync，S-1 的「交通段暫時無法計算」錯誤提示不再誤導**；掛載 effect 與所有寫入後觸發點天然失效）。
- [ ] **Step 3: Timeline 唯讀 guard** — TripView 傳 `onMove={canEdit ? moveStop : undefined}`；Timeline 的 `beginDrag` 補 `!onMove` 早退（現行只在 endDrag 檢查，viewer 會看到拖曳預覽卻提交不了——半互動狀態比不能拖更困惑）；拖曳提示文案僅在可拖時渲染。播放/播放頭/Day 切換全保留（唯讀核心價值）。
- [ ] **Step 4: 驗證** — 全套綠；手動（本地建 viewer 測試帳號直插 trip_members）：viewer 開頁無任何編輯入口、無錯誤提示、console 無 403；playback 正常；editor 帳號行為與改動前完全一致（回歸重點）。→ **Commit** `fix: viewer 唯讀化與 sync 403 根治（總審 Important-4）`

---

### Task 6: 共編權限 migration——trip_invites + accept RPC + trips/trip_members 收緊【次優先・旅途中可用】

**Files:** Create `supabase/migrations/20260803000000_invites_and_grants.sql`、`src/lib/supabase/invites.test.ts`；Regenerate `database.types.ts`

- [ ] **Step 1: migration** —

```sql
begin;

-- ============ trip_invites：id 即邀請 token（gen_random_uuid = 122 bit 隨機，不可枚舉） ============
-- 撤銷 = 刪除列（不設 revoked_at；Simplicity First）。多次可用直到過期/撤銷（貼到群組聊天的真實用法）。
create table public.trip_invites (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index trip_invites_trip_id_idx on public.trip_invites (trip_id);

alter table public.trip_invites enable row level security;
-- 僅 owner 可管理與檢視邀請（editor/viewer/非成員一律不可見——token 本身就是機密）。
-- insert 的 with check 同時封頂效期 30 天（用 policy 而非 CHECK 約束：now() 非 IMMUTABLE，
-- CHECK 內用 now() 是未定義行為的溫床；policy 每次寫入時評估，語義正確）
create policy "owner 可讀邀請"
  on public.trip_invites for select to authenticated using (public.is_trip_owner(trip_id));
create policy "owner 可建邀請"
  on public.trip_invites for insert to authenticated
  with check (public.is_trip_owner(trip_id) and expires_at <= now() + interval '30 days');
create policy "owner 可撤銷邀請"
  on public.trip_invites for delete to authenticated using (public.is_trip_owner(trip_id));

grant select, insert, delete on public.trip_invites to authenticated;
-- 刻意不 grant anon；service_role 必須顯式補——init 的 grant all on all tables 是一次性快照，
-- 不涵蓋未來新表（Plan 1 教訓：無 GRANT 則 policy 根本不被評估）
grant select, insert, update, delete on public.trip_invites to service_role;

-- ============ 接受邀請 RPC ============
-- 語義：無效/過期一律回 null（不區分原因，不給 token 枚舉者訊號）；
-- 已是成員 on conflict do nothing（不升不降——角色調整是 owner 在成員面板的權力）。
create function public.accept_trip_invite(p_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_trip_id uuid;
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select trip_id, role into v_trip_id, v_role
    from trip_invites where id = p_token and expires_at > now();
  if not found then
    return null;
  end if;
  insert into trip_members (trip_id, user_id, role)
    values (v_trip_id, auth.uid(), v_role)
    on conflict (trip_id, user_id) do nothing;
  return v_trip_id;
end $$;
-- SECURITY DEFINER 函式預設 execute 授予 public——必須顯式收回再只給 authenticated
revoke execute on function public.accept_trip_invite(uuid) from public, anon;
grant execute on function public.accept_trip_invite(uuid) to authenticated;

-- ============ trip_members 角色提權缺口（審查 M-2） ============
-- 既有 policy 的 with check 只驗 is_trip_owner，未限制新值：owner 可把成員 role 改成 'owner'
-- 造成多 owner（不可移除、不可降級——owner 保護規則反而把提權鎖死）。重建 policy：
-- with check 補「不能改自己 + 新角色只能是 editor/viewer」。owner 轉移屬後續迭代（spec §8）。
drop policy "owner 可調整成員角色" on public.trip_members;
create policy "owner 可調整成員角色"
  on public.trip_members for update to authenticated
  using (public.is_trip_owner(trip_id) and user_id <> (select auth.uid()))
  with check (
    public.is_trip_owner(trip_id)
    and user_id <> (select auth.uid())
    and role in ('editor', 'viewer')
  );

-- ============ trips 寫入面收緊（共編上線的前置）：欄位級 GRANT ============
-- 現行 UPDATE policy（editor 以上可改行程）無欄位限制，editor 可竄改 share_token/owner_id。
-- RLS 不能做欄位級控制，用 GRANT 收斂：authenticated 只能改四個計畫欄位；
-- share_token 重生成改走下方 owner-only RPC；owner_id 任何 client 均不可改。
-- 注意：表級/欄位級 GRANT 只約束以呼叫者身分執行的語句；SECURITY DEFINER 函式（如下方
-- regenerate RPC）與 policy 內部的判斷函式（is_trip_owner 等）以定義者身分執行，
-- 不受本節 revoke 影響——收緊不會弄壞既有 policy。
-- 回滾（單條 SQL，寫進本 migration 的 commit 訊息與 README 部署段）：
--   grant update on public.trips to authenticated;                                    -- 還原欄位收緊
--   revoke execute on function public.accept_trip_invite(uuid) from authenticated;    -- 應急停用邀請
revoke update on public.trips from authenticated;
grant update (title, start_date, end_date, currency) on public.trips to authenticated;

create function public.regenerate_share_token(p_trip_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_token uuid;
begin
  if not public.is_trip_owner(p_trip_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update trips set share_token = gen_random_uuid() where id = p_trip_id
    returning share_token into v_token;
  return v_token;
end $$;
revoke execute on function public.regenerate_share_token(uuid) from public, anon;
grant execute on function public.regenerate_share_token(uuid) to authenticated;

commit;
```

- [ ] **Step 2: 本地套用 + 型別重生**（既有 workaround 流程；history 記 `('20260803000000','invites_and_grants')`）。
- [ ] **Step 3: 整合/RLS 測試** — Create `invites.test.ts`（比照 legs.test.ts：localhost 護欄、skipIf、隨機 email、afterAll 清 trip/users）。**必測清單（db-expert 級，一項不可省）**：
  1. owner 建邀請成功且能列出；editor / viewer / 非成員 insert 被拒（42501）；owner 以 `expires_at = now() + 60 天` 建邀請被拒（42501，效期封頂 policy）。
  2. editor / viewer / 非成員 select 邀請 → 0 列（token 不可見）；anon client select → 錯誤（無 grant）。
  3. `accept_trip_invite`：新使用者 accept editor 邀請 → trip_members 出現 editor 列並回傳 trip_id；同人重複 accept → 冪等不變；**既有 viewer 成員 accept editor 邀請 → 角色仍 viewer（不升級）**；owner 自己 accept → 仍 owner（不降級）。
  4. 過期邀請（admin 把 expires_at 改到過去）→ null；亂造 token → null（兩者回應不可區分）；anon 呼叫 RPC → 錯誤（execute 已收回）。
  5. 撤銷（owner delete）後 accept → null。
  6. trips 欄位收緊：editor update title 成功；editor / owner 直接 update share_token → 權限錯誤（42501，欄位級 GRANT 生效——**owner 也必須走 RPC**，寫入面單一化）；`regenerate_share_token`：owner 呼叫成功且 token 變、舊值不等新值；editor 呼叫 → 錯誤。
  7. 回歸：editor 仍可正常 update stops/legs（GRANT 手術未誤傷其他表）。
  8. **角色提權（M-2）**：owner 把成員 role 改為 `'owner'` → 被拒（42501，with check 白名單）；改為 editor↔viewer 正常；owner 改自己的 role → 被拒。
- [ ] **Step 4: 審查閉環** — 派 db-expert 審 migration（鎖定：GRANT 快照語義、SECURITY DEFINER 的 search_path 與 ACL、on conflict 不升不降語義、policy 重建的 using/with check 對稱性、cascade 行為）＋ critic 審整體 → **vuln-verifier 對四個攻擊面寫 PoC**：非 owner 建邀請、anon 掃 token（RPC 與表兩路）、editor 竄改 share_token、**owner 把成員提權成 owner**。全數確認拒絕才過關。
- [ ] **Step 5: 全套綠 → Commit** `feat: 邀請 token 表與接受 RPC、trips/trip_members 權限收緊（含 RLS 測試）`——**commit 訊息附兩條回滾 SQL**（migration 註解中的那兩條），README 部署段同步補記（審查 M-9：不等 Task 12）。

---

### Task 7: 成員面板與邀請流程 UI + E2E【次優先・旅途中可用】＋部署檢查點 B

**Files:** Create `src/app/trips/[tripId]/MembersPanel.tsx`、`src/app/invite/[token]/page.tsx`、`e2e/invite.spec.ts`；Modify `page.tsx`、`e2e/smoke.spec.ts`

- [ ] **Step 1: 資料** — page.tsx 讀成員與邀請（**兩段查詢**：trip_members 無 profiles 直接 FK，PostgREST 嵌入 join 不可用——先取 members 再 `profiles.select('id, display_name').in('id', userIds)`；spec §8 updated_by 孤兒語義：查無 profile 顯示「已離開的成員」）；owner 時另讀 trip_invites。傳入 MembersPanel。
- [ ] **Step 2: MembersPanel** — header「成員」鈕展開面板（client）：
  - 成員列表：display_name + role 標籤；owner 對**其他**成員顯示角色切換（editor↔viewer，`update trip_members set role`——RLS 已擋自改與 owner 值）與移除鈕（confirm 兩段式）；非 owner 成員顯示「退出行程」（刪自己列 → `router.push('/trips')`）。
  - 邀請管理（owner 限定）：角色選擇（editor/viewer）＋「產生邀請連結」（insert 後 `navigator.clipboard.writeText(`${location.origin}/invite/${id}`)` + 成功提示）；現有邀請列表（角色、剩餘效期、撤銷鈕）。
  - 錯誤處理沿 StopEditor 慣例（notice + busy guard）。
- [ ] **Step 3: 接受頁** — Create `app/invite/[token]/page.tsx`（**先讀 Next docs 對應章節**；server component）：
  - **未登入 → 降級方案定案（審查 M-6）**：顯示「請先登入，登入後**重新開啟這個邀請連結**」＋登入頁連結。**不做 `next` 回跳參數**——login 頁與 OAuth callback 的 redirect 白名單改動屬回國後範圍（記入 Task 10 Step 4 與 README 已知限制）。
  - 已登入 → 顯示「你被邀請加入行程」＋「加入」鈕（client 子元件；**必須是使用者主動點擊才呼叫 RPC**——link prefetch/爬蟲絕不能造成入團副作用，這是接受頁不做 GET 自動加入的原因）→ `rpc('accept_trip_invite')` → 回 trip_id 則 `router.push(/trips/${tripId})`；回 null 顯示「邀請連結無效或已過期」。token 非 UUID 格式直接顯示無效（不打 RPC）。
  - metadata：`robots: { index: false }` + **`referrer: 'no-referrer'`**（token 在 URL，不得經 Referer 外洩到外部連結）。
- [ ] **Step 4: E2E** — Create `e2e/invite.spec.ts`（比照 smoke.spec.ts 的 admin client / 登入 helper）：owner 建行程 → UI 產生 editor 邀請（從 DB 撈 token 組 URL）→ 使用者 B 登入開啟接受頁 → 點加入 → 落在行程頁且可見編輯入口；再驗 viewer 邀請 → B2 進入後無編輯入口（Task 5 的唯讀化斷言）；owner 面板移除 B → B 再開行程頁 404。**測試帳號隔離（審查 M-5）**：每檔專屬 email 前綴——本檔用 `e2e-invite-`、既有 smoke.spec.ts 同步改為 `e2e-smoke-`（Task 8 分享冒煙用 `e2e-share-`）；清理只 filter 自己前綴，且 **listUsers 改為翻頁掃到底**（修既有「只掃第一頁」缺口，spec §8 該條目同步更新）。雙跑零殘留。
- [ ] **Step 5: 部署檢查點 B** — migration 推雲端（`supabase db push` 既有 kill+verify workaround）→ **push 後權限驗證（審查 M-9）**：SQL editor 執行並斷言——

```sql
select has_column_privilege('authenticated', 'public.trips', 'share_token', 'UPDATE'); -- 必須 false
select has_column_privilege('authenticated', 'public.trips', 'title', 'UPDATE');       -- 必須 true
select has_table_privilege('anon', 'public.trip_invites', 'SELECT');                    -- 必須 false
select has_function_privilege('anon', 'public.accept_trip_invite(uuid)', 'EXECUTE');    -- 必須 false
```

  再抽查 trip_invites 存在、兩顆 RPC 的 ACL → merge + Vercel 部署 → 線上真實兩帳號走一遍邀請流程。→ **Commit** `feat: 成員面板與邀請流程（產生/接受/撤銷/角色切換/移除/退出）+ E2E`

---

### Task 8: 分享預覽——免註冊唯讀連結【殿後・回國後可】

**Files:** Create `supabase/migrations/20260804000000_share_rpc.sql`、`src/lib/supabase/share.test.ts`、`src/app/share/[token]/page.tsx`；Modify `page.tsx`（trips select 補 `share_token`）、`TripView.tsx`（Trip 型別補 `share_token`、autoPlay、播放鏡頭跟隨）、`MembersPanel.tsx`（或 header）加分享對話框

- [ ] **Step 1: migration** — **顯式欄位白名單（審查 M-3）**，逐欄 `jsonb_build_object`；無列時 SQL 函式天然回 null（不寫 `case when` 死碼）：

```sql
begin;
-- 分享預覽（spec §4：share_token 免註冊唯讀、可重生成使舊連結失效）。
-- 設計：SECURITY DEFINER RPC 以 token 換一份唯讀 jsonb，anon 不獲任何表級權限；
-- token 錯誤時查無列，SQL 函式回 null——對外語義一律「連結已失效」，不區分不存在/已重生成。
-- 欄位採顯式白名單（不用 to_jsonb 減鍵：新增欄位時「預設外洩」是錯的方向；白名單漏欄頂多少顯示）。
-- 花費/備註刻意包含：分享對象是旅伴，花費對齊正是 spec §2 預估花費的目的。
-- legs 含 updated_at：分享頁重用 TripView 的 Leg 型別（樂觀鎖欄位），唯讀路徑不使用其值。
create function public.get_shared_trip(p_token uuid) returns jsonb
language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'trip', jsonb_build_object(
      'id', t.id, 'title', t.title, 'start_date', t.start_date,
      'end_date', t.end_date, 'currency', t.currency),
    'stops', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'lat', s.lat, 'lng', s.lng, 'place_id', s.place_id,
        'is_custom', s.is_custom, 'timezone', s.timezone, 'starts_at', s.starts_at,
        'ends_at', s.ends_at, 'locked', s.locked, 'notes', s.notes,
        'estimated_cost', s.estimated_cost
      ) order by s.starts_at, s.id) from stops s where s.trip_id = t.id), '[]'::jsonb),
    'legs', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'from_stop_id', l.from_stop_id, 'to_stop_id', l.to_stop_id,
        'mode', l.mode, 'duration_minutes', l.duration_minutes,
        'distance_meters', l.distance_meters, 'polyline', l.polyline, 'detail', l.detail,
        'source', l.source, 'stale', l.stale, 'departs_at', l.departs_at,
        'arrives_at', l.arrives_at, 'estimated_cost', l.estimated_cost,
        'updated_at', l.updated_at
      ) order by l.id) from legs l where l.trip_id = t.id), '[]'::jsonb)
  )
  from trips t where t.share_token = p_token
$$;
-- 這顆 RPC 的存在意義就是給匿名訪客用：grant 給 anon + authenticated
grant execute on function public.get_shared_trip(uuid) to anon, authenticated;
commit;
```

  （行程規模護欄由寫入端 500 limit 承擔，jsonb_agg 不另設上限。db-expert 審白名單完整性、以及 updated_by/owner_id/share_token 等敏感欄不在單內。）
- [ ] **Step 2: RLS/行為測試** — Create `share.test.ts`：anon client `rpc('get_shared_trip', 有效 token)` → 拿到 trip/stops/legs 且 **stops/legs 每列鍵集合恰等於白名單**（斷言 `Object.keys().sort()` 全等，不是「包含」）；亂 token → null；anon 直接 select trips/stops/legs → 拒；owner `regenerate_share_token` 後舊 token → null、新 token → 有效（「連結已失效」語義閉環）。
- [ ] **Step 3: 分享頁** — Create `app/share/[token]/page.tsx`（server component，**先讀 Next docs**）：token 非 UUID 或 RPC 回 null → 「連結已失效」頁（明確文案 + 回首頁連結，spec §6 錯誤表）；有效 → 重用 `<TripView canEdit={false} …>`（分享頁 = 無帳號 viewer；Task 5 的唯讀化即本頁地基）。metadata：`robots: { index: false }` + **`referrer: 'no-referrer'`**（token URL 不得外洩）。
  - **autoPlay（spec §5「分享連結預設進播放模式」）**：TripView 增可選 prop `autoPlay`；**用惰性 useState 初始化**（避免 set-state-in-effect lint——本專案已兩度踩過）：`playing`/`playheadMs` 的初始值以 `autoPlay` 與第一天視窗推導（`useState(() => …)`），不開 effect。
  - **播放鏡頭跟隨（審查 M-7，README:87/90 的 Plan 5 承諾）**：CameraFollow 的 target 改為**衍生值**——`playing && 插值位置存在 ? 插值位置 : cameraTarget`，零新 state。實作範圍如實估：`interpolatePosition` 目前算在 `<Map>` 內的 IIFE 裡（TripView.tsx 的橘點區塊），需**先提升到 component body** 供橘點與 CameraFollow 共用；且 CameraFollow 的 effect 依賴要改以 **lat/lng 數值**比對（或 memo 座標物件），否則播放中每秒 render 產生新物件參照、每 render 都觸發 panTo。主行程頁同享此改進。README:87/90 兩條限制同步改記「播放中鏡頭跟隨『我』標記；分鏡運鏡等完整預覽動畫屬後續」。
  - 手機響應式僅驗證可看可播，不做編輯。
- [ ] **Step 4: 分享對話框** — page.tsx 的 trips select 補 `share_token` 欄位、TripView 的 `Trip` 型別補**可選欄位 `share_token?: string`**（成員的 trips select 可讀範圍本就含它；宣告為可選讓分享頁等不帶 token 的資料來源同用此型別），分享鈕以 `share_token` 非 null/undefined 為顯示條件。**🚫 紅線：嚴禁為了通過型別檢查把 `share_token` 加進 get_shared_trip 的白名單**——那等於把「撤銷憑證」本身送給所有匿名訪客，重生成機制瞬間作廢。header「分享」鈕（成員可見）：顯示 `${origin}/share/${share_token}`＋複製鈕；owner 另有「重新產生連結」（confirm 說明舊連結將失效 → `rpc('regenerate_share_token')` → 更新顯示）。
- [ ] **Step 5: 驗證** — db-expert 審 migration；全套綠；手動：無痕視窗開分享連結 → 唯讀 + 自動播放 + 鏡頭跟隨；重生成後舊連結顯示失效頁；E2E 補一條「分享連結唯讀檢視」冒煙（`e2e-share-` 前綴；無痕 context 開 share URL 斷言標題與無編輯入口）。→ **Commit** `feat: 分享預覽（share RPC 白名單、唯讀分享頁、自動播放與鏡頭跟隨、連結重生成）`

---

### Task 9: 地圖 polyline（Plan 4 Task 7 補作）【殿後・旅途中有空可補】

**Files:** Create `src/app/trips/[tripId]/RoutePolylines.tsx`；Modify `TripView.tsx`

- [ ] 依 Plan 4 計畫 Task 7 的完整過稿實作（`docs/superpowers/plans/2026-07-31-travel-planner-transit.md` Task 7——RoutePolylines 元件全文、TripView 掛載點、驗證清單皆已寫死，照抄執行）；唯一增量：分享頁與 viewer 唯讀模式同樣掛載（純顯示元件，無權限面）。README 已知限制「polyline 尚未實作」條目移除、功能清單補記。→ **Commit** `feat: 選中日地圖路線（polyline 實線 + flight 虛線）`

---

### Task 10: PR #3 Task 9 清項 + PR #4 Minor 殘項根治【回國後】

**Files:** Modify `Timeline.tsx`、`TripView.tsx`、`README.md`、`src/lib/domain/schedule.ts`、`src/lib/domain/tz.test.ts`、`LegEditor.tsx`、`src/app/login/page.tsx`（next 參數，可選）

- [ ] **Step 1: PR #3 清單（Plan 4 計畫 Task 9 原文七項，該處已寫死實作規格，照抄執行）** — M-1 拖曳回彈 pendingDelta（pendingShift 狀態 + Timeline 偏移）、M-3 moveStop busy 提示、M-4 addStop 改用 filterDayStops、M-5 加點落他日 activeDay 跟隨、M-6 時間軸起訖標籤跨時區、M-8 README 鎖定語義、S-4 schedule.ts 檔頭註記。每項改完即跑全套（互不相干，壞了好定位）。
- [ ] **Step 2: spec §8 DST 條目根治**（Plan 4 記載的「M-6 跨 DST 邊界」——與上一步 PR #3 的 M-6 時間軸標籤**重名但不同項**，本計畫一律以「spec §8 DST 條目」稱呼消歧）— tz.test.ts 補案例：`wallInputToUtcMs('2026-03-08T02:30', 'America/New_York')`（春進不存在時刻）斷言 date-fns-tz 的實際位移行為並以註解鎖定「靜默位移為現行接受的語義」；同補秋回重複時刻案例。**決策：不改為顯式拒絕**（本產品時區主場景東亞無 DST；防禦的複雜度大於風險），spec §8 該條目改記「已補測試鎖定行為，顯式拒絕不做」，**README:98 的 DST 條目同步改寫**（「尚無專屬測試覆蓋」→「已有測試鎖定此行為」）。
- [ ] **Step 3: S-8 custom 段「只填時長」子表單** — LegEditor：custom 模式下起訖欄改為可選——只填時長走 manual 時長儲存分支（departs/arrives null）、只填起訖走現行分支、都填以起訖為準（時長由起訖導出）、都空報錯。flight 維持必填起訖（航班本質）。README 對應限制條目移除。
- [ ] **Step 4（可選）: login `next` 回跳參數** — Task 7 降級方案的補完：login 頁讀 `next` searchParam、OAuth callback 轉發（僅允許站內相對路徑白名單）；完成後邀請接受頁改為自動回跳並更新 README 已知限制。時間不夠就保持降級方案。
- [ ] **Step 5: 驗證** — 全套綠 + 手動抽驗 M-1（拖曳不回彈）與 custom 只填時長。→ **Commit** `fix: PR #3 清項與 DST 測試、custom 時長子表單（遺留根治收尾）`

---

### Task 11: Realtime 共編——refresh-based 同步 + presence【回國後】

**Files:** Create `src/app/trips/[tripId]/TripRealtime.tsx`；Modify `TripView.tsx`；Modify spec §8 / README

> 範圍界定（spec §6 是完整定義，本 Task 做其中 refresh-based 的最小正確集）：訂閱變更 → debounce refresh、presence 頭像、斷線橫幅＋暫停編輯。**不做**：樂觀更新廣播細粒度合併（現行 router.refresh 全量拉回即 spec「重連後整份重抓」的常態化）、游標級 presence（spec §5 明言不做）。「他人改動卡片高亮 + 文案」列為本 Task 可裁步驟。

- [ ] **Step 1: 訂閱元件** — Create `TripRealtime.tsx`（client，掛在 TripView 內；實作前照 AGENTS.md 慣例重讀 Supabase 官方 subscribing-to-database-changes 文件確認 API 簽名）：單一 channel `trip:{tripId}`，`postgres_changes` 訂 stops/legs（`filter: trip_id=eq.{tripId}`）與 trips（`id=eq.{tripId}`）；事件處理：
  - INSERT/UPDATE → 500ms debounce `router.refresh()`（**忽略 `updated_by === 自己` 的事件**——自己的寫入路徑已各自 refresh，避免雙重刷新）。
  - DELETE → **payload 僅含 PK（id）；以本地 stops/legs id 集合比對，命中才 refresh**（spec §8：DELETE 不套 RLS、不能 filter，會收到其他行程的刪除事件——冪等處理，未命中靜默忽略，絕不信 payload 其他欄位）。
- [ ] **Step 2: presence** — 同 channel presence：track `{ userId, displayName }`（page.tsx 補查自己的 profile display_name 傳入）；TripView 頂部顯示在線頭像（首字圓 badge + title 全名）。
- [ ] **Step 3: 斷線行為（spec §6）** — subscribe status `CHANNEL_ERROR`/`TIMED_OUT` → 橫幅「連線中斷，他人改動暫時看不到」＋**暫停編輯**（重用 stopsError 的「關閉寫入入口」既有機制——同一 prop 通道傳 disconnected 旗標）；恢復 `SUBSCRIBED` → 清橫幅 + 立即 refresh（整份重抓）。viewer/分享頁不掛訂閱元件（唯讀者用手動刷新即可，省 anon realtime 授權面——分享頁 anon 本就無 RLS 讀權，postgres_changes 不會放行）。
- [ ] **Step 4（可裁）: 他人改動回饋** — UPDATE 事件的 new id 若在當日視圖，卡片短暫高亮 2 秒（spec §5 輕量路線；文案「◯◯ 剛更新了行程」用 payload updated_by 對 profiles 查名，查無則「已離開的成員」）。
- [ ] **Step 5: spec §8 / README 更新** — 「多 editor 同開重複 sync」條目改記：Realtime 上線後他人變更僅觸發 refresh 不觸發 sync（sync 觸發者 = 編輯者本人，spec §6「重算由編輯者觸發」原則落地）；殘留窗口 = 多 editor 同時開頁的掛載 sync，快取與 unique 撞擊吸收，記錄即可。補「postgres_changes 商用前遷 Broadcast from Database」條目（官方規模化建議；**門檻量級：約數千併發訂閱者時「每事件×每訂閱者」的授權檢查成為瓶頸，~3000 為經驗參考值**；DELETE 全量廣播成本同記）。
- [ ] **Step 6: 驗證** — **先 `docker start supabase_realtime_traval`**（README 節能腳本平時停用該容器，忘開會得到假陰性）；雙瀏覽器手動：A 改停留點 → B 數秒內看到且無自刷風暴；B 刪停留點 → A 同步消失；斷網 → 橫幅 + 寫入入口關閉 → 恢復自動收斂；E2E 雙 context 冒煙（A 插入停留點、B 斷言出現——容忍 refresh 延遲的寬鬆 timeout）。→ **Commit** `feat: Realtime 共編（變更訂閱 refresh、presence、斷線橫幅）`

---

### Task 12: 總收尾——README / spec §8 / 部署【回國後】

**Files:** Modify `README.md`、spec §8；正式環境操作

- [ ] **Step 1: README** — 功能清單補：邀請旅伴（角色/成員管理）、分享連結（實作落地，原本只是願景句）、Excel/JSON 匯出、定稿快照、Realtime 共編；專案狀態補 Plan 5 ✅；已知限制增刪如各 Task 所記，另補：邀請連結效期 7 天（上限 30 天）且多次可用（撤銷 = 刪除）、分享頁無流量限制（token 122-bit 隨機為主防線）、**分享頁的 auto 段若尚未計算/已逾期只顯示「待計算」——匿名訪客不觸發 sync，需任一 editor 開啟行程後才會更新**、邀請接受頁登入後需重開連結（`next` 回跳屬後續；若 Task 10 Step 4 已做則免記）。
- [ ] **Step 2: spec §8 增補** —

| 項目 | 說明 | 處理時機 |
|------|------|---------|
| exceljs 維護停滯 | 4.4.0 約兩年未發版；本專案僅用寫入路徑，解析類 CVE 不適用；npm audit 傳遞依賴告警已記載 | 若未來需解析上傳檔案時重評（候選 @e965/xlsx 等） |
| 邀請 token 無使用次數上限 | 效期內（≤30 天）多次可用（群組分享語義）；外洩即可入團，撤銷靠刪除邀請 | 記錄即可（角色最高 editor，owner 權力不外溢） |
| token 隨 URL 進入日誌 | 邀請/分享 token 在 URL path，會出現在 Vercel access log／瀏覽器歷史；頁面已設 no-referrer 阻斷外站 Referer 外洩 | 記錄即可（token 可重生成/撤銷；商用前評估改 POST + 短效兌換碼） |
| share RPC 無限流 | anon 可打 get_shared_trip；token 122-bit 不可枚舉為主防線，單 token 洗流量無護欄 | 商用前與路線代理同批上集中式限流 |
| postgres_changes 規模化 | 每事件對每訂閱者授權檢查（~3000 併發訂閱為經驗門檻）；DELETE 不套 RLS 全量廣播 | 商用前遷 Broadcast from Database（官方建議路徑） |
| 轉移擁有權未做 | owner 不可被移除（既有 policy 的 `user_id <> auth.uid()` 排除自己＋成員 delete policy 不及於 owner），role 白名單（editor/viewer）擋的是**提權**——不能把任何成員升成 owner；owner 刪帳號後行程無人可管理（既有條目，共編上線後影響升級） | 後續迭代 |

  既有條目更新：spec §8 DST（改記已補測試、顯式拒絕不做）、多 editor 重複 sync（改記 Realtime 後語義）、Realtime DELETE（改記已依冪等規則落地）、E2E listUsers 分頁（Task 7 已修，條目移除）；快照名稱灰色地帶條目已在 Task 3 寫入（此處覆核存在即可）。
- [ ] **Step 3: 部署與回滾** — 殘餘 migration（share_rpc）推雲端（kill+verify workaround）→ Vercel 部署 → 線上冒煙：分享連結無痕檢視、Realtime 雙帳號同步。回滾路徑總結覆核 README 部署段（Task 6 已先落地）：前端 Vercel Instant Rollback；migrations 均為**純新增**（新表/新函式/GRANT 收緊/policy 重建）——非增量項的回滾單條 SQL：`grant update on public.trips to authenticated;`（還原欄位收緊）；invites 應急停用：`revoke execute on function public.accept_trip_invite(uuid) from authenticated;`（邀請暫停、既有成員不受影響）；trip_members policy 若需還原，重跑 init.sql 原版 create policy 語句即可。
- [ ] **Step 4: 全量驗證** — lint/tsc/build/vitest 全綠 / Playwright 全部（smoke + invite + share 冒煙）雙跑零殘留 → **Commit** `docs: Plan 5 收尾（README、spec 殘留風險、部署與回滾）` → push。

---

## 完成定義（Definition of Done）

- [ ] lint / tsc / build 乾淨；vitest 全綠（基線 80 + exportRows ≈9 + legSync detach ≈4 + snapshot ≈6 + invites ≈14 + share ≈4 + tz DST 2，**以實跑為準**）；Playwright（smoke + invite + 分享冒煙）雙跑零殘留、各檔專屬前綴（e2e-smoke-/e2e-invite-/e2e-share-）清理互不相殺、listUsers 翻頁掃到底
- [ ] **出發前（8/1 夜）檢查點 A 已上線**：花費轉存保護、Excel 可下載、**定稿快照已按下且 DB 有快照列（不可裁）**、側欄警示（被砍時如實記載）
- [ ] `npm audit`（exceljs 傳遞依賴）結果已如實記載於回報與 spec §8
- [ ] 權限面可驗證（vuln-verifier PoC 全數拒絕）：非 owner 不能建/看/撤邀請；anon 摸不到 invites 表與 accept RPC；無效與過期 token 回應不可區分；已有成員 accept 不改角色；**owner 不能把成員提權成 owner**；editor 改不了 share_token/owner_id；anon 只能經 get_shared_trip 白名單取唯讀資料；雲端 push 後 `has_*_privilege` 斷言全過
- [ ] ToS 分層維持：detach 轉存段與快照 jsonb 均無 Google 衍生欄位、快照非 custom 停留點無經緯度（DB 抽查）
- [ ] 線上真實驗證：兩帳號邀請流程走通、分享連結無痕可看可播（含鏡頭跟隨）、重生成後舊連結失效
- [ ] README / spec §8 如實更新（含 spec §4 快照名稱修訂、M-8 決策留痕）；全部 commit 推上 feat/plan-5-sharing；被裁任務（4/9/10/11 視旅途情況）在 README 與回報中如實記載
