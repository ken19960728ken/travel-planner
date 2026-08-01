# Plan 7：地點分類 實作計畫

> 狀態：**已拆解，尚未開工**（使用者 2026-08-01 指示暫停展開新工作）。
> 來源：planner 拆解報告，所有事實經實際查證（DB ACL、官方文件 WebFetch、分支 diff）。

**Goal:** 停留點與備選地點各有六值 `category`；搜尋加入時由 Google types 在瀏覽器記憶體推導預填、使用者當場可改；地圖圖釘與時間軸依分類上色、側欄與備選庫顯示圖示；備選庫依分類分組；Excel 多一欄分類並附小計。

**紅線:** DB 不存任何 Google raw `types`/`primaryType`/評分/營業時間，只存我方六值 slug。

---

## 關鍵查證事實

### 事實一：stops 是表級 GRANT，新增欄位**不需要**補 grant

```
pg_class.relacl:
  stops           | authenticated=arwd   ← 表級，attacl 全空
  trip_candidates | authenticated=rd     ← 只有 SELECT+DELETE，INSERT/UPDATE 走欄位白名單
  trips           | authenticated=ard
pg_attribute.attacl（唯一有欄位級 ACL 者）:
  trips           | title,start_date,end_date,currency → authenticated=w
  trip_candidates | trip_id,lat,lng,place_id → authenticated=a ; name → authenticated=aw
  stops           | （無任何列）
```

- `stops.category` 新增後**自動繼承** INSERT/UPDATE/SELECT。
- `trip_candidates.category` **必須同時進 insert 與 update 兩份白名單**，否則 PostgREST 回 42501 靜默失敗。
- 判斷依據必須是 `pg_class.relacl` + `pg_attribute.attacl`；查 `information_schema.column_privileges` 會把表級展開成逐欄列而誤判。

### 事實二：現有配色語意（新配色不可撞）

| 值 | 語意 | 位置 |
|---|---|---|
| `#2563eb` blue-600 | 已選取 | TripView.tsx:773 / Timeline.tsx:150 |
| `#ef4444` red-500 | 當日停留點 | TripView.tsx:773 |
| `#d1d5db` gray-300 | 他日停留點 | TripView.tsx:773 |
| `#9ca3af` gray-400 | 草稿針／搜尋預覽針 | TripView.tsx:784,789 |
| orange-500 | 播放頭／拖曳位移量 | TripView.tsx:798, Timeline.tsx:122,193 |
| `bg-red-600` | 時間衝突 | Timeline.tsx:150 |
| `bg-emerald-600` | 一般色塊（**本 Plan 重新賦義為景點**） | Timeline.tsx:150 |
| red-100/red-700 | 趕不上連接條 | Timeline.tsx:180 |

→ 紅色系、橘色系、blue-600、gray-300/400 全數被佔用，六桶配色一律迴避。

### 事實三：既有 `RATABLE_TYPES` 只有 15 個 type

`placePreview.ts:4-20` 漏掉整片 Food and Drink 細分類（`ramen_restaurant`、`sushi_restaurant`、`izakaya`…）→ **日本行程的拉麵店今天不會自動抓評分**，是既有潛在缺陷，本 Plan 順帶修掉。

---

## 設計決策

### D1 — 六桶對照表（以官方 Table A/B section 為單位）

```
transport ← Table A「Transportation」全 section 減 bridge
sight     ← Table A「Culture」+「Entertainment and Recreation」+「Natural Features」
            +「Places of Worship」全 section
            + 具名補入 bridge, ski_resort, stadium, arena
            + Table B: place_of_worship, natural_feature, landmark, town_square
food      ← Table A「Food and Drink」全 section（約 180）+ Table B: food
lodging   ← Table A「Lodging」全 section（18）
shopping  ← Table A「Shopping」全 section（43）
other     ← 其餘全部，且為預設值
```

Table B 必須納入掃描——官方明載 Table B 型別「may also be returned as part of Place Details / Nearby / Text Search / Autocomplete response」，且「a place has a single primary type from **Table A or Table B**」。

**推導順序（寫死）**：
1. `primaryType` 查表 → 命中且非 `other` 即回傳
2. 依 `types` **陣列原順序**逐項查表 → 第一個非 `other` 命中即回傳
3. 全不命中 → `other`

真實案例驗證（必須成為單元測試）：
- 東京駅 `['train_station','subway_station','transit_station','shopping_mall',…]` → `transport`
- 明治神宮 `primaryType='shinto_shrine'` → `sight`
- 一蘭 `primaryType='ramen_restaurant'` → `food`
- 帶餐廳的飯店 `['hotel','lodging',…]` → `lodging`
- 純雜訊 `['point_of_interest','establishment']` → `other`

### D2 — `RATABLE_TYPES` 統一：做，並明確承擔計費放大

`isRatableCategory = (t,p) => RATABLE_CATEGORIES.has(categorize(t,p))`，`RATABLE_CATEGORIES = {food, sight, lodging, shopping}`。

- 既有 4 個測試案例全數維持通過（已逐一比對，無需改測試）
- **行為擴大**：白名單 15 → 約 250 個 type，幾乎所有餐飲/景點/住宿/購物都會打一次 Enterprise 批次
- **量化承擔**：只在預覽卡掛載時觸發、一次搜尋最多一次、`placeDetailCache` 同分頁去重 → 單次規劃 session 數十次 vs 免費額度 1,000/月。**明確接受**，決策寫進 `placePreview.ts` 註解（取代現有「車站/機場一律不主動抓」那段，避免註解與程式碼說法不一致）

### D3 — 檔案分層

- `src/lib/domain/placeCategory.ts`（新，domain）：`StopCategory`、`CATEGORY_ORDER`、`CATEGORY_LABEL`、`categorize()`、`normalizeCategory()`。約 330 筆對照常數放這裡
- `src/app/trips/[tripId]/categoryUi.ts`（新，app）：`CATEGORY_PIN_HEX`、`CATEGORY_BLOCK_CLASS`、`CATEGORY_ICON`。標籤只放 domain 一份、此檔 re-export，**不重蹈 `MODE_LABEL` 在 legUi 與 exportRows 各寫一份的覆轍**

### D4 — 視覺規格

| 桶 | 繁中 | Pin hex | Tailwind class | Emoji |
|---|---|---|---|---|
| transport | 交通站 | `#0891b2` | `bg-cyan-600` | 🚉 |
| sight | 景點 | `#059669` | `bg-emerald-600` | 🗼 |
| food | 餐飲 | `#b45309` | `bg-amber-700` | 🍜 |
| lodging | 住宿 | `#7c3aed` | `bg-violet-600` | 🏨 |
| shopping | 購物 | `#db2777` | `bg-pink-600` | 🛒 |
| other | 其他 | `#6b7280` | `bg-gray-500` | 📍 |

約束（驗收條件）：
- 迴避事實二所有既有語意色
- **Tailwind v4 只掃字面字串**，`bg-${x}` 必失效 → `CATEGORY_BLOCK_CLASS` 必須是完整字面 class 的 Record
- Emoji 選**不需 U+FE0F 變體選擇子**的碼位（🗼 而非 🏛️、🏨 而非 🛏️、🛒 而非 🛍️），避免跨平台變黑白字元。**不得引入圖示套件**

**圖釘的狀態 × 分類雙重編碼（本 Plan 最容易做壞處）**：現行 `background` 同時承載「選取/當日/他日」三態，改為分類色後三態須換載體：

```
background  = CATEGORY_PIN_HEX[category]        （全部停留點，含他日）
glyph       = 當日序號 ／ null（他日）            ← 序號是既有順序資訊，不可移除
borderColor = '#2563eb'（選取）／ '#fff'
scale       = 1.3（選取）／ 1.0（當日）／ 0.7（他日）
```

**強制驗收關卡**：zoom 12 截圖確認「當日 vs 他日」仍一眼可辨。若失敗，**既定 fallback**：他日 background 退回 `#d1d5db`（分類色只作用於當日），不再另行設計。分類圖示不進圖釘（glyph 讓給序號），只出現在側欄／時間軸／備選庫。

### D5 — 花費分類統計：七桶，不把 legs 併進 transport

「交通站（車站買便當/寄物）」與「交通段（車資）」是兩種花費，合併會讓 transport 語意不明。→ 六個 stops 桶 + 獨立第七桶「交通段」（legs 全體，不再依 mode 細分）。

**不變量（必須寫成測試）**：`sum(六桶) + 交通段 === totalEstimatedCost(既有總計)`。

### D6 — 分類預設停留時長：只改兩桶

| 桶 | 分鐘 |
|---|---|
| transport | 15 |
| sight | 90 |
| food / shopping / lodging / other | 60（與現行相同＝零行為變化） |

**住宿過夜明確延後**，理由具體：`dayWindow`（Timeline.tsx:32-37）取當日 min(starts)-1h ~ max(ends)+1h，一個 12 小時區塊會把當日視窗撐到 14 小時、其餘停留點壓成不可點擊細條；同時 `detectConflicts` 會把飯店與隔天所有行程判為衝突（全紅）。正確做法是給住宿獨立渲染處理，屬另一個 Plan。

### D7 — 既有資料

`stops` 現有列一律 `'other'`。**無法回填**——未存 Google types，且 ToS 不允許為回填而呼叫 Places API。出發前若要正確分類需在 StopEditor 手動改。寫進 README 已知限制。

---

## Risks

| # | 風險 | 處置 |
|---|---|---|
| R1 | stops 需補欄位級 GRANT | **已排除**（事實一），Task 2 仍以實測驗收 |
| R2 | trip_candidates.category 漏補白名單 → 42501 靜默失敗 | Task 0 同補 insert+update；Task 7 驗收第 5 條專門反證此項 |
| R3 | `get_shared_trip` 白名單漏 category → 分享頁 undefined 查表爆炸 | Task 10 補欄 + 所有查表一律 `MAP[c] ?? MAP.other` / `normalizeCategory()` 收口 |
| R4 | Tailwind 動態 class 不生成 → 色塊全透明 | 字面字串 Record；build 後瀏覽器實測六色 |
| R5 | Enterprise 呼叫放大 | **明確接受**（D2 已量化） |
| R6 | 新配色撞既有語意色 | D4 已列排除清單；critic 逐項比對驗收 |
| R7 | 既有 stops 全 `other` 需手改 | **明確接受**，寫進 README |
| R8 | `supabase gen types` 把其他分支的表混進 diff | **禁止 gen types**，一律手工加欄 |
| R9 | 分類小計 ≠ 總計 | D5 不變量測試 |
| R10 | TripView/Timeline/exportRows 是飛行中分支熱點 | Wave 1 前不動；Task 4→6 序列化；Task 9 排在 japan-transit 合併後 |
| R11 | ToS：推導值算不算 Google content | 使用者已定案為「使用者自有標記」。**強化**：Task 4 必須在預覽卡露出下拉、使用者按加入前看得到並可改 → 落地的是使用者確認過的值。**此為設計成立的關鍵前提，不得省略成靜默自動填** |
| R12 | 住宿過夜撐爆 dayWindow | **明確延後**（D6） |

---

## 任務清單

### Wave 0（不依賴任何合併，可立即開跑）

**Task 0 — `trip_candidates.category` 規格（併入 plan6/task1-migration 修正輪，不獨立開分支）**
- 於 `create table` 內 `place_id` 之後加：`category text not null default 'other' constraint trip_candidates_category_check check (category in ('transport','sight','food','lodging','shopping','other'))`
- GRANT **兩行都要改**：`grant insert (trip_id,name,lat,lng,place_id,category)`、`grant update (name,category)`
- `database.types.ts` 手工加欄（禁止 gen types）
- PoC 追加三條並重跑整組：editor 帶 category insert 成功／`category='INVALID'` 回 23514／editor update category 成功且 viewer 影響 0 列／既有 `created_by` 偽造仍失敗
- 邊界：不動 limit trigger、RLS policy、unique 約束、Realtime；不動 stops；不新開 migration 檔

**Task 1 — `placeCategory.ts` + `placePreview` 單一來源化** → `fullstack-engineer`
- 新增 `placeCategory.ts`(+test)；改寫 `placePreview.ts` 的 `isRatableCategory`；`placePreview.test.ts` **既有 4 案例一字不改**
- 實作時必須逐 section 對照官方 place-types 頁，不得憑記憶補字串
- 測試須含：D1 五個真實案例、primaryType 優先於 types、Table B 案例、bridge/ski_resort 例外、**重複偵測測試**（遍歷六陣列斷言無 type 出現在兩處）、每桶至少 5 個代表性 type
- 邊界：不得 import React/Supabase/app 層；不得放顏色或 emoji

### Wave 1（待 plan6/*、plan5/task8-share、feat/japan-transit-fallback 全合併）

**Task 2 — `stops.category` migration + 型別 + 讀取路徑** → `fullstack-engineer`（migration 需 db-expert 審）
- 新 migration：`alter table public.stops add column category text not null default 'other' constraint stops_category_check check (...)`
- 註解須寫明：不需 GRANT 的理由（表級授權，與 trips 欄位級處置刻意不同）、用 text+check 不用 enum、既有列 `other` 無法回填、回滾路徑、PG11+ 不觸發全表重寫
- `TripView.tsx` **只改 Stop 型別宣告**；`page.tsx` 兩處 select 補 category
- 驗收關鍵：`pg_attribute.attacl` 對 stops **回 0 列**（證明未誤加欄位級 ACL）；**舊程式碼相容驗證**——不帶 category 的 insert 成功且該列為 `other`
- 邊界：不得動 TripView 任何渲染或函式

**Task 3 — `categoryUi.ts`** → `frontend-designer`
- 三個 Record + re-export `CATEGORY_LABEL`/`CATEGORY_ORDER`
- 檔頭註解列出迴避的既有語意色與理由
- 驗收：六個 class 全為字面字串；六個 emoji 皆不含 U+FE0F（`node -e` 逐字檢查）；無 hex/色階與事實二重複
- 邊界：不得引入任何 npm 套件；不寫 JSX

### Wave 2（Task 2 & 3 完成後全並行）

**Task 4 — 加入地點時擷取並確認分類（寫入路徑）** → `fullstack-engineer`
- `PlacePick` 加 `category`，在 `gmp-select` handler 內 `categorize(place.types ?? [], place.primaryType ?? null)`
- `PlacePreviewCard` 加 `initialCategory` prop + 六選項 select；`onAdd`/`onSaveCandidate` 簽章加 category
- `addStop` 加 category；右鍵草稿一律 `'other'`
- ToS 註解擴充：**只有六值 slug 會離開本元件**，`place.types`/`primaryType`/`detail` 一律不得帶出
- 驗收：東京駅預選交通站／一蘭預選餐飲／飯店預選住宿；手改後寫入的是改後值；`grep -n "types\|primaryType" TripView.tsx` → **0 筆**
- 邊界：**不得改 `PlaceSearch.tsx:52` 的 fetchFields 欄位清單**（改了就是新增 API 成本）；不得動 Enterprise 抓取邏輯
- **Task 11 的 TripView 那一行併給本任務執行者**（省一次序列化）

**Task 5 — StopEditor 分類下拉** → `fullstack-engineer`（單檔）
- 驗收含**樂觀鎖回歸**：另一分頁改 starts_at 後回原分頁存 → 仍顯示「已被其他操作變更」
- 邊界：不動樂觀鎖三個 `.eq()`、不動 remove()、不動時間處理

**Task 7 — 備選庫依分類分組 + 分類編輯** → `fullstack-engineer`（單檔）
- 依 `CATEGORY_ORDER` 分組、**空組不渲染**；canEdit 時每列多一個分類 select
- 驗收含 **R2 反證測試**：暫時把 grant 改回 `grant update (name)` 重跑，確認改分類顯示「未生效，請重新整理」而非靜默成功 → 驗畢改回
- 邊界：不動 onPromote 契約、rename/delete 邏輯、page.tsx、TripView

**Task 8 — `costByCategory` + `CostSummary` 元件** → `fullstack-engineer`
- 純函式 + 未掛載的展示元件（掛載由 Task 6 做，避免 TripView 併發衝突）
- 驗收必含 **D5 不變量測試**（隨機組合下 `sum(byCategory)+legs === total === totalEstimatedCost(...)`）
- 邊界：不改 `totalEstimatedCost`/`perPersonCost`；不把 legs 併進 transport；不做圖表

**Task 9 — Excel 分類欄與小計** → `fullstack-engineer`（**依賴 japan-transit 已合併**）
- `ItineraryRow` union 加 `categoryTotal`；「項目」與「分鐘」之間插入分類欄；四種既有 row kind 的 addRow 全部補 category 鍵
- 驗收：不變量（小計和 === 總計）、全 null 時不產生 categoryTotal 列、**防公式注入不變量維持**（`grep -n "formula"` → 0）
- 邊界：匯出用純文字標籤**不用 emoji**（Excel 跨平台字型風險）

**Task 10 — 分享 RPC 補欄 + snapshot 補欄** → `fullstack-engineer`（migration 需 db-expert 審，**依賴 task8-share 已合併**）
- 先 `select pg_get_functiondef(...)` 確認現況，再 `create or replace` 完整重貼，stops 的 jsonb_build_object 加 `'category', s.category`，其餘一字不改
- 驗收：`jsonb_object_keys` 比對其餘鍵逐鍵相同；`pg_proc` 確認 grant/prosecdef/provolatile 未在 replace 中遺失
- `snapshot_version` **維持 1**（純加欄向後相容）

**Task 11 — 分類驅動的預設停留時長** → `fullstack-engineer`（**依賴 plan6/task2-slot 已合併**）
- `slot.ts` 加 `CATEGORY_STAY_MINUTES` + `stayMsForCategory()`；`nextDefaultSlot`/`defaultSlotForDay` 加**可選**參數（既有呼叫端不傳即行為完全不變）
- 驗收：既有 slot.test.ts 案例**一字不改仍通過**
- 邊界：不改前兩參數語義與順序、不改 `GAP_MS`、不實作住宿過夜

### Wave 3

**Task 6 — 地圖/時間軸/側欄分類視覺** → `frontend-designer`（**blocked by 4 同檔、3、8**）
- 圖釘雙重編碼（D4）；時間軸優先序寫死 `conflict(bg-red-600) > CATEGORY_BLOCK_CLASS`，選取改 `ring-2 ring-blue-500` 疊加；側欄序號後插圖示；掛載 CostSummary
- 所有查表一律 `MAP[c] ?? MAP.other` 或先過 `normalizeCategory()`（防 R3）
- **截圖驗收（強制）** + **狀態語意回歸清單逐項確認**：選取藍框放大／切 Day 大小與序號／衝突紅色壓過分類色／衝突+選取同時（紅底+藍 ring）／播放頭橘線／趕不上連接條／🔒 圖示／拖曳平移／viewer onClick 路徑
- 邊界：**不得改任何互動邏輯**（beginDrag/moveDrag/endDrag/cancelDrag、onLostPointerCapture、tabIndex、isDeadZone 的 pointer-events-none、`onClick={onMove ? undefined : ...}`）；不改 dayWindow/pct()/buildDayView；不改 CameraFollow/PlaybackCamera；不改 anchorLeft/anchorTop

### Wave 4

**Task 12 — README** → `fullstack-engineer`
- 回滾段：**Vercel Instant Rollback 單獨執行即安全**（舊程式碼 insert 不帶 category → default 生效；get_shared_trip 多回一鍵舊型別忽略）。**不需任何 DB 動作**
- 已知限制補兩條：既有停留點分類為「其他」需手改（無法回填）、住宿不套過夜預設時長

---

## 執行順序與衝突矩陣

```
Wave 0（立即）：Task 0（併入 plan6 修正輪） ‖ Task 1
   ↓ 等 plan6/*、plan5/task8-share、feat/japan-transit-fallback 全部合併
Wave 1：Task 2 ‖ Task 3
   ↓
Wave 2（七個全並行）：Task 4 ‖ 5 ‖ 7 ‖ 8 ‖ 9 ‖ 10 ‖ 11
   ↓
Wave 3：Task 6
   ↓
Wave 4：Task 12 + critic 全量審查 + 整合驗收
```

**Critical path**：Task 1 → 2 → 4 → 6 → critic → 整合（Task 4 與 6 同改 TripView.tsx，唯一無法壓縮的序列化點）

| 檔案 | 觸及任務 | 處置 |
|---|---|---|
| `TripView.tsx` | 2(型別)、4(寫入)、6(渲染)、11(一行) | 2→4→6 序列；11 併給 4 |
| `page.tsx` | 2 | 只由 Task 2 動，Task 7 不得碰 |
| `exportRows.ts` | 9 | 等 japan-transit 合併 |
| `Timeline.tsx` | 6 | 等 japan-transit 合併 |

---

## Done Criteria

- [ ] Task 0/2/10 的 migration 過 db-expert
- [ ] Task 3/6 視覺產出附截圖
- [ ] 每任務過 critic（2+4 併審、6+3 併審、8+9 併審，其餘單審）
- [ ] `npm test` / `npm run lint` / `npm run build` 全綠；E2E 三支無回歸
- [ ] R2 的 GRANT 反證測試實際執行過
- [ ] D5 不變量測試綠燈
- [ ] `grep -rn "primaryType\|\.types" src/app/ src/lib/domain/` 僅出現在 `PlaceSearch.tsx`、`PlacePreviewCard.tsx`、`placeCategory.ts` 三處（證明 Google raw 欄位未擴散）
- [ ] 已知債務入 README

## 明確不做（YAGNI，經論證）

- **自訂分類**：會把 check 約束變成關聯表，DB 複雜度翻倍
- **分類篩選器**：與「當日/他日」「Day 分頁」疊成三維狀態，組合爆炸且側欄與地圖需同步一致
- **分類統計圖表**：七行文字已滿足需求，圖表需引入套件（違反不新增依賴）
- **住宿過夜時長**：見 D6

---

## 校正註記（主控加註）

planner 報告中「`fix/playback-camera` diff 為空 → 已在 main，無衝突」的判讀**有誤**：該分支當時尚未 commit（agent 仍在實作中），diff 為空是因為分支頭還停在 main，不是因為改動已合併。`fix/playback-camera` 會改 `TripView.tsx` 的地圖區塊（PlaybackCamera + fitBounds + 邊緣閘門）與新增 error boundary，**與 Task 6 有實質衝突**，排程時須計入。
