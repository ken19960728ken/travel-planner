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

-- 【p_expected_count：詢問框上的數字必須等於實際會動的數字】審查 M-1/M-2。
-- 這是兩步式設計（先儲存跳詢問、使用者稍後才確認）獨有的風險，拖曳路徑沒有——那是同一個
-- 手勢的一部分，窗口只有毫秒。這裡的窗口**沒有上限**，使用者可以看著詢問框去吃午餐。
-- 兩個實際會發生的落點：
--   (a) 同一次儲存也改了錨點的 participant_ids：client 用舊指派算筆數、RPC 用新指派算，
--       實測「畫面說 1、實際動 2」，乙的下午被推遲（審查 M-1）；
--   (b) 協作者在詢問窗口內新增／刪除／鎖定了後續停留點。
-- 對不上就整筆退回（40001）讓使用者重看一次，而不是照著一個過期的數字動手。

begin;

-- drop 而非只靠 create or replace：本支尚未上雲但**簽章改過一次**（多了 p_expected_count）。
-- create or replace 對簽章改變不會取代舊的那支，會留下 overload，PostgREST 的解析結果不可靠。
-- 本專案已經在「grant 只加不減」上踩過同型別的坑（20260811000000:48-51）。
drop function if exists public.shift_following_stops(uuid, uuid, timestamptz, bigint);

create or replace function public.shift_following_stops(
  p_trip_id uuid,
  p_anchor_stop_id uuid,
  p_after timestamptz,
  p_delta_seconds bigint,
  p_expected_count integer
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

  -- stops 表註解（20260801000002:45-48）：多列批次 UPDATE 必須先取這把鎖，與 cascade_shift_stops
  -- 共用同一把，否則兩者併發時鎖序可能成環
  perform pg_advisory_xact_lock(hashtextextended(p_trip_id::text, 0));

  -- 取法與 cascade_shift_stops 共用同一個函式（審查 s-1）：兩支的判準必須逐條一致，
  -- 靠兩份手抄的 SQL 維持不住。
  v_roster := public.trip_roster_ids(p_trip_id);

  select public.resolve_stop_participants(participant_ids, v_roster)
    into v_anchor_who
    from public.stops
   where id = p_anchor_stop_id and trip_id = p_trip_id;

  -- 錨點驗證放在 delta=0 早退**之前**（審查 m-1）：順序與 cascade_shift_stops 一致。
  -- 反過來的話「錨點根本不存在」在 delta=0 時會被靜默吞掉並回 0。
  if v_anchor_who is null then
    raise exception 'stop not found in trip';
  end if;
  if p_delta_seconds = 0 then
    return 0;
  end if;

  update public.stops s
     set starts_at = starts_at + make_interval(secs => p_delta_seconds),
         ends_at   = ends_at   + make_interval(secs => p_delta_seconds)
   where s.trip_id = p_trip_id
     and s.id <> p_anchor_stop_id          -- ← 與 cascade_shift_stops 的唯一實質差異
     and s.locked = false
     and s.starts_at > p_after
     and (cardinality(v_roster) = 0
          or public.resolve_stop_participants(s.participant_ids, v_roster) && v_anchor_who);
  -- GET DIAGNOSTICS 而非 with moved as (… returning 1) select count(*)：語義等價
  -- （stops_touch 是 BEFORE trigger 且永遠回 NEW，不會抑制列），但少一層 CTE 與 tuplestore
  get diagnostics v_count = row_count;

  if p_expected_count is null or v_count <> p_expected_count then
    raise exception 'following stop set changed (expected %, matched %)', p_expected_count, v_count
      using errcode = '40001';
  end if;

  return v_count;
end $$;

revoke execute on function public.shift_following_stops(uuid, uuid, timestamptz, bigint, integer) from public;
grant execute on function public.shift_following_stops(uuid, uuid, timestamptz, bigint, integer) to authenticated;

commit;

-- 回滾：drop function if exists public.shift_following_stops(uuid, uuid, timestamptz, bigint, integer);
--   （if exists：雲端若從未套用成功，裸 drop 會中斷整個回滾腳本）
-- 回滾後 StopEditor 的「一起順延」按鈕會拿到 42883（函式不存在），需連同程式碼一起回退。
-- 本函式不被其他物件引用，單獨 drop 無副作用。
