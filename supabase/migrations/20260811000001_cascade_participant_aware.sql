-- ============ cascade_shift_stops 改為分軌（參與人功能的第四處，也是最後一處） ============
-- 設計文件：docs/superpowers/specs/2026-08-11-participants-design.md §4
-- 前置：20260811000000_participants.sql（本函式讀 stops.participant_ids 與 trips.participants）
--
-- ⚠️ 部署順序：本檔必須排在 20260811000000 之後（檔名時間戳已保證），且同屬「migration 先、
-- 程式碼後」那一類。單獨先上線無害——舊程式碼呼叫這支 RPC 的參數與回傳都沒變。
--
-- 【為什麼要改】設計文件 §1 列了三處寫死「整趟行程只有一條時間軸」的地方（legSync 的相鄰配對、
-- conflicts 的重疊判定、interpolate 的重疊取最早），應用層都已改成分軌。審查（2026-08-11 critic
-- M-1）指出**第四處在 SQL 裡**，所以前面四次修改全都繞過它：
--
--   A(09-10 全員)、B(11-12 甲)、C(13-14 乙)、D(15-16 全員)
--   使用者在 Timeline 拖 B 延後 2 小時
--   → 舊條件 `starts_at > v_changed_start` 同時命中 C
--   → **乙的下午被憑空推遲 2 小時，畫面上沒有任何提示**
--
-- 這與地圖上的幻影交通段是同一個 bug 的第四種形態，而且後果更嚴重：那個只是畫錯線，
-- 這個會改掉別人的行程時間。
--
-- 【判準】順延的對象＝「與被拖的停留點**有共同參與人**」的後續停留點。
-- 未指派（participant_ids 為 null）視為全員，因此：
--   * 名冊為空 → 每個停留點都是全員 → 交集恆非空 → **逐字退回改版前的行為**（最重要的回歸防線）
--   * 共同行程被拖 → 全員 → 所有後續停留點照樣順延（與改版前相同）
--   * 甲的停留點被拖 → 只推遲「甲也會去」的後續停留點，乙的獨立行程不動
--
-- 交集判定與應用層的 resolveStopParticipants（src/lib/domain/participants.ts）語義一致：
-- null → 全員；未知 id 忽略；過濾後為空 → 視同全員。第三條在 SQL 裡用
-- 「與名冊的交集為空時退回全員」表達。

begin;

create or replace function public.cascade_shift_stops(
  p_trip_id uuid,
  p_changed_stop_id uuid,
  p_delta_seconds bigint
) returns void
language plpgsql security invoker set search_path = public as $$
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

  -- 名冊（只取 id）。空名冊 → v_roster 為空陣列 → 下方 resolve 恆回空 → 交集判定恆為真，
  -- 整支函式行為與 v3 逐字相同。
  select coalesce(array_agg((e->>'id')::uuid), '{}'::uuid[])
    into v_roster
    from public.trips t, jsonb_array_elements(t.participants) e
   where t.id = p_trip_id
     and (e->>'id') is not null
     -- 畸形元素（缺 id／id 不是 uuid）跳過，與 parseRoster 逐個丟棄的作法一致
     and (e->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  -- 被拖停留點的參與人（已 resolve）。
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
             -- 分軌：只推遲「與被拖的停留點有共同參與人」的後續停留點。
             -- 名冊為空時兩邊都是空陣列，&& 對空陣列回 false，所以這裡必須顯式短路，
             -- 否則空名冊會變成「什麼都不順延」——那是最嚴重的回歸。
             and (cardinality(v_roster) = 0
                  or public.resolve_stop_participants(s.participant_ids, v_roster) && v_changed_who)));
end $$;

-- 表註解沿用 v3 的內容（本次未改變該約束），重申以免 create or replace 之後有人以為它消失了
comment on table public.stops is
  '約束（db-expert 2026-07-31）：任何對本表的「多列批次 UPDATE」都必須先取 '
  'pg_advisory_xact_lock(hashtextextended(trip_id::text, 0))，與 cascade_shift_stops 共用同一把鎖，'
  '否則與 RPC 併發時會產生 deadlock（單列 UPDATE 不在此限，已實測安全）。';

commit;

-- 回滾：重跑 20260801000002_cascade_shift_v3.sql 的 create or replace function 內容即可
-- （參數與回傳簽章未變，不需 drop）。回滾後 cascade 會退回「推遲所有後續停留點」，
-- 分頭行程會出現本檔開頭描述的「乙的行程被憑空推遲」。
-- ⚠️ 回滾本檔**不需要**先處理 resolve_stop_participants——v3 的函式本體不引用它。
-- 但若要連 20260811000000 一起回滾，順序是：本檔 → resolve_stop_participants → 欄位。
