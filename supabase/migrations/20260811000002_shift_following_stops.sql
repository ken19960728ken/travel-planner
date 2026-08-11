-- ============ shift_following_stops：編輯器改時間後的「順延後續行程」 ============
-- 使用者需求（2026-08-11）：側欄停留點編輯器改時間後，跳出「後面的行程要一起順延 N 分鐘嗎？」
-- 讓使用者選。在此之前只有時間軸拖曳會順延，編輯器完全不會——使用者實際被絆到過。
--
-- 【為何不能重用 cascade_shift_stops】那支的 WHERE 是
--     id = p_changed_stop_id or (locked = false and starts_at > v_changed_start)
-- **一律連被改的那一筆一起平移**。拖曳路徑上那是對的（RPC 就是提交平移的唯一動作），
-- 但編輯器路徑上該筆已經先被 UPDATE 過了，再套一次會變成位移兩倍。
-- 故另開一支「只動後續、不動錨點」的函式，而不是給既有函式加旗標——後者要再動一次
-- 線上正在用的拖曳路徑，風險不對等。
--
-- 【p_after 為何由呼叫端傳】錨點的列已經是新時間了，DB 這邊查不到「原本的開始時間」。
-- 「哪些算後續」必須以**編輯前**的順序判定，所以由 client 傳它掛載時讀到的舊值。
-- 安全性：呼叫者本來就是 editor，可以直接 UPDATE 任何一筆 stop，傳任意時間點不構成提權。
--
-- 【分軌】與 cascade_shift_stops（20260811000001）同一套判準：只順延「與錨點有共同參與人」
-- 的後續停留點。名冊為空時全部順延。兩支必須一致，否則同樣的意圖走兩條路徑會得到不同結果。

begin;

create or replace function public.shift_following_stops(
  p_trip_id uuid,
  p_anchor_stop_id uuid,
  p_after timestamptz,
  p_delta_seconds bigint
) returns integer
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_roster uuid[];
  v_anchor_who uuid[];
  v_count integer;
begin
  if not public.is_trip_editor(p_trip_id) then
    raise exception 'stop not found in trip';
  end if;
  -- 與 cascade_shift_stops 同樣的區間守衛（±366 天），避免 make_interval 溢位
  if p_delta_seconds is null
     or p_delta_seconds > 31622400
     or p_delta_seconds < -31622400 then
    raise exception 'delta out of range';
  end if;
  if p_after is null or p_anchor_stop_id is null then
    raise exception 'anchor required' using errcode = '22023';
  end if;
  if p_delta_seconds = 0 then
    return 0;
  end if;

  -- stops 表註解（20260801000002:45-48）：多列批次 UPDATE 必須先取這把鎖，與 cascade_shift_stops
  -- 共用同一把，否則兩者併發時鎖序可能成環
  perform pg_advisory_xact_lock(hashtextextended(p_trip_id::text, 0));

  select coalesce(array_agg((e->>'id')::uuid), '{}'::uuid[])
    into v_roster
    from public.trips t, jsonb_array_elements(t.participants) e
   where t.id = p_trip_id
     and (e->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  select public.resolve_stop_participants(participant_ids, v_roster)
    into v_anchor_who
    from public.stops
   where id = p_anchor_stop_id and trip_id = p_trip_id;

  if v_anchor_who is null then
    raise exception 'stop not found in trip';
  end if;

  with moved as (
    update public.stops s
       set starts_at = starts_at + make_interval(secs => p_delta_seconds),
           ends_at   = ends_at   + make_interval(secs => p_delta_seconds)
     where s.trip_id = p_trip_id
       and s.id <> p_anchor_stop_id          -- ← 與 cascade_shift_stops 的唯一實質差異
       and s.locked = false
       and s.starts_at > p_after
       and (cardinality(v_roster) = 0
            or public.resolve_stop_participants(s.participant_ids, v_roster) && v_anchor_who)
    returning 1)
  select count(*) into v_count from moved;

  return v_count;
end $$;

revoke execute on function public.shift_following_stops(uuid, uuid, timestamptz, bigint) from public;
grant execute on function public.shift_following_stops(uuid, uuid, timestamptz, bigint) to authenticated;

commit;

-- 回滾：drop function public.shift_following_stops(uuid, uuid, timestamptz, bigint);
-- 回滾後 StopEditor 的「一起順延」按鈕會拿到 42883（函式不存在），需連同程式碼一起回退。
-- 本函式不被其他物件引用，單獨 drop 無副作用。
