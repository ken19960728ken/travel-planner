# travel-planner

把旅遊行程表從「表格」變成「時間 × 地圖」的行程規劃產品。在互動地圖上規劃行程，拖動時間軸看到自己什麼時間會在什麼地方、用什麼交通方式移動、要移動多久，並支援多人即時共同編輯。

## 核心功能（MVP）

- **地圖 × 時間軸行程編輯**：時間軸滑桿與地圖完全聯動，播放頭走到哪，地圖上的「我」就在哪
- **多人即時共編**：旅伴共同編輯同一份行程，改動即時同步
- **交通自動計算 + 手動修正**：相鄰停留點間自動計算大眾運輸／步行／開車路線與時間（Google Routes API），可手動修正時長／交通方式／航班起訖（手動內容絕不被自動計算覆蓋，僅標記「前後行程變動過」提示重新確認）；支援跨日航班段（出發／抵達分屬不同日期與時區）；交通時間與前後停留點銜接不上時，連接條與時間軸色塊變色警示（警示不阻擋編輯；側欄交通列警示屬 Plan 5）
- **時間連鎖順延**：中途插入景點，後續行程自動順延；可鎖定不可動的時間點（航班、訂位）並警示衝突
- **行程預覽動畫**：一鍵播放整趟行程，地圖鏡頭跟著路線飛
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

正式環境為 Vercel（前端 + API routes）+ Supabase 雲端；migration 推上雲端後需在 Vercel 專案設定補上 `GOOGLE_MAPS_SERVER_API_KEY` 與 `SUPABASE_SERVICE_ROLE_KEY` 再重新部署。出事時的回滾路徑（Vercel Instant Rollback、migration 純新增免 down、`stops_mark_manual_legs_stale` trigger 應急停用）見 [`docs/superpowers/plans/2026-07-31-travel-planner-transit.md`](docs/superpowers/plans/2026-07-31-travel-planner-transit.md) Task 10 Step 4。

## 已知限制

- 地圖 `mapId` 目前為開發用 `DEMO_MAP_ID`，部署前需在 GCP 建立正式 Map ID 並替換
- 鏡頭跟隨目前涵蓋「加入停留點」與「點選側欄」；播放動畫式的完整鏡頭運動屬 Plan 5
- 時間軸拖曳僅支援整塊平移（時長調整請透過停留點編輯器）
- 跨午夜停留點僅顯示於開始日
- 播放頭的鏡頭跟隨與預覽動畫完整版屬 Plan 5
- 選中日地圖路線圖層（polyline）尚未實作，留待旅途中或 Plan 5 補
- 步行路線為 Google Beta 功能，可能缺乏人行道資訊
- 刪除停留點會連帶刪除其相鄰交通段（FK cascade），含手動填寫的 manual／flight 段——重要班次資訊請留意
- 跨夜交通段顯示歸屬出發日，隔日視角不顯示延續
- 路線代理限流為單機（模組層記憶體）實作，serverless 多實例部署下護欄效果弱化；商用前需換集中式限流（Upstash／DB）
- 交通段轉乘細節（detail）本版未取用
- custom 模式目前與 flight 共用「必填起訖」表單，須填絕對出發／抵達時間，暫不支援只填時長
- flight／custom 起訖若落在時區的日光節約時間（DST）邊界、剛好是當地「不存在的時刻」（例如春進時鐘跳過的那一小時），底層 `date-fns-tz` 會靜默位移到鄰近有效時刻，尚無專屬測試覆蓋
- 在 auto（自動計算）交通段上填寫的預估花費，會在該段兩端不再相鄰時（插入停留點／調整順序）隨段一併刪除——重要金額請先把交通方式改為航班／自訂（manual）再填
- 在手動／航班交通段的兩端之間插入新停留點時，該段會暫時從畫面隱藏（資料保留，移回原順序即復現）
- 多位協作者同時開啟同一行程會各自觸發交通段同步；快取命中與資料庫 unique 約束衝突的靜默略過吸收了多數重複，但仍存在重複呼叫 Google 的窗口
