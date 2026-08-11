-- ============ legs.custom_path（手繪交通路徑） ============
-- 設計文件：docs/superpowers/specs/2026-08-10-manual-route-path-design.md
--
-- ⚠️⚠️ 部署順序（比照 README「migration 與程式碼的部署順序」表格的「新程式碼要讀新欄位／新表」列）：
-- **這支 migration 必須先推上雲端，Vercel 程式碼後部署。**
-- 正向（migration 先）：新增欄位對舊程式碼完全透明——舊碼的 select 清單不含 custom_path，
-- get_shared_trip 多回一個鍵也不會讓舊 client 出錯（多餘的鍵被忽略），可安全先行。
-- 反向（程式碼先）：page.tsx 的 select 會指名不存在的欄位 → 查詢整個失敗 → 行程頁「停留點讀取失敗」。
-- 本專案 2026-08-03 已因搞反此順序造成線上故障（stops.category），README 的順序表就是那次補的。
--
-- 【為何新增欄位而不重用 legs.polyline】
-- 兩者是性質相反的資料，共用同一欄會讓既有規則全部失效：
--   * polyline     = Google 衍生。保存上限 30 天（ToS，spec §4 資料分層）；定稿快照與 JSON 匯出
--                    明文排除；auto 段重算時被覆寫。
--   * custom_path  = 使用者自己畫的。永久保存；**收錄**進快照與匯出；sync 永不觸碰。
-- snapshot.ts:10-11 目前是靠「輸入型別根本不宣告 polyline 這個鍵」來保證結構上不可能外洩
-- Google 衍生資料，共用同一欄會直接破壞這個保證。
--
-- 【格式】jsonb 陣列 [[lat, lng], ...]，只存「中間轉折點」，頭尾在渲染時接上停留點目前的位置
-- （停留點被拖動時路徑自動重接，不會與圖釘對不齊）。不用編碼字串是因為本專案只有 decodePolyline
-- 沒有編碼器，用 JSON 免寫編碼器與其測試，且 DB 內容可讀、可用 check constraint 驗形狀。
--
-- 【雙重上限：100 點 + 4000 字元】
-- 只限元素個數是不夠的——審查實測：100 個元素、每個塞 1MB 字串，仍然通過個數檢查，
-- 整欄可達 95MB。任何 editor 成員都能直接打 PostgREST 寫入，而 get_shared_trip 白名單放行此欄，
-- 匿名分享頁會把它整包吐出去，等於一個成員可以炸掉整個行程的分享頁與所有成員的頁面。
-- 故另加 length(custom_path::text) <= 4000，與 legs_polyline_len 的 4000 字元上限同量級。
-- 座標由應用層四捨五入到 6 位小數（約 0.1 公尺，遠超畫線精度需求）後才寫入，100 點約 2.4KB，
-- 在 4000 字元內；不收斂精度的話全精度浮點會讓 100 點逼近 4000，卡得太緊。
-- check constraint 無法逐元素迭代，故只驗「是陣列、長度 ≤ 100、總字元 ≤ 4000」；每個元素是否為
-- 合法座標由應用層驗證（src/lib/domain/routePath.ts 的 parseCustomPath），渲染層另做防禦性過濾。
--
-- 【不需要 GRANT】實測 pg_class.relacl 顯示 legs 是表級 authenticated=arwd，
-- 且 pg_attribute.attacl 對 legs 完全為空（零欄位級 ACL）。新欄位在表級授權下自動繼承
-- INSERT/UPDATE/SELECT——與 trips／trip_candidates（已收緊到欄位級白名單，新欄位需顯式補 grant）
-- 刻意不同。既有 policy「editor 以上可改交通段」（init.sql:204）自動涵蓋本欄位。
--
-- 【PG 11+】add column 無 default 值走 metadata-only 路徑，不重寫既有資料列、零停機。

begin;

alter table public.legs add column if not exists custom_path jsonb;

-- drop if exists 前綴讓整支檔案可安全重跑：本專案實務上存在繞過 CLI 手動貼 SQL 的情況
-- （本地帳本 schema_migrations 曾落後於實際 schema），裸 add constraint 重跑會炸掉整個
-- transaction，並連帶回滾下方的 create or replace function，錯誤訊息還指向與函式無關的地方。
alter table public.legs drop constraint if exists legs_custom_path_shape;
alter table public.legs
  add constraint legs_custom_path_shape check (
    custom_path is null
    or (
      jsonb_typeof(custom_path) = 'array'
      and jsonb_array_length(custom_path) <= 100
      -- 資料量上界：只限個數擋不住「100 個元素、每個 1MB」（審查實測 95MB）
      and length(custom_path::text) <= 4000
    )
  );

-- ============ get_shared_trip 白名單補 custom_path ============
-- 手繪路徑是使用者資料、且分享頁重用同一套 TripView 渲染，不放行的話旅伴看到的路線會與
-- 擁有者不一致（退回 Google 的線或直線）。函式本體逐字沿用 20260804000000，唯一差異是
-- legs 區塊多一行 'custom_path'。
-- create or replace 保留既有 ACL（20260804000000 已實測確認），文末仍成對重申以自我文件化。
create or replace function public.get_shared_trip(p_token uuid) returns jsonb
language sql security definer stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'trip', jsonb_build_object(
      'id', t.id, 'title', t.title, 'start_date', t.start_date,
      'end_date', t.end_date, 'currency', t.currency),
    'stops', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'lat', s.lat, 'lng', s.lng, 'place_id', s.place_id,
        'is_custom', s.is_custom, 'timezone', s.timezone, 'starts_at', s.starts_at,
        'category', s.category,
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

-- 回滾（兩層，依需要擇一）：
--   僅解除格式限制、保留資料：
--     alter table public.legs drop constraint legs_custom_path_shape;
--   完整移除欄位（連同使用者畫的所有路徑，不可復原）：
--     alter table public.legs drop column custom_path;
--   分享白名單回滾（移除 custom_path 鍵）：重跑 20260804000000 的 create or replace function 內容。
--
-- ⚠️ 回滾順序：若要移除欄位，必須先回滾（或同時回滾）分享 RPC——函式本體引用 l.custom_path，
-- 欄位不存在時該函式會在呼叫時報錯，分享頁全面失效。
-- 何時不該回滾：本 migration 對舊版程式碼完全透明，單獨保留無副作用。
