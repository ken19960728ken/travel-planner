begin;

-- v3（db-expert 複審殘留項 R1/R2/R4）：
-- R1: 移除 abs()——bigint 最小值不再溢位成不一致的錯誤訊息
-- R2: NULL delta 前置擋下——不再白拿 advisory lock、不再吐內部約束錯誤
-- R4: stops 表註解寫死批次寫入的 advisory lock 約束（防止未來 C1 復活）
create or replace function public.cascade_shift_stops(
  p_trip_id uuid,
  p_changed_stop_id uuid,
  p_delta_seconds bigint
) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_changed_start timestamptz;
begin
  if not public.is_trip_editor(p_trip_id) then
    raise exception 'stop not found in trip';
  end if;
  if p_delta_seconds is null
     or p_delta_seconds > 31622400
     or p_delta_seconds < -31622400 then
    raise exception 'delta out of range';
  end if;

  -- 每行程互斥：同行程的並發拖動序列化，並關閉 read-then-update 競態
  perform pg_advisory_xact_lock(hashtextextended(p_trip_id::text, 0));

  select starts_at into v_changed_start
  from public.stops
  where id = p_changed_stop_id and trip_id = p_trip_id;

  if v_changed_start is null then
    raise exception 'stop not found in trip';
  end if;
  if p_delta_seconds = 0 then
    return;
  end if;

  update public.stops
  set starts_at = starts_at + make_interval(secs => p_delta_seconds),
      ends_at   = ends_at   + make_interval(secs => p_delta_seconds)
  where trip_id = p_trip_id
    and (id = p_changed_stop_id
         or (locked = false and starts_at > v_changed_start));
end $$;

comment on table public.stops is
  '約束（db-expert 2026-07-31）：任何對本表的「多列批次 UPDATE」都必須先取 '
  'pg_advisory_xact_lock(hashtextextended(trip_id::text, 0))，與 cascade_shift_stops 共用同一把鎖，'
  '否則與 RPC 併發時會產生 deadlock（單列 UPDATE 不在此限，已實測安全）。';

commit;
