begin;
-- 把 legs.polyline 加回 get_shared_trip 白名單。
-- 20260803000005 剔除 polyline 的理由是「全 app 無任何繪製路徑（TripView 只有型別宣告）」——
-- 該前提自播放視覺（RoutePolylines/PlaybackTrail，2026-08-04）起不再成立：分享頁與成員頁同用
-- TripView 渲染選中日路線與播放漸進紅線，成員頁的 legs select（page.tsx）本就含 polyline，
-- 分享頁缺它會整頁退化成直線虛線。ToS 面不變：polyline 屬 Google 衍生、30 天 TTL 快取，
-- 對匿名訪客渲染與對成員渲染同一合規類別；仍然不進 snapshot/匯出（snapshot.ts 明文排除，未動）。
-- notes 維持剔除（純外洩，無任何唯讀渲染路徑）。
-- payload 影響：polyline 單段實測數十到數百字元、極端 2KB；500 legs 上限下最壞多約 1MB，
-- 仍在 20260803000005 記載的頻寬護欄（limit 500）承受範圍內。
--
-- create or replace 保留既有 ACL（先前的 revoke from public + grant anon/authenticated 不受影響），
-- 文末仍重申一次以自我文件化。
-- 回滾：重跑 20260803000005 的 create function 內容（即移除 polyline 欄），或整顆
-- drop function public.get_shared_trip(uuid);（應急停用分享，語義同「連結已失效」）。
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
commit;
