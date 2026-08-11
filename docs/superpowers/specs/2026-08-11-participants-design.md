# 參與人指派 — 設計文件

- 日期：2026-08-11
- 狀態：設計已與需求方逐題確認，待排實作計畫
- 前置：`docs/superpowers/specs/2026-08-10-manual-route-path-design.md` §10（本功能的問題來源）

---

## 1. 問題

一趟行程裡不是所有人都跟著同一條路線走。有共同行程，也有分頭行動——今天上午一起去太宰府，下午兩個人去博多逛街、一個人去看棒球，晚上再會合吃飯。需求方要的是「知道誰去了什麼地方」，以及隨之而來的分帳。

**分頭行動今天不是「沒支援」，是會產生錯誤的資料與畫面。** 三處都寫死了「整趟行程只有一條時間軸」的假設：

| 位置 | 現行行為 | 分頭時的後果 |
|---|---|---|
| `src/lib/domain/legSync.ts:24-30` | 全行程按 `startsAt` 排序後取**相鄰配對**生成交通段 | A(9-10)、B(11-12,甲)、C(11-12,乙) 會生出 **B→C** 這條沒有人走過的幻影交通段，而真正存在的 **A→C 永遠不會被建立** |
| `src/lib/domain/conflicts.ts:21` | 時間重疊的停留點一律報 `overlap` 警告 | 分頭時段必然重疊，整片紅色警告，而那不是錯誤 |
| `src/lib/domain/interpolate.ts:15-19` | 播放遇到重疊「取開始最早者」 | 另一條分支在播放中直接消失，沒有任何提示 |

第一項是這個設計最該優先修掉的：地圖上出現一條看起來合理、實際上錯誤的線。這正是 2026-08-10 手繪路徑要解決的同一類缺陷（日本電車段畫的其實是步行路徑），不該再造一個。

**訂正一則早先的判斷**：曾認為阻礙是「一對停留點只能有一段交通」（`legs_from_to_unique`，`supabase/migrations/20260802000000_legs_transit.sql:20`）。這是錯的——fork 產生的 A→B 與 A→C 是兩組不同配對，該約束擋不到。它只擋「同兩點之間兩組人用不同交通方式」，屬次要情境，本設計不處理（見 §12）。

## 2. 已確認的決策

| 題目 | 決定 |
|---|---|
| 參與人身分 | 已加入的成員 **＋** 可自由填寫的無帳號同行者 |
| 範圍 | **完整分軌**——每個參與人有自己的線性時間軸，播放／衝突／花費／匯出全部按人分 |
| 指派粒度 | 停留點指派；**交通段的參與人由前後兩個停留點的交集自動推導**，不獨立儲存 |
| 播放 | 預設所有人同時跑，分頭時分成多個圖示；另可切「只看某人」聚焦 |
| 花費 | 按**實際參與者**分攤（每筆金額 ÷ 該項目參與人數），取代現行的全員均分 |
| Excel | 停留點與交通列各加一欄「參與人」，表尾在總計下方加「每人應付」小計 |
| 資料模型 | 全部放進既有表：`trips.participants` jsonb ＋ `stops.participant_ids` uuid[] |

交通段自動推導的理由：若允許獨立指派，會產生「某人搭車到 B、但 B 的參與人沒有他」這類矛盾資料，而播放與花費都建立在這份資料上，錯了會一路錯下去。推導則結構上不可能矛盾，也不需要多一張表、不需要動 `legs_from_to_unique`。

## 3. 資料模型

### 3.1 `trips.participants` jsonb（名冊）

預設 `'[]'::jsonb`。

```json
[
  { "id": "8f3c…", "user_id": "a41d…", "name": "小明", "color": "#e11d48" },
  { "id": "b902…", "user_id": null,     "name": "阿姨", "color": "#0369a1" }
]
```

- `id` — 行程內唯一的 uuid，由 client 產生。停留點的 `participant_ids` 指向它。
- `user_id` — 對應 `trip_members.user_id`；無帳號同行者為 `null`。
- `name` — 顯示名稱。**成員也照存名字**：`trip_members` 沒有 display_name 欄位（`supabase/migrations/20260730000000_init.sql:47-53`），而且成員退出行程後，名字仍該留在歷史紀錄裡。
- `color` — 播放圖示與軌跡線的顏色，見 §5.3。

約束比照 `legs_custom_path_shape`（`20260810000000_legs_custom_path.sql:48-57`）的雙重上限教訓——只限元素個數擋不住「20 個元素、每個 1MB」：

```sql
alter table public.trips add constraint trips_participants_shape check (
  jsonb_typeof(participants) = 'array'
  and jsonb_array_length(participants) <= 20
  and length(participants::text) <= 4000
);
```

⚠️ **授權**：`trips` 已收緊成欄位級授權（`20260803000000_invites_and_grants.sql:83`：`grant update (title, start_date, end_date, currency) on public.trips to authenticated`）。新欄位**必須顯式加進這份清單**，否則寫入被拒。這與 `legs`／`stops` 的表級授權（新欄位自動繼承，見 `20260803000004_stop_category.sql:10`）不同，是本設計最容易漏掉的一步。

### 3.2 `stops.participant_ids` uuid[]（指派）

```sql
alter table public.stops add column participant_ids uuid[];
alter table public.stops add constraint stops_participant_ids_shape check (
  participant_ids is null or array_length(participant_ids, 1) between 1 and 20
);
```

**`null` = 全員，且 DB 禁止空陣列。** 一種語義只有一種表示，不留「`null` 和 `[]` 誰是誰」的模糊地帶——這類雙重表示在下游每個消費端都要各自判斷一次，遲早有人漏掉一邊。

既有的九州行程所有停留點都是 `null`，行為完全不變，這也是選擇「未指派 = 全員」而非「未指派 = 無人」的原因。

`stops` 是表級授權，新欄位自動繼承 INSERT/UPDATE/SELECT，不需 column grant。

### 3.3 移除參與人的清掃

名冊移除某人後，`participant_ids` 不能還指著他。必須是單一 RPC（一個交易）：

```sql
create function public.remove_trip_participant(p_trip_id uuid, p_participant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- ⚠️ SECURITY DEFINER 繞過 RLS，權限檢查必須自己做，否則任何登入者都能改任何行程的名冊
  if not public.is_trip_editor(p_trip_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.stops
     set participant_ids = nullif(array_remove(participant_ids, p_participant_id), '{}')
   where trip_id = p_trip_id and participant_ids @> array[p_participant_id];

  update public.trips
     set participants = (
       select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(participants) e
        where e->>'id' <> p_participant_id::text)
   where id = p_trip_id;
end;
$$;

revoke execute on function public.remove_trip_participant(uuid, uuid) from public;
grant execute on function public.remove_trip_participant(uuid, uuid) to authenticated;
```

權限守衛不可省：`security definer` 的用意只是讓兩個 UPDATE 在同一交易內繞過 RLS 逐列判定，不是放行給所有人。少了 `is_trip_editor` 這一行，任何登入者都能清空別人行程的名冊。

`nullif(…, '{}')` 是關鍵：最後一個參與人被移除時，該停留點回到 `null`（全員），而不是產生會被 constraint 擋下的空陣列讓整個交易失敗。

這個轉換有語義後果——「只有甲會去」的停留點在甲被移除後變成「全員都去」。這是「無法表達 0 人」的必然結果，比留下一個沒人參加的孤兒停留點好。UI 在移除前必須提示受影響的停留點數量。

### 3.4 唯一的解讀入口

`null` = 全員、未知 id 要忽略、全部無效視同全員——這些規則有五個消費端（sync、衝突偵測、播放、花費、匯出）。**不能讓每個消費端各寫一次**，那是五份會各自漂移的邏輯。比照手繪路徑的 `parseCustomPath`（`src/lib/domain/routePath.ts`），全部收斂到一個純函式：

```ts
/** 解讀停留點的參與人：null → 全員；過濾掉名冊裡沒有的 id；過濾後為空 → 全員。
 *  回傳一定是 roster 的子集且長度 >= 1（roster 本身為空時回傳空陣列）。 */
export function resolveStopParticipants(
  participantIds: readonly string[] | null | undefined,
  roster: readonly string[],
): string[]
```

`stops.participant_ids` 在應用層型別宣告為 `unknown`——資料來自 DB／RPC，形狀不可信，強迫所有消費端必須先過這個函式。這是 `Leg.custom_path` 用過同一招的理由。

「過濾後為空 → 全員」這條的必要性：若某停留點的 id 全部指向已不存在的參與人，不套用這條規則的話，該停留點不會出現在**任何人**的鏈上，於是它前後的交通段全部消失，而畫面上看不出原因。

### 3.5 為何不用關聯表

評估過三個方案，選最不正規化的那個：

| | A（採用） | B 兩張新表 | C 名冊正規化 |
|---|---|---|---|
| 新增表 | 0 | 2 | 1 |
| 新增 realtime 訂閱 | 0 | 2 | 1 |
| 外鍵完整性 | 無（靠 §3.3 RPC） | 完整 | 名冊有 |
| 停留點狀態的原子性 | 單列樂觀鎖沿用 | **拆成兩張表兩次寫入** | 沿用 |

決定性因素是最後一列。Realtime 目前只訂閱 `stops`／`legs`／`trips` 三張表（`src/app/trips/[tripId]/TripRealtime.tsx:137-155`），而整個共編的衝突處理建立在單列 `updated_at` 樂觀鎖上。B 會讓「改時間」與「改參與人」變成兩次非原子寫入，拖曳停留點的同時有人改參與人就會撕裂。

參與人是每個行程各自一份、數量很小（上限 20）、永遠跟著行程一起讀、不會單獨查詢——正是該內嵌的形狀。代價（無外鍵）由 §3.3 的 RPC 承擔，並在 §10 列為殘留風險。

## 4. 分軌演算法

### 4.1 交通段生成

`legSync.ts:24-30` 的 `adjacentPairs` 之上加一層：

```ts
/** 每個參與人各自的相鄰配對，聯集去重。
 *  未指派（participantIds 為 null）的停留點屬於全員，出現在每個人的鏈上。 */
export function participantPairs<T extends { id: string; startsAt: number; participantIds: string[] | null }>(
  stops: T[],
  participantIds: string[],
): Array<[T, T]>
```

對每個參與人，filter 出「`resolveStopParticipants(stop, roster)` 包含他」的停留點（§3.4，null 與無效 id 的處理全在那裡），餵給現有的 `adjacentPairs`，最後以 `from→to` 去重。

`planLegSync` 只換 `wanted` 的來源（`legSync.ts:37`），其餘 detachAuto／removeAuto／markStale／recompute 的判準**一字不改**。

必須以測試鎖住的兩個性質：

- **純 fork**：A(9-10)、B(11-12,甲)、C(11-12,乙) → 產生 `A→B`、`A→C`，**不產生** `B→C`。
- **全員同行**：所有停留點 `participant_ids` 為 `null` 時，聯集去重後的結果與現行 `adjacentPairs` **逐項相等**。既有行程零變化，這是最重要的回歸防線。

沒有參與人名冊（`participants` 為空陣列）時，等同單一虛擬參與人，退回現行行為。

### 4.2 既有資料的遷移風險

若某個現存行程恰好有時間重疊的停留點，舊演算法生成的幻影交通段在第一次 sync 時會被判為「脫離配對」。現行規則（`legSync.ts:43-49`）已經涵蓋這個情境：

- `source='auto'` 且無花費 → 刪除（純 Google 衍生資料，可重算）
- `source='auto'` 且**有花費** → 轉存 `manual`（`detachAuto`）——花費是使用者資料，不能無聲刪除
- `source='manual'` → 標 `stale`，絕不覆蓋或刪除

**使用者填過的資料一筆都不會被靜默丟掉。** 這是本功能唯一會動到現有資料的地方，實作時需在 E2E 覆蓋「重疊停留點 → sync → 有花費的幻影段轉成 manual 而非消失」。

### 4.3 衝突偵測

`conflicts.ts` 改成按人分組後各自跑現有 `detectConflicts`，結果以 `(type, stopIds)` 去重後聯集。

- **同一個人**時間重疊 → 真衝突，照報 `overlap`
- **不同人**時間重疊 → 分頭行動，不報
- `transit_too_tight` 同理，在各自的鏈內判定

## 5. 播放

### 5.1 多軌播放

現行播放管線（`TripView.tsx`）是單軌：`posStops`(L865) → `interpolatePosition`(L874) / `segmentAt`(L878) → `travelPath`(L887) → `travelPos`(L894) → `completedPaths`(L922) → `PlaybackTrail`(L1444)。

改法是把 L865–L940 這段整體提成「對每個參與人算一次」的 map，`interpolate.ts`、`resolveRoutePath`、`PlaybackTrail` 本身都不必改——它們接收的都是已經 filter 過的停留點陣列。

單人模式是同一套邏輯只跑一個參與人，幾乎零額外成本。

### 5.2 圖示合併

大部分時間全員在同一點，N 個圖示會完全重疊。合併規則：

- 以四捨五入到小數 5 位（約 1 公尺）的座標分組
- 每組渲染一個圖示；組內人數 > 1 時，圖示顯示人數，顏色用中性色
- 組內人數 = 1 時，用該參與人的顏色

軌跡線（`PlaybackTrail`）不合併——重疊時本來就疊在一起，視覺上無差別，而分岔時必須各自可見。

### 5.3 顏色

`categoryUi.ts:18-44` 已有嚴格規約：六個分類桶 + 五個交通模式色 + 選取／草稿針做過全配對 CIE ΔE 掃描，最小 ΔE 30.0。**參與人色盤必須加進同一次掃描重跑**，不能自己挑顏色。度量用 ΔE，不用 WCAG 對比度（該檔 L36-39 說明了原因）。

誠實的上限：色盤提供 8 色。超過 8 人時循環使用，顏色不再是唯一識別，此時圖例（名字對顏色）是必要的，不是裝飾。實務上分頭行動很少超過 4 組。

### 5.4 相機

- **全部模式**：`fitBounds` 涵蓋所有播放頭，分頭時自動拉遠、會合時自動拉近
- **單人模式**：沿用現行 `CameraFollow`（`TripView.tsx:113-119`）

## 6. 花費

`cost.ts:13-16` 的 `perPersonCost`（總額 ÷ 人數）有測試但**沒有任何 UI 消費端**——當初寫了沒接上。本功能取代它。

```ts
/** 每筆花費只分攤給該項目的參與人；participantIds 為 null 視為全員。
 *  回傳 participantId → 應付金額。 */
export function costByParticipant(
  items: ReadonlyArray<{ estimatedCost: number | null; participantIds: string[] | null }>,
  allParticipantIds: readonly string[],
): Record<string, number>
```

交通段的 `participantIds` 依 §2 由前後停留點的交集推導後傳入。

**整數分攤，不用浮點除法。** 每筆金額先 `Math.round`，`base = Math.floor(cost / n)`，餘數 `cost - base * n` 按 participant id 字典序分給前幾人各 +1。

不變量（以隨機組合測試鎖住，比照 `cost.test.ts` 對 `costByCategory` 的做法）：

```
sum(每人應付) === totalEstimatedCost(全部項目)
```

浮點除法做不到嚴格相等（1000 ÷ 3 加回來不是 1000），而這是要拿去分帳的數字。JPY／TWD 都是整數貨幣，`Math.round` 是合理簡化，列入 §10 殘留風險。

## 7. 匯出、快照、分享

### 7.1 Excel

`exportRows.ts:32-37` 的 `ItineraryRow` union：

- `stop` 與 `leg` 兩種列各加 `participants: string` — 名字逗號分隔；全員時輸出「全員」而非列出所有名字
- 新增列別 `{ kind: 'participantTotal'; name: string; cost: number }`，排在 `total` 之後
- 不變量：`sum(participantTotal) === total`

### 7.2 JSON 匯出與定稿快照

參與人是使用者資料，不受 Google 30 天 TTL 限制，**永久收錄**——與 `custom_path` 同一類（`snapshot.ts:12-15` 已為此寫下例外條款，本功能沿用同一段推理）。

- `trip.participants` — 名冊全部收錄（`user_id` 除外，見 §9）
- `stops[].participant_ids` — 收錄

### 7.3 分享頁

`get_shared_trip` 的欄位白名單要加：

- trip 層：`participants`
- stop 層：`participant_ids`

`src/lib/supabase/share.test.ts` 的 `TRIP_KEYS`(L20) 與 `STOP_KEYS`(L21-24) 必須同步更新——`jsonb_build_object` 即使值為 null 仍產生鍵，不加就紅燈（該檔 L28-31 已記錄此規則）。那組 `Object.keys().sort()` 全等斷言是白名單的唯一自動守門。

## 8. UI

| 位置 | 改動 |
|---|---|
| `MembersPanel.tsx` | 新增「參與人」區塊：列出名冊，可新增（從成員挑 or 直接打名字）、改名、換色、移除。移除時提示受影響的停留點數 |
| `StopEditor.tsx` | 參與人多選；預設「全員」（`null`）。清空到 0 人時 UI 擋下並提示 |
| `TripView.tsx` 側欄 | 停留點列顯示參與人色點；全員時不顯示（避免每一列都掛滿圖示） |
| 播放列 | 「看誰的行程」下拉：全部 ／ 個別參與人 |
| `CostSummary.tsx` | 總計下方列出每人應付 |
| 地圖 | 播放圖示依 §5.2 合併，圖例顯示名字對顏色 |

分頭時段在 Timeline 上需要可辨識——同一時段有多個色塊並列，而不是被判為衝突的紅色。

## 9. 安全與隱私

⚠️ **`user_id` 不得出現在分享頁。** `participants` 內含 `user_id`（`auth.users` 的 UUID），而分享頁對匿名訪客開放。`get_shared_trip` 必須**逐鍵投影**掉它，只回 `id`／`name`／`color`：

```sql
'participants', coalesce((select jsonb_agg(jsonb_build_object(
    'id', e->>'id', 'name', e->>'name', 'color', e->>'color'))
  from jsonb_array_elements(t.participants) e), '[]'::jsonb)
```

不能直接 `'participants', t.participants` 整包吐出。這一點要在 `share.test.ts` 加斷言鎖住：分享頁回傳的每個 participant 物件鍵集合恰等於 `['color','id','name']`。

同理，JSON 匯出（使用者自己下載自己的行程）可以含 `user_id`，但既然下游沒有任何消費端需要它，一併排除，減少外洩面。

其餘：名冊的寫入權限由 `trips` 的既有 RLS policy（editor 以上）涵蓋，不需新 policy。

## 10. 邊界情況與殘留風險

| 情況 | 處理 |
|---|---|
| 名冊為空 | 等同單一虛擬參與人，全部退回現行單軌行為 |
| 停留點只剩一個參與人而該人被移除 | 回到 `null`（全員），見 §3.3。UI 事前提示 |
| 超過 8 人 | 顏色循環，靠圖例區分。不阻止 |
| `participant_ids` 指向不存在的 id | 無外鍵保證。由 §3.4 的 `resolveStopParticipants` 統一處理：忽略未知 id，全部無效則視同全員 |
| 非整數金額 | `Math.round` 後分攤。JPY/TWD 無小數，可接受 |
| 同兩點之間兩組人搭不同交通工具 | **不支援**（`legs_from_to_unique`）。變通：中間插一個停留點 |
| 舊 client 讀到新欄位 | 多餘的鍵被忽略，無害 |

## 11. 部署順序

屬「新程式碼要讀新欄位」——**migration 先推雲端，Vercel 程式碼後部署**（README 的順序表）。

正向（migration 先）：新增欄位對舊程式碼透明，`get_shared_trip` 多回兩個鍵不會讓舊 client 出錯。
反向（程式碼先）：`page.tsx` 的 select 指名不存在的欄位 → 查詢整個失敗 → 行程頁「停留點讀取失敗」。本專案 2026-08-03 已因搞反此順序造成線上故障（`stops.category`）。

回滾：移除欄位前必須先回滾 `get_shared_trip`（函式本體引用 `t.participants`，欄位不存在時分享頁全面失效）。

## 12. 不在本設計範圍

- **同一對停留點多段交通**（兩組人搭不同工具）。需放寬 `legs_from_to_unique`，並讓 sync、衝突偵測、手繪路徑全部支援同一配對多段——屬另一個層級的改動，且有「中間插停留點」的變通。
- **實際支出記帳**（誰先付、誰欠誰）。本設計只處理「預估花費該算在誰頭上」，不做結算。
- **依參與人過濾備選景點**。
