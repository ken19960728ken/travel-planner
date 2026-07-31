begin;

-- v2（db-expert 併發壓測後修正）：
-- C1: advisory lock + 單一 UPDATE——併發拖動 deadlock 實測 12.5%→0
-- I2: editor 前置檢查——viewer 不再假成功（沿用同一錯誤訊息，不洩漏行程存在性）
-- I3: delta=0 短路——不再空寫 N 列（replica identity full 的 WAL/廣播成本）
-- I5: revoke from public——anon 不再進得了函式本體
-- I6: 366 天上限——防 ms 誤當秒的千倍靜默事故
-- 契約（I4 敲定）：本 RPC 移動「被改動點自身 + 其後未鎖定停留點」；
-- TS 版 cascadeShift 為純預覽函式（不移動被改動點），正式提交一律走本 RPC。
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
  if abs(p_delta_seconds) > 31622400 then
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

revoke execute on function public.cascade_shift_stops(uuid, uuid, bigint) from public;
grant execute on function public.cascade_shift_stops(uuid, uuid, bigint) to authenticated;

commit;
