begin;
-- 把 legs.polyline 加回 get_shared_trip 白名單。
-- 20260803000005 剔除 polyline 的理由是「全 app 無任何繪製路徑（TripView 只有型別宣告）」——
-- 該前提自播放視覺（RoutePolylines/PlaybackTrail，2026-08-04）起不再成立：分享頁與成員頁同用
-- TripView 渲染選中日路線與播放漸進紅線，成員頁的 legs select（page.tsx）本就含 polyline，
-- 分享頁缺它會整頁退化成直線虛線。ToS 面不變：polyline 屬 Google 衍生、30 天 TTL 快取，
-- 對匿名訪客渲染與對成員渲染同一合規類別；仍然不進 snapshot/匯出（snapshot.ts 明文排除，未動）。
-- notes 維持剔除（純外洩，無任何唯讀渲染路徑）。
-- payload 影響（2026-08-04 總審 m-7 + 複審 🟡-3 修正）：legs.polyline 這欄原本沒有長度上限——
-- editor 可經 PostgREST 直寫任意長字串（不像 title/name 那類欄位有 check constraint 把關）。
-- 上限取 4000：本地實測 Google Routes 回傳的 polyline 最長 662 字元，4000 已有 6 倍餘裕；
-- 500 legs 上限下最壞 500 * 4000 = 2MB，落在 20260803000005 記載的頻寬護欄（7.8MB 觀測值促成
-- limit 500）之內——初版取 20000 會讓最壞回到 10MB，等於用新天花板追認先前被否決的量級，已收斂。
--
-- create or replace 保留既有 ACL（先前的 revoke from public + grant anon/authenticated 不受影響），
-- 文末仍重申一次以自我文件化。
-- 回滾：重跑 20260803000005 的 create function 內容（即移除 polyline 欄），或整顆
-- drop function public.get_shared_trip(uuid);（應急停用分享，語義同「連結已失效」）。
-- constraint 回滾：alter table public.legs drop constraint if exists legs_polyline_len;
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
        'source', l.source, 'stale', l.stale, 'departs_at', l.departs_at,
        'arrives_at', l.arrives_at, 'estimated_cost', l.estimated_cost,
        'updated_at', l.updated_at
      ) order by l.id) from (select * from legs where trip_id = t.id order by id limit 500) l), '[]'::jsonb)
  )
  from trips t where t.share_token = p_token
$$;
revoke execute on function public.get_shared_trip(uuid) from public;
grant execute on function public.get_shared_trip(uuid) to anon, authenticated;

-- drop if exists 讓整支檔案可安全重跑（複審 🟡-2）：本專案實務上存在繞過 CLI 手動套 SQL 的情況
-- （本地帳本 schema_migrations 落後於實際 schema），裸 add constraint 重跑會炸掉整個 transaction，
-- 連帶回滾上面的 create or replace，錯誤訊息還指向與函式無關的 constraint，極難排查。
alter table public.legs drop constraint if exists legs_polyline_len;
alter table public.legs
  add constraint legs_polyline_len check (polyline is null or length(polyline) <= 4000);

commit;
