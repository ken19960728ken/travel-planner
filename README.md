# travel-planner

把旅遊行程表從「表格」變成「時間 × 地圖」的行程規劃產品。在互動地圖上規劃行程，拖動時間軸看到自己什麼時間會在什麼地方、用什麼交通方式移動、要移動多久，並支援多人即時共同編輯。

## 核心功能（MVP）

- **地圖 × 時間軸行程編輯**：時間軸滑桿與地圖完全聯動，播放頭走到哪，地圖上的「我」就在哪
- **多人即時共編**：旅伴共同編輯同一份行程，改動即時同步
- **交通自動計算 + 手動修正**：相鄰停留點間自動計算大眾運輸／步行／開車路線與時間（Google Routes API），可手動修正時長／交通方式／航班起訖（手動內容絕不被自動計算覆蓋，僅標記「前後行程變動過」提示重新確認）；支援跨日航班段（出發／抵達分屬不同日期與時區）；交通時間與前後停留點銜接不上時，連接條與時間軸色塊變色警示（警示不阻擋編輯）
- **時間連鎖順延**：拖曳調整時間，後續行程自動順延；可鎖定時間點（🔒 不被其他停留點的連鎖順延波及——不論由誰觸發；自己直接拖曳仍會移動）並警示衝突
- **行程預覽動畫**：一鍵播放整趟行程——起播先收整日全景，推進到交通段時鏡頭**按該段距離自動換取景**（跨國航段拉遠、市區步行收近到街廓）；播放頭依交通方式顯示圖示（✈️ 沿大圓弧飛行並朝向行進方向、🚇🚶🚗 徽章），走過的路線以**紅線沿真實道路漸進繪出**，航段為紫色弧虛線；停留期間鏡頭定格不動
- **手繪交通路徑**：Google 算不出來（例如日本的電車）或算得不對時，可在地圖上自己點出轉折點描出實際走向——拖曳頂點調整、拖線段中央插入新點、手機也能畫。畫出來的路徑會取代自動路線出現在地圖、播放動畫與分享頁；JSON 匯出與定稿快照也會收錄（Excel 行程表不含路線資料）；隨時可「還原成自動路線」。這是你自己的資料，不受 Google 30 天快取限制，會永久保存
- **邀請旅伴與成員管理**：以邀請連結加入（editor／viewer 兩種角色），owner 可調整角色或移除成員；移除時一併撤銷該行程全部邀請連結
- **分享連結**：旅伴免註冊即可唯讀檢視；owner 可隨時重新產生連結使舊連結失效
- **地點分類**：交通站／景點／餐飲／住宿／購物／其他六類，依 Google 地點類型自動預填、可手動修改；地圖圖釘、時間軸、側欄與花費統計皆依分類配色與圖示
- **備選清單**：還沒決定日期的地點先存進備選庫，之後挑一天「拼入行程」
- **預估花費**：景點與交通的可留空花費欄位，含依分類拆分的總覽統計
- **匯出**：Excel 行程表（分日工作表）、JSON 完整資料；出發前可存「定稿快照」凍結計畫，為未來的「計畫 vs 實際」回憶功能預留資料

## 技術架構

| 層 | 選型 |
|----|------|
| 前端 | Next.js（TypeScript + React），部署於 Vercel |
| 後端 | Supabase（PostgreSQL + Auth + Realtime），Row Level Security 控權限 |
| 地圖與路線 | Google Maps JavaScript API + Places API + Routes API |
| 測試 | 核心邏輯純函式單元測試 + 整合測試 + Playwright E2E |

完整設計文件（含架構決策紀錄與 Google ToS 合規查證）見 [`docs/superpowers/specs/2026-07-30-travel-planner-design.md`](docs/superpowers/specs/2026-07-30-travel-planner-design.md)。

## 專案狀態

**MVP 功能全數完成並上線**（2026-08-04）。以下依實作順序記錄，各項皆已部署至正式環境：

| | 內容 |
|---|---|
| ✅ Plan 1 地基 | 帳號系統（Email + Google OAuth）、資料庫 schema + RLS、行程 CRUD |
| ✅ Plan 2 地圖 | 行程詳情頁、地點搜尋加入停留點（搜尋偏好綁定地圖視野）、地圖標記聯動與鏡頭跟隨、右鍵自訂停留點、停留點編輯與刪除 |
| ✅ Plan 3 時間軸 | Day 分頁、色塊拖曳含自動連鎖順延／🔒 鎖定／5 分鐘吸附、播放頭與地圖「我」標記、停留點時間全面改用當地時區顯示 |
| ✅ Plan 4 交通 | 相鄰停留點自動計算（Google Routes + route_cache 快取）、交通段編輯器（手動修正時長／交通方式、flight 跨日跨時區起訖、手動內容不被覆蓋）、銜接衝突警示 |
| ✅ Plan 5 共編分享匯出 | 邀請連結與成員角色管理、分享連結唯讀檢視（token 可重生成）、Excel／JSON 匯出、定稿快照、Realtime 即時共編 |
| ✅ Plan 6 備選庫 | 備選清單存取、選日期拼入行程 |
| ✅ Plan 7 地點分類 | 六類自動預填可修改、分類配色與圖示、依分類拆分的花費統計、分類驅動的預設停留時長 |
| ✅ 播放視覺 | 選中日路線圖層、分段取景、交通工具圖示播放頭、漸進紅線（分享頁同步生效） |
| ✅ 手繪交通路徑 | 地圖上自行點出轉折點（拖曳調整、線段中央插點、手機可用）；覆蓋自動路線且可還原；納入快照與匯出；未手繪的「無大眾運輸資料」段落改灰虛線誠實標示 |
| ✅ 參與人指派 | 每個停留點標記「誰會去」（成員＋可自由填寫的無帳號同行者）；交通段依各人的時間軸分別生成，分頭行動不再產生「沒有人走過」的交通段；同時段不同人不誤判為時間衝突；播放時各自一個圖示、同點合併；花費按實際參與者分攤；Excel 加「參與人」欄與「每人應付」小計 |

測試現況：單元／整合 369 項、Playwright E2E 9 條（含分享 token 外洩迴歸、Realtime 雙 context 同步、匿名攻擊防護、分頭行動分軌），皆綠。

**正式環境設定狀態**（2026-08-10）：GCP 兩把金鑰已收緊（瀏覽器金鑰限 referrer + Maps JavaScript API／Places API (New)；伺服器金鑰限 Routes API、依 Vercel 動態 IP 的限制不設應用程式限制），正式 Map ID 已透過 `NEXT_PUBLIC_GOOGLE_MAP_ID` 生效。**每日配額上限尚未設定**——目前沒有自動的用量硬上限，防線只有帳單預算警示（僅通知、不自動停用，且有數小時延遲）。設定步驟見 [`docs/guides/gcp-setup.md`](docs/guides/gcp-setup.md)。其餘取捨見「已知限制」。

## 開發

前置需求：nvm（Node 22+）、Docker Desktop、Supabase CLI（`brew install supabase/tap/supabase`）。

```bash
nvm use --lts
npm install
supabase start                 # 啟動本地 Supabase（首次會拉 Docker 映像）
cp .env.example .env.local     # 填入 supabase status 顯示的 URL 與 anon key
npm run dev                    # http://localhost:3000
npm test                       # 單元測試 + RLS 整合測試（需本地 Supabase）
npm run test:e2e               # Playwright E2E（需本地 Supabase 與 dev server 可用埠；缺 .env.test.local 時測試仍會跑，但資料清理會靜默跳過）
```

地圖功能需要 `.env.local` 補上 `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`；GCP 專案需啟用 Maps JavaScript API 與 Places API (New)，金鑰建議加上 referrer 與 API 限制。本地開發與 E2E 需把 `http://localhost:3000/*` 加入 Maps 金鑰的 HTTP referrer 允許清單，否則地圖會出現 RefererNotAllowedMapError，且 E2E 會紅在 `mapsErrors` 斷言（非程式碼問題）。

交通段自動計算（`/api/trips/[tripId]/legs/sync`）另需伺服器端環境變數（無 `NEXT_PUBLIC_` 前綴，不進 client bundle）：`GOOGLE_MAPS_SERVER_API_KEY` 為 GCP **另建**的「無 referrer 限制、API 限制為 Routes API」伺服器金鑰（瀏覽器金鑰不能共用於伺服器呼叫）；`SUPABASE_SERVICE_ROLE_KEY` 供 `route_cache` 讀寫使用，缺少時端點降級為跳過快取、不擋主流程。

本地 Google 登入需要專案根目錄 `.env`（`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`，見 `supabase/config.toml`），啟動 Supabase 前先 `set -a && source .env && set +a`。

節能提示：日常開發只需要四個核心容器，其餘可停——

```bash
docker stop supabase_studio_traval supabase_pg_meta_traval supabase_inbucket_traval \
  supabase_edge_runtime_traval supabase_analytics_traval supabase_vector_traval \
  supabase_storage_traval supabase_realtime_traval
# 收工時全部停掉：supabase stop
```

已知問題：本機 CLI 2.110.0 的 `supabase db reset` 會報 `LegacyDbBootstrapError`。替代做法（等效重建 schema）：

```bash
docker exec supabase_db_traval psql -U postgres -c \
  "drop schema public cascade; create schema public; grant usage on schema public to postgres, anon, authenticated, service_role; grant all on schema public to postgres;"
docker exec -i supabase_db_traval psql -U postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260730000000_init.sql
```

## 部署

正式環境為 Vercel（前端 + API routes）+ Supabase 雲端；一般流程是 migration 推上雲端後需在 Vercel 專案設定補上 `GOOGLE_MAPS_SERVER_API_KEY` 與 `SUPABASE_SERVICE_ROLE_KEY` 再重新部署。出事時的回滾路徑（Vercel Instant Rollback、Plan 4 以前的 migration 純新增免 down；Plan 5b 的 GRANT 收緊見下段、`stops_mark_manual_legs_stale` trigger 應急停用）見 [`docs/superpowers/plans/2026-07-31-travel-planner-transit.md`](docs/superpowers/plans/2026-07-31-travel-planner-transit.md) Task 10 Step 4。

### ⚠️ migration 與程式碼的部署順序：兩種相反的情況，必須先判斷是哪一種

**這條規則是 2026-08-03 線上故障後補的。** 當時新程式碼開始讀 `stops.category`，但那支 migration 漏推雲端 → 查詢整個失敗 → 使用者手機上看到「停留點讀取失敗」。錯在把「資料修正型」的順序規則誤套到「新增欄位型」上。

| 變更類型 | 正確順序 | 為什麼 |
|---|---|---|
| **新程式碼要讀新欄位／新表** | **migration 先，程式碼後** | 欄位不存在時查詢直接失敗，整頁功能掛掉 |
| **修正既有資料**（UPDATE 既有列） | **程式碼先，migration 後** | 順序反了的話，空窗期舊程式碼會把資料寫回錯的值（見下方 20260803000002 的例子） |
| 純新增表（舊碼零引用） | 任一順序皆可 | 舊程式碼看不到它 |

**每次 merge 後必做**：`supabase migration list --linked`，確認 local 與 remote 全部對齊。CI 沒有這道檢查，漏推不會有任何告警，只會在使用者打開頁面時炸。

**`supabase/migrations/20260803000002_transit_recompute.sql` 的部署順序與上述一般流程相反**：必須等 Vercel 完成本次功能部署（transit steps 三態偵測新邏輯上線）之後，才能對 Supabase 雲端執行這支 migration。新程式碼先上線本身無害——它沿用既有 TTL／`computed_at` 判準運作，不會誤寫任何資料；但若這支 migration 先套用、Vercel 還沒部署，這段空窗期只要有人開一次行程頁，仍在線上跑的舊版 sync 邏輯就會用舊 parse 邏輯把這批 `computed_at=null` 的段重算，寫回同樣錯誤的步行時長、新的 `computed_at`，並改寫 `departs_at`——導致 `moved` 判準永遠為 false、TTL 30 天在出發前不會到期，這批壞資料自此不會再被正確邏輯修正，且整個過程沒有任何告警（M-1，2026-08-01 複審）。

**回滾主路徑是 Vercel Instant Rollback，但這個「單獨執行即安全，不需要任何資料庫動作」的保證只涵蓋 `20260803000002_transit_recompute.sql` 之前的 migration**——舊版程式碼完全不寫 `trips`（只有 SELECT 與 INSERT）、也不碰 `trip_members` / `trip_invites`，與 `20260803000000` 之後的 schema 完全相容。`20260803000002_transit_recompute.sql` 是本專案第一支資料 migration（UPDATE 既有列，非純 DDL 新增），一旦套用過就不再滿足這個假設：若在它套用之後才對 Vercel 做 Instant Rollback，回滾回去的舊版程式碼一樣會在使用者開行程頁時把這批 `computed_at=null` 的段用舊 parse 邏輯重算、寫回相同的錯誤值，等於讓這次 migration 白做——因此只有確認新程式碼已穩定運作、不需要回滾時才執行這支 migration；一旦回滾，在重新部署新程式碼前不要再套用/重跑它。

只有在確認問題來自欄位級 GRANT 或邀請 RPC 本身時，才執行以下 SQL（純還原權限，不刪表、不刪資料）：

```sql
grant update on public.trips to authenticated;                                        -- 還原欄位收緊
revoke execute on function public.accept_trip_invite(uuid) from authenticated;        -- 應急停用邀請接受
revoke execute on function public.regenerate_share_token(uuid) from authenticated;    -- 應急停用分享 token 重生成
```

`trip_invites` 表、兩顆 RPC 與 `trip_members` policy 收緊**刻意不回滾**：它們對舊版程式碼完全透明，而 policy 收緊是已用 PoC 證實的帳號接管路徑的修復，回滾等於把漏洞放回去。

### 回滾路徑速查（依 migration 分類）

| 類別 | 對應 migration | 回滾方式 |
|---|---|---|
| 純新增表／函式／欄位 | 絕大多數 | **不需要動資料庫**，Vercel Instant Rollback 即可（舊碼看不到新物件） |
| 資料修正型（UPDATE 既有列） | `20260803000002_transit_recompute` | 見上段——套用後做 Instant Rollback 會讓修正白費，需重新部署新碼後再處理 |
| 權限收緊 | `20260803000000`（GRANT）、`20260803000001`（search_path） | 刻意不回滾（回滾＝把已證實的漏洞放回去）；真要應急停用見上方 SQL |
| **新程式碼依賴新權限** | `20260805000000_realtime_private_channel` | ⚠️ **回滾必須與程式碼同步**：policy 移除但 `private:true` 程式碼還在線上時，**合法成員也會被拒**，Realtime 全掛。單獨保留 policy 則對舊碼完全透明、無副作用 |

三支安全加固（`is_trip_member` 等四顆 helper 的 `pg_temp`、share RPC 白名單、Realtime policy）皆為純加固，**不列入任何回滾程序**。

## 系統鐵律

> 1. **共同編輯一律要求成員身分。** 匿名使用者若未來要能編輯，只能編輯不屬於任何帳號的獨立副本。
> 2. **任何授予未登入身分（`anon`）的函式，必須是唯讀的。**

第 1 條的措辭刻意留了「訪客先試玩、覺得好用再註冊」的空間：那不是共編，不該被這條規則誤傷。它由**兩套不同機制**分別守住，別把兩者混為一談：

| 面向 | 守門機制 | 覆蓋測試 |
|---|---|---|
| 未登入者不能寫 | 資料庫**授權層**（anon 對 public 零寫入 GRANT），前端拆光也擋得住 | `invariants.test.ts` |
| 已登入但**非成員**不能編輯 | **RLS policy**（`is_trip_member` / `is_trip_editor` / `is_trip_owner`） | `rls.test.ts` |

表級 GRANT 對所有 `authenticated` 一視同仁，區分成員與否的完全是 RLS。把「匿名不能寫」當成「編輯要成員身分」是偷換——而讓人以為某件事已經被機器守住，正是這一節存在要防的失敗模式。

第 2 條是**必要的補丁，不是補充**。表級授權擋不住 `SECURITY DEFINER` 函式——`get_shared_trip` 正是「anon 對九張表零權限、卻拿得到整份行程」的實例。少了這條，哪天有人為了方便寫一顆「訪客可留言」的匿名可寫函式，前面的零權限就全部白費。

**寫在文件裡的規則會被忘記，能被機器檢查的才叫鐵律。** 由 `src/lib/supabase/invariants.test.ts` 斷言（資料來源是 `public.role_privilege_audit()`，migration `20260812000000`）：

| 斷言 | 擋住什麼 | 強度 |
|---|---|---|
| 表級／欄位級寫入、表級讀取權限恆為空 | 有人給 anon 加 GRANT | **確定** |
| 函式清單與白名單**全等**（只有 `get_shared_trip`） | 新增或移除 anon 可執行的函式 | **確定** |
| 每顆函式的**定義雜湊**未變 | `create or replace` 原地改寫既有函式 | **確定** |
| **每張表都啟用 RLS** | 新增資料表漏開 RLS | **確定** |
| **沒有 policy 適用於 anon 或 public** | policy 忘了寫 `to authenticated` | **確定** |
| **public 無授予 anon 的 default privileges** | 未來新建物件又自動授權回去 | **確定** |
| 無 VOLATILE | 隨手加一顆匿名可寫函式 | 輔助訊號，可繞 |
| 定義裡無 DML 關鍵字 | 同上 | 輔助訊號，可繞 |

後兩項為何只是訊號：實測 STABLE 函式裡 `perform` 一顆 VOLATILE 函式，該函式的 `INSERT` **會成功寫入**（唯讀模式不沿呼叫鏈傳遞，而函式間的呼叫關係不進 `pg_depend`，這個遞移閉包沒有便宜的機檢法）。原始碼掃描則對 PG14+ 的 `begin atomic` 函式失明過一次——`prosrc` 是空字串——已改為 prosrc 為空時退回 `pg_get_functiondef`。**定義雜湊是唯一擋得住原地改寫的一項**，它紅了不要照抄新值蓋掉，先確認那顆函式為什麼被改、改完還是不是唯讀。

測試另含「偵測器沒瞎」的自證：稽核函式回傳掃描分母（掃了幾個關聯／欄位／函式），並拿 `authenticated` 當對照組（必須回非空）。少了這兩道，「anon 全空」與「查詢寫壞了」長得一模一樣——第一版差點就用了 `information_schema.role_table_grants`，那些 view 只列出「當前角色是授予者／被授予者／其成員」的權限，`service_role` 不是 anon 的成員，查出來永遠是空的。

### ⚠️ 2026-08-13：第一版驗錯了層

初版斷言只驗 GRANT，本機全綠。**實際到雲端跑同一顆稽核函式才發現本機與雲端的 anon 授權完全不同**：

| | 本機（`supabase start`） | 雲端（Supabase 託管） |
|---|---|---|
| anon 對 public 資料表 | 零授權 | **八張表 `arwdDxtm`（含 TRUNCATE）** |
| anon 可執行的函式 | 7 顆 | **17 顆**（含 `role_privilege_audit`） |
| public 的 default privileges | 0 筆 | **6 筆**（`postgres` 與 `supabase_admin` 各三種物件） |

成因是 Supabase 平台在 public schema 預設下了 `alter default privileges ... grant all to anon, authenticated, service_role`，本機 CLI 沒有複製。當時沒有可利用的洞（RLS 全開、34 條 policy 全部 `to authenticated`、寫入 RPC 都有 `is_trip_editor`），但**縱深防禦在雲端等於不存在**，而且更麻煩的是：

> 本專案的 RPC 慣例（`revoke execute … from public;` + `grant … to authenticated;`）在雲端**收不掉 anon**——anon 的 EXECUTE 是 default privileges 顯式授予的，不是靠 PUBLIC 繼承。所以每一顆照慣例寫的新 RPC，在雲端預設都是匿名可呼叫的。

`20260813000000_anon_grant_lockdown.sql` 收回 anon 在 public 的全部表／序列／函式授權（只留 `get_shared_trip`）、移除 default privileges 中 anon 的部分，並把斷言擴充到實際防線。**新增 RPC 時仍建議寫成 `revoke execute … from public, anon;`**，把這件事釘在 migration 本身而不是只靠事後稽核。

**殘留（已知、可接受）**：六筆 default privileges 裡有三筆的授予者是 `supabase_admin`，`postgres` 無權修改（本機以等價情境實測確認會 `insufficient_privilege`）。migration 的 DO 區塊逐筆嘗試、失敗只發 warning 不中止。影響有限——我們的 migration 都以 `postgres` 身分執行，套用的是 `postgres` 的 default privileges，那三筆只對「平台自己建立的物件」生效。雲端跑稽核時 `default_privileges` 若非空即為此。

**範圍限制（不是小字）**：只掃 `public` schema。anon 在 `realtime.messages` 上仍**持有**表級 INSERT/UPDATE，只是被該表 `to authenticated` 的 policy 擋著；`storage` 與 `supabase_functions` 亦然，且它們的 default privileges 動不了。所以這組斷言證明的是「anon 在 public 只能讀」，不是「anon 在整個資料庫只能讀」。啟用 storage 的那一刻就要另開一條斷言。

**目前沒有 CI 會跑它。** 本機沒起 Supabase 時整組靜默跳過並回報成功，實際強度是「開發者記得先 `supabase start`」。測試裡放了一條不可跳過的守門（`process.env.CI` 時要求環境齊備），接上 CI 就會生效。

部署後要複查雲端，在 Supabase SQL Editor 執行同一份判準：

```sql
select public.role_privilege_audit();               -- anon：四個陣列除 functions 外皆須為空
select public.role_privilege_audit('authenticated'); -- 對照組：必須回非空
```

**鐵律不解決分享連結的撤銷問題**——兩者正交。鐵律管「能不能寫」，分享連結的麻煩是「讀的權限收不回來」。相關討論見 [`docs/superpowers/specs/2026-08-01-sharing-access-model-notes.md`](docs/superpowers/specs/2026-08-01-sharing-access-model-notes.md)。

## 已知限制

- 地圖 `mapId` 未設定 `NEXT_PUBLIC_GOOGLE_MAP_ID` 時 fallback 為開發用 `DEMO_MAP_ID`（Google 明載不可用於正式環境、不支援 Cloud Styling）。建立正式 Map ID 與收緊金鑰的完整步驟見 [`docs/guides/gcp-setup.md`](docs/guides/gcp-setup.md)
- 播放中的鏡頭行為是「分段定格」：起播 fitBounds 收整日全景一次，之後只在**進入交通段**時換一次取景
  （以該段完整路徑 fitBounds，步行段縮放上限 16、其餘 15），停留期間不動；換段為瞬間切換（刻意不做
  連續縮放動畫——跨多層圖磚的過渡正是灰塊問題的溫床），慢速網路下換段瞬間可能短暫露出未載入圖磚，
  1-2 秒內補齊。「我」標記跑出可視範圍時的 panTo 追上仍為安全網。同一 session（未從頭重播、未切
  Day）暫停後恢復不會重新收整日全景，鏡頭留在暫停當下的位置；播放頭 wrap 回起點重播或切換 Day
  才會重新收一次全景
- 播放頭的交通圖示只有 ✈️（SVG）會旋轉朝向行進方向；🚇🚶🚗 為不旋轉的徽章、custom 段維持橘點。
  無 polyline 者（flight／manual／無資料的 transit）位置與紅線退回兩點直線，靜態路線亦以弧虛線呈現。
  漸進紅線的存續綁定「播放頭是否有值」而非「是否正在播放」：暫停與拖曳時間軸播放頭時紅線保留，
  切換 Day（播放頭歸零）才清除
- 時間軸拖曳僅支援整塊平移（時長調整請透過停留點編輯器）
- 跨午夜停留點僅顯示於開始日
- 步行路線為 Google Beta 功能，可能缺乏人行道資訊
- Google Routes API 不支援日本（及印度鐵路）的大眾運輸；TRANSIT 查詢在這類地區（或任何無合適大眾運輸路線的短程）會顯示「無大眾運輸資料」，並保留 Google 回傳的步行時間估算供參考，可手動修正。**這種情況下 Google 回的是一條純步行路線**——地圖上會以**灰色虛線**呈現以示區別（不是實際搭乘路線），可用「畫路徑」自行描出正確走向
- 刪除停留點會連帶刪除其相鄰交通段（FK cascade），含手動填寫的 manual／flight 段——重要班次資訊請留意
- 跨夜交通段顯示歸屬出發日，隔日視角不顯示延續
- 路線代理限流為單機（模組層記憶體）實作，serverless 多實例部署下護欄效果弱化；商用前需換集中式限流（Upstash／DB）
- 交通段轉乘細節（detail）本版未取用
- **同一對停留點之間只能有一段交通**（DB 唯一約束）。兩組人從 A 到 B 走不同交通方式（一個搭電車、一個走路）無法分別記錄——變通做法是在中間插一個停留點。分頭「去不同地方」不受此限，那是不同的配對
- 參與人上限 20 人；輔助色只有 4 色循環，識別主體是名字的**第一個字**（既有 19 個保留色已佔滿紅藍紫橘粉，八色色盤實測最小 ΔE 僅 20.6 且最佳解是四個綠色系，硬撐會得到數字合格卻沒人分得出誰是誰的配色）。兩個人首字相同時靠 hover 與側欄名單區分
- 停留點的參與人**無法表達「沒有人去」**：未指派＝全員，且 DB 禁止空陣列。移除某人時，只剩他一個人的停留點會回到「全員」（移除前 UI 會提示受影響的停留點數）
- 分帳金額以整數分攤（餘數按參與人 id 字典序分配），非整數的預估花費會先四捨五入；JPY／TWD 無小數，實務上不受影響
- 「已脫離順序」的交通段若前後停留點的參與人沒有交集，該筆花費算給全員（Excel 的參與人欄標示「全員（無交集）」）——不算給任何人會讓「每人應付加總 ≠ 總計」，帳面對不起來
- 有小數金額時，「總計」（原始加總）與「每人應付」的加總基準可能差幾分。分攤一律在最小單位上做整數運算（全整數金額用「元」、有小數才切到 1/100），不一致時花費面板會另外標出「分帳基準」那一列
- **參與人名冊面板不受 Realtime 斷線閘門管轄**：斷線橫幅寫著「編輯功能已暫停」時，名冊仍可新增／改名／移除，而移除會連帶改寫多個停留點的指派。這與成員面板是同一個結構性豁免（兩者都掛在 server component 的頁首、拿不到 TripView 的連線狀態），但參與人的寫入會動到 `stops`，風險等級不同
- 分頭行動會放大 Google Routes 的計費呼叫量（新增一位參與人可能一次觸發數百次路線計算）。交通段的同步上限獨立於停留點上限（2000 段），超過會回 413 並停止同步
- 「後續」的判定用「開始時間晚於錨點編輯前的開始時間」。**巢狀在錨點區間內的行程也會被算成後續**——例如一日包車 09:00–17:00 內有一場 12:00 的午餐，延長包車結束時間會連午餐一起推遲。時間軸拖曳有同樣的判定
- 側欄的順延詢問沒有時限。按下確認時若後續行程的組成已經改變（協作者增刪、同一次儲存也改了參與人指派），RPC 會以 40001 整筆退回並要求重新整理，不會照著過期的數字動手
- 移除一位參與人會更新所有指派過他的停留點，連帶推進那些列的 `updated_at`——正在拖曳其中某個停留點的協作者會收到「已被其他操作變更」而不知道原因
- 停留點與 flight／custom 段的起訖若落在時區的日光節約時間（DST）邊界、剛好是當地「不存在的時刻」（例如春進時鐘跳過的那一小時）或「重複的時刻」（秋回撥回的那一小時），底層 `date-fns-tz` 會靜默位移／擇一，**且重複時刻擇哪一次取決於使用者裝置的系統時區**——同一停留點被不同時區的協作者開啟＋儲存，可能靜默位移 1 小時且畫面上看不出差異。測試僅鎖定「不拋錯、必為合法時刻之一」，未鎖定具體值（本產品時區主場景東亞無 DST，不做顯式拒絕）
- 脫離行程順序的交通段收在側欄專屬區塊（資料保留、可刪除）；恢復相鄰後保留為手動段，可一鍵改回自動計算（花費將清除）
- Realtime 上線後，他人的變更只會觸發你這端的畫面刷新（router.refresh 整份重抓），不會再觸發你這端的交通段同步——同步的觸發者永遠是編輯者本人；殘留窗口僅剩多位協作者「同時開啟」同一行程時各自的掛載同步，快取命中與資料庫 unique 約束衝突的靜默略過吸收了多數重複
- Realtime 共編（變更訂閱 + presence + 斷線橫幅）目前走 Supabase `postgres_changes`：每個訂閱者逐一做授權檢查，經驗門檻約數千（~3000）併發訂閱者時會成為效能瓶頸；商用前需遷移至官方建議的 Broadcast from Database。viewer 與分享頁（免登入）不掛訂閱，變更需手動重新整理才看得到
- 備選庫（`trip_candidates`）不在 Realtime 訂閱範圍：旅伴增刪備選時，其他人不會自動收到更新，需重新整理才看得到
- 斷線（Realtime 連線中斷）時顯示橫幅並暫停所有寫入入口（新增停留點、拖曳移動時間、停留點/交通段編輯器與刪除鈕、備選面板的增刪改），重連後自動清除橫幅並整份重新整理（2026-08-04 critic 審查 M-3 訂正：先前版本只擋「新增」類寫入，「刪除旁人剛建立的點」「覆寫旁人剛改的時間」等破壞性更高的操作在斷線期間仍可送出，已補齊）
- 邀請連結（`trip_invites`）多次可用直到過期（預設 7 天、上限 30 天）或 owner 手動撤銷；owner 移除成員時會一併撤銷**該行程全部**邀請連結（Task 7 根治——曾嘗試只鎖「被移除者最近一次用來加入的那條」，但邀請連結本無 email 收件人、可被多人重複使用，PoC 證實這種精準追蹤會 fail-open：連結一旦被別人用過，追蹤即失效，被移除者仍能用手上舊連結重新加入；改採全部撤銷才是不會 fail-open 的根治）；owner 需重新產生連結給還沒加入的其他受邀者
- 邀請接受頁（`/invite/[token]`）未登入時導向登入頁並帶 `next` 參數，登入（含 Email/密碼與 Google OAuth）後自動回跳這個邀請頁；`next` 僅接受站內相對路徑白名單（`/` 開頭且非 `//` 開頭），login 頁與 `/auth/callback` 各自驗證一次，不信任跨請求傳遞的值
- 成員面板（header「成員」鈕）為簡易下拉區塊，尚未支援點擊外部自動收合
- 分享頁的交通段若尚未計算或已逾期，只會顯示「待計算」——匿名訪客不會觸發 Google 路線同步（成本與濫用防線），需任一 editor 開啟過該行程才會更新
- 分享連結沒有流量限制：主防線是 token 為 UUID v4（122 bit 隨機、不可枚舉），但拿到單一 token 後可無限次讀取。商用前需與路線代理同批上集中式限流
- 分享／邀請 token 位於網址路徑，會進入 Vercel access log 與瀏覽器歷史紀錄；頁面已設 `no-referrer` 阻斷外站 Referer 外洩，且 token 可隨時重新產生或撤銷。商用前可評估改為 POST + 短效兌換碼
- **成員自行退出時不會使分享連結失效**：owner 移除成員會一併重新產生 `share_token`（舊連結立刻失效），但成員按「退出行程」只刪自己的成員資格，手上那條唯讀分享連結仍可讀整份行程。`regenerate_share_token` 是 owner-only，離開者無從自清——owner 需手動按一次「重新產生連結」
- 尚未支援轉移擁有權：owner 不可被移除、也無法把成員升為 owner（角色白名單只有 editor／viewer，這同時擋住提權）；owner 若刪除帳號，該行程會變成無人可管理的狀態
