# travel-planner

把旅遊行程表從「表格」變成「時間 × 地圖」的行程規劃產品。在互動地圖上規劃行程，拖動時間軸看到自己什麼時間會在什麼地方、用什麼交通方式移動、要移動多久，並支援多人即時共同編輯。

## 核心功能（MVP）

- **地圖 × 時間軸行程編輯**：時間軸滑桿與地圖完全聯動，播放頭走到哪，地圖上的「我」就在哪
- **多人即時共編**：旅伴共同編輯同一份行程，改動即時同步
- **交通自動計算 + 手動修正**：相鄰景點間自動計算大眾運輸／步行／開車路線與時間，可手動覆寫（手動內容絕不被自動覆蓋）
- **時間連鎖順延**：中途插入景點，後續行程自動順延；可鎖定不可動的時間點（航班、訂位）並警示衝突
- **行程預覽動畫**：一鍵播放整趟行程，地圖鏡頭跟著路線飛
- **分享連結**：旅伴免註冊即可唯讀檢視
- **預估花費**：景點與交通的可留空花費欄位，含總覽統計
- **定稿快照 + JSON 匯出**：出發前凍結計畫，為未來的「計畫 vs 實際」回憶功能預留資料

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
- 🚧 Plan 2 進行中：地圖與停留點編輯

## 開發

前置需求：nvm（Node 22+）、Docker Desktop、Supabase CLI（`brew install supabase/tap/supabase`）。

```bash
nvm use --lts
npm install
supabase start                 # 啟動本地 Supabase（首次會拉 Docker 映像）
cp .env.example .env.local     # 填入 supabase status 顯示的 URL 與 anon key
npm run dev                    # http://localhost:3000
npm test                       # 單元測試 + RLS 整合測試（需本地 Supabase）
```

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
