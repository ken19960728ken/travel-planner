# travel-planner

把旅遊行程表從「表格」變成「時間 × 地圖」的行程規劃產品。在互動地圖上規劃行程，拖動時間軸看到自己什麼時間會在什麼地方、用什麼交通方式移動、要移動多久，並支援多人即時共同編輯。

## 核心功能（MVP）

- **地圖 × 時間軸行程編輯**：時間軸滑桿與地圖完全聯動，播放頭走到哪，地圖上的「我」就在哪
- **多人即時共編**：旅伴共同編輯同一份行程，改動即時同步
- **交通自動計算 + 手動修正**：相鄰停留點間自動計算大眾運輸／步行／開車路線與時間（Google Routes API），可手動修正時長／交通方式／航班起訖（手動內容絕不被自動計算覆蓋，僅標記「前後行程變動過」提示重新確認）；支援跨日航班段（出發／抵達分屬不同日期與時區）；交通時間與前後停留點銜接不上時，連接條與時間軸色塊變色警示（警示不阻擋編輯）
- **時間連鎖順延**：中途插入景點，後續行程自動順延；可鎖定時間點（🔒 不被他人的連鎖順延波及；自己直接拖曳仍會移動）並警示衝突
- **行程預覽動畫**：一鍵播放整趟行程，起播時鏡頭自動收整段路線入鏡（定格全景），「我」標記在畫面內移動；只有標記跑出可視範圍（跨距過大或手動平移過鏡頭）時鏡頭才會微調追上
- **分享連結**：旅伴免註冊即可唯讀檢視
- **預估花費**：景點與交通的可留空花費欄位，含總覽統計
- **定稿快照 + JSON 匯出**：出發前凍結計畫，為未來的「計畫 vs 實際」回憶功能預留資料

### 目前進度

Plan 2 已完成——行程詳情頁（Google 地圖）、地點搜尋加入停留點（搜尋偏好綁定地圖視野）、地圖標記聯動與鏡頭跟隨、右鍵自訂停留點、停留點編輯（時間/備註/花費/時間鎖定）與刪除。

Plan 3 已完成——時間軸（Day 分頁、色塊拖曳含自動連鎖順延／🔒 鎖定不動／5 分鐘吸附）、播放頭與地圖「我」標記（每秒推進 10 分鐘）、停留點時間全面改用當地時區顯示。

Plan 4 核心完成——相鄰停留點交通段自動計算（Google Routes，含 route_cache 快取）、交通段編輯器（手動修正時長／交通方式，flight 段跨日跨時區起訖，手動內容不被自動計算覆蓋）、交通與停留銜接衝突警示。地圖路線圖層（選中日 polyline）與 PR 總審遺留清項留待旅途中補。

## 技術架構

| 層 | 選型 |
|----|------|
| 前端 | Next.js（TypeScript + React），部署於 Vercel |
| 後端 | Supabase（PostgreSQL + Auth + Realtime），Row Level Security 控權限 |
| 地圖與路線 | Google Maps JavaScript API + Places API + Routes API |
| 測試 | 核心邏輯純函式單元測試 + 整合測試 + Playwright E2E |

完整設計文件（含架構決策紀錄與 Google ToS 合規查證）見 [`docs/superpowers/specs/2026-07-30-travel-planner-design.md`](docs/superpowers/specs/2026-07-30-travel-planner-design.md)。

## 專案狀態

- ✅ Plan 1 地基：帳號系統（Email + Google）、資料庫 schema + RLS、行程 CRUD、26 項測試
- ✅ Plan 2 完成：地圖與停留點編輯
- ✅ Plan 3 完成：時間軸（Day 分頁、拖曳連鎖順延、播放頭與地圖「我」標記、當地時區顯示）
- ✅ Plan 4 核心完成：交通段自動計算（Google Routes）+ 手動修正 + flight 跨日跨時區起訖 + 交通與停留衝突警示（Task 7 地圖路線圖層、Task 9 總審遺留清項留待旅途中補）

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

## 已知限制

- 地圖 `mapId` 目前為開發用 `DEMO_MAP_ID`，部署前需在 GCP 建立正式 Map ID 並替換
- 鏡頭跟隨涵蓋「加入停留點」「點選側欄／時間軸」與「播放預覽動畫」；播放中的鏡頭行為是刻意的
  「起播定格全景」（fitBounds 收整段路線入鏡一次，之後原則上不動，僅在「我」標記跑出可視範圍時
  才 panTo 追上），不是逐幀貼著標記跑
- 時間軸拖曳僅支援整塊平移（時長調整請透過停留點編輯器）
- 跨午夜停留點僅顯示於開始日
- 選中日地圖路線圖層（polyline）尚未實作，留待旅途中或 Plan 5 補
- 步行路線為 Google Beta 功能，可能缺乏人行道資訊
- Google Routes API 不支援日本（及印度鐵路）的大眾運輸；TRANSIT 查詢在這類地區（或任何無合適大眾運輸路線的短程）會顯示「無大眾運輸資料」，並保留 Google 回傳的步行時間估算供參考，可手動修正
- 刪除停留點會連帶刪除其相鄰交通段（FK cascade），含手動填寫的 manual／flight 段——重要班次資訊請留意
- 跨夜交通段顯示歸屬出發日，隔日視角不顯示延續
- 路線代理限流為單機（模組層記憶體）實作，serverless 多實例部署下護欄效果弱化；商用前需換集中式限流（Upstash／DB）
- 交通段轉乘細節（detail）本版未取用
- custom 模式目前與 flight 共用「必填起訖」表單，須填絕對出發／抵達時間，暫不支援只填時長
- flight／custom 起訖若落在時區的日光節約時間（DST）邊界、剛好是當地「不存在的時刻」（例如春進時鐘跳過的那一小時）或「重複的時刻」（秋回撥回的那一小時），底層 `date-fns-tz` 會靜默位移／擇一，已有測試鎖定此行為（本產品時區主場景東亞無 DST，不做顯式拒絕）
- 脫離行程順序的交通段收在側欄專屬區塊（資料保留、可刪除）；恢復相鄰後保留為手動段，可一鍵改回自動計算（花費將清除）
- 多位協作者同時開啟同一行程會各自觸發交通段同步；快取命中與資料庫 unique 約束衝突的靜默略過吸收了多數重複，但仍存在重複呼叫 Google 的窗口
- 邀請連結（`trip_invites`）多次可用直到過期（預設 7 天、上限 30 天）或 owner 手動撤銷；owner 移除成員時會一併撤銷**該行程全部**邀請連結（Task 7 根治——曾嘗試只鎖「被移除者最近一次用來加入的那條」，但邀請連結本無 email 收件人、可被多人重複使用，PoC 證實這種精準追蹤會 fail-open：連結一旦被別人用過，追蹤即失效，被移除者仍能用手上舊連結重新加入；改採全部撤銷才是不會 fail-open 的根治）；owner 需重新產生連結給還沒加入的其他受邀者
- 邀請接受頁（`/invite/[token]`）未登入時導向登入頁，登入後須重新開啟邀請連結才會生效（無 `next` 回跳參數，屬後續範圍，見 Plan 5 Task 10）
- 成員面板（header「成員」鈕）為簡易下拉區塊，尚未支援點擊外部自動收合
