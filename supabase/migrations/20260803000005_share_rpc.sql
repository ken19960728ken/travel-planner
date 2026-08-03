begin;
-- 分享預覽（spec §4：share_token 免註冊唯讀、可重生成使舊連結失效）。
-- 設計：SECURITY DEFINER RPC 以 token 換一份唯讀 jsonb，anon 不獲任何表級權限；
-- token 錯誤時查無列，SQL 函式回 null——對外語義一律「連結已失效」，不區分不存在/已重生成。
-- 欄位採顯式白名單（不用 to_jsonb 減鍵：新增欄位時「預設外洩」是錯的方向；白名單漏欄頂多少顯示）。
-- 花費刻意包含：分享對象是旅伴，花費對齊正是 spec §2 預估花費的目的，且側欄 CostSummary
-- （不在 canEdit 閘門內）在唯讀路徑會實際渲染它——與下面被移除的 notes/polyline 不同。
-- **notes 已移除**（審查）：只有 StopEditor 消費，canEdit=false 時不掛載 → 送出去但畫面一個字都不顯示，
-- 是純外洩。實務上放訂房代號/房號/同行者資訊，schema 允許 10000 字。
-- **polyline 已移除**（審查）：全 app 無任何繪製路徑（TripView 只有型別宣告）。且 snapshot.ts 自承
-- 快照刻意排除 polyline 等 Google 衍生欄位，公開路徑卻原樣輸出，標準不一致。
-- 兩者移除後 payload 體積也大幅下降（見下方 limit 500 的說明）。
--
-- 回滾：drop function public.get_shared_trip(uuid);（純新增函式，不動任何表與資料，無資料遺失風險）
-- 應急停用分享：revoke execute on function public.get_shared_trip(uuid) from public, anon, authenticated;
--   （**必須含 public**——Postgres 對函式的預設授權就是 PUBLIC，只 revoke anon 關不掉）
-- legs 含 updated_at：分享頁重用 TripView 的 Leg 型別（樂觀鎖欄位），唯讀路徑不使用其值。
create function public.get_shared_trip(p_token uuid) returns jsonb
language sql security definer stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'trip', jsonb_build_object(
      'id', t.id, 'title', t.title, 'start_date', t.start_date,
      'end_date', t.end_date, 'currency', t.currency),
    'stops', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'lat', s.lat, 'lng', s.lng, 'place_id', s.place_id,
        'is_custom', s.is_custom, 'timezone', s.timezone, 'starts_at', s.starts_at,
        'ends_at', s.ends_at, 'locked', s.locked,
        'estimated_cost', s.estimated_cost
      ) order by s.starts_at, s.id) from (select * from stops where trip_id = t.id order by starts_at, id limit 500) s), '[]'::jsonb),
    'legs', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'from_stop_id', l.from_stop_id, 'to_stop_id', l.to_stop_id,
        'mode', l.mode, 'duration_minutes', l.duration_minutes,
        'distance_meters', l.distance_meters, 'detail', l.detail,
        'source', l.source, 'stale', l.stale, 'departs_at', l.departs_at,
        'arrives_at', l.arrives_at, 'estimated_cost', l.estimated_cost,
        'updated_at', l.updated_at
      ) order by l.id) from (select * from legs where trip_id = t.id order by id limit 500) l), '[]'::jsonb)
  )
  from trips t where t.share_token = p_token
$$;
-- 匿名讀取的頻寬護欄（審查）：實測 500 stops 的上限行程 payload 達 7.8MB、請求僅 100 bytes，
-- 約 78,000 倍放大器；無速率限制、SSR 每次瀏覽完整重跑、RSC 再送一份（出口流量兩份）。
-- 寫入端本有 500 limit，匿名讀取端原本沒有對應天花板，這裡補上與寫入端對齊的硬上限。

-- SECURITY DEFINER 函式的 EXECUTE 預設就授予 PUBLIC——不顯式收回的話，對 anon revoke 也關不掉
-- （緊急止血路徑失效）。同專案的 accept_trip_invite 與 regenerate_share_token 都已照此處理。
revoke execute on function public.get_shared_trip(uuid) from public;
-- 這顆 RPC 的存在意義就是給匿名訪客用：grant 給 anon + authenticated
grant execute on function public.get_shared_trip(uuid) to anon, authenticated;
commit;
