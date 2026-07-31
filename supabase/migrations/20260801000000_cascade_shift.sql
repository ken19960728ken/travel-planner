begin;

-- 連鎖順延（spec §6：必須原子化）。security invoker：RLS 的 editor 政策照常生效。
-- 語義對齊 src/lib/domain/schedule.ts 的 cascadeShift：被改動點自身 + 其後（starts_at 較晚）
-- 且未鎖定的停留點整體平移；starts_at 相同者不動（與 TS 版的穩定排序差異已知且可接受）。
create or replace function public.cascade_shift_stops(
  p_trip_id uuid,
  p_changed_stop_id uuid,
  p_delta_seconds bigint
) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_changed_start timestamptz;
begin
  select starts_at into v_changed_start
  from public.stops
  where id = p_changed_stop_id and trip_id = p_trip_id;

  if v_changed_start is null then
    raise exception 'stop not found in trip';
  end if;

  -- 後續未鎖定停留點
  update public.stops
  set starts_at = starts_at + make_interval(secs => p_delta_seconds),
      ends_at   = ends_at   + make_interval(secs => p_delta_seconds)
  where trip_id = p_trip_id
    and locked = false
    and starts_at > v_changed_start
    and id <> p_changed_stop_id;

  -- 被改動點自身（即使鎖定也移動——是使用者親手拖它）
  update public.stops
  set starts_at = starts_at + make_interval(secs => p_delta_seconds),
      ends_at   = ends_at   + make_interval(secs => p_delta_seconds)
  where id = p_changed_stop_id and trip_id = p_trip_id;
end $$;

grant execute on function public.cascade_shift_stops(uuid, uuid, bigint) to authenticated;

commit;
