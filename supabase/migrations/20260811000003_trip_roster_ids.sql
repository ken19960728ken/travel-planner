-- ============ trip_roster_ids：名冊 id 取用抽成共用函式 ============
-- 審查 s-1（2026-08-11 db-expert）：cascade_shift_stops 與 shift_following_stops 都需要
-- 「這個行程的名冊 id 陣列」。兩份手抄的 SQL 已經開始出現字面差異（一支有 `is not null`
-- 一支沒有，功能等價但看起來不同），而「兩支的分軌判準必須逐條一致」是這組功能的硬性
-- 不變量——靠人工同步兩份複製維持不住，抽成一個函式才是結構性保證。
--
-- ⚠️⚠️ 【為何是獨立的一支 migration，而不是改 20260811000000／20260811000001】
-- 那兩支**已經套用到雲端**。`supabase db push` 只執行帳本裡沒有的版本，所以改寫已套用的
-- migration 檔案，改動永遠不會到雲端——本機（會重跑）與雲端（不會）就此分岔。
--
-- 這次實際發生了：先把 trip_roster_ids 加進 20260811000000、把 20260811000001 改成呼叫它，
-- 然後推送。push 只帶上了 20260811000002，於是雲端的 shift_following_stops 呼叫一個
-- **在雲端根本不存在的函式**，一按「一起順延」就是 42883。程式碼還沒部署所以沒人踩到，
-- 但這是「已套用的 migration 視同不可變」這條規則存在的理由，記在這裡以免重蹈。
--
-- 兩支已推送的檔案已還原成雲端實際跑過的內容；改動全部集中在本檔。
-- 本檔對「全新建立的資料庫」與「已套用到 20260811000002 的資料庫」產生相同的最終狀態。

begin;

create or replace function public.trip_roster_ids(p_trip_id uuid) returns uuid[]
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg((e->>'id')::uuid), '{}'::uuid[])
    from public.trips t, jsonb_array_elements(t.participants) e
   where t.id = p_trip_id
     -- 畸形元素（缺 id／id 不是 uuid）跳過，與 parseRoster 逐個丟棄的作法一致。
     -- NULL ~ regex 求值為 NULL，缺 id 的元素天然被 WHERE 濾掉，不需另加 is not null。
     and (e->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- shift_following_stops（20260811000002）本體已經呼叫 trip_roster_ids，不需重下。
-- cascade_shift_stops 則改成也走共用函式——兩支的名冊取法自此只有一份實作。
-- 函式本體逐字沿用 20260811000001，唯二差異：名冊那段換成呼叫、search_path 補上 pg_temp
-- （審查 s-3：其餘所有 SQL 函式都是 public, pg_temp，只有這支是裸 public）。
create or replace function public.cascade_shift_stops(
  p_trip_id uuid,
  p_changed_stop_id uuid,
  p_delta_seconds bigint
) returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_changed_start timestamptz;
  v_roster uuid[];
  v_changed_who uuid[];
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

  v_roster := public.trip_roster_ids(p_trip_id);

  select public.resolve_stop_participants(participant_ids, v_roster)
    into v_changed_who
    from public.stops
   where id = p_changed_stop_id;

  update public.stops s
  set starts_at = starts_at + make_interval(secs => p_delta_seconds),
      ends_at   = ends_at   + make_interval(secs => p_delta_seconds)
  where s.trip_id = p_trip_id
    and (s.id = p_changed_stop_id
         or (s.locked = false
             and s.starts_at > v_changed_start
             -- 名冊為空時兩邊都是空陣列，&& 對空陣列回 false，必須顯式短路，
             -- 否則空名冊會變成「什麼都不順延」——最嚴重的回歸
             and (cardinality(v_roster) = 0
                  or public.resolve_stop_participants(s.participant_ids, v_roster) && v_changed_who)));
end $$;

commit;

-- 回滾：
--   cascade_shift_stops → 重跑 20260811000001 的 create or replace function 內容
--   trip_roster_ids     → drop function if exists public.trip_roster_ids(uuid);
-- ⚠️ 順序：必須先還原 cascade_shift_stops 與 shift_following_stops（20260811000002）
-- 才能 drop trip_roster_ids——兩支的本體都引用它，而 plpgsql/sql 函式本體不建立依賴，
-- drop 會成功，錯誤延到下一次呼叫才出現（同 20260811000000 檔尾記錄的那個機制）。
