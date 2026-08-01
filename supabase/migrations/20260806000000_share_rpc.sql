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
