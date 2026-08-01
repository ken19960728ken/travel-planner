begin;

-- ============ trip_candidates（行程候選地點清單） ============
-- 回滾路徑：純新增表，舊程式碼零引用 trip_candidates，回滾不需要任何 DB 動作。
-- 應急停用寫入（單條 SQL，出事時執行；不影響既有讀取）：
--   revoke insert, update, delete on public.trip_candidates from authenticated;
create table public.trip_candidates (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  place_id text not null,
  category text not null default 'other',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint trip_candidates_name_len check (name ~ '\S' and length(btrim(name)) <= 200),
  -- 實測 3200 字元不可壓縮 place_id 會撞 btree 單值上限（54000，PostgREST 回 500 而非 400）；
  -- 空字串會讓 (trip_id, place_id) 的 unique 去重語義失效（同 trip 可插入多筆空 place_id）
  constraint trip_candidates_place_id_len check (length(place_id) between 1 and 255),
  constraint trip_candidates_category_valid check (category in ('transport', 'sight', 'food', 'lodging', 'shopping', 'other')),
  -- unique (trip_id, place_id) 的 trip_id 前綴已可支援 cascade 刪除與依 trip_id 查詢兩種用途，
  -- 不另建 trip_id 單欄索引（避免重複索引維護成本）
  unique (trip_id, place_id)
);

comment on table public.trip_candidates is
  '不變量：(1) 單一行程候選地點上限 100 筆，由 check_trip_candidates_limit trigger 強制'
  '（P0001 candidate_limit_reached）。'
  '(2) 欄位級 GRANT 白名單是主要防線：authenticated INSERT 僅 (trip_id, name, lat, lng, place_id, category)，'
  'UPDATE 僅 (name, category)；id/trip_id/place_id/created_by/created_at 一律不可由 client 竄改'
  '（GRANT 之外另有 check_trip_candidates_immutable trigger 作縱深防禦，詳見該函式）。'
  '(3) Google Maps Platform 服務條款禁止快取／持久化評分、營業時間、照片、評論等內容——本表嚴禁新增此類欄位。'
  '(4) 無 stops.place_refreshed_at 對應欄位：created_at 即等同抓取時間，且本列不會被系統重新抓取'
  '（僅 name/category 可由使用者手動編輯），兩者語義等價，故不需要獨立的「上次刷新時間」欄位。'
  '(5) category 是使用者可編輯的自有分類標記（加入候選時由 Google types 推導預填），嚴禁存放 Google 回傳的 '
  'raw types/primaryType 字串本身（(3) 之外的另一條 ToS 邊界）。';

alter table public.trip_candidates enable row level security;
create policy "成員可讀候選地點"
  on public.trip_candidates for select to authenticated using (public.is_trip_member(trip_id));
create policy "editor 以上可增候選地點"
  on public.trip_candidates for insert to authenticated with check (public.is_trip_editor(trip_id));
create policy "editor 以上可改候選地點"
  on public.trip_candidates for update to authenticated
  using (public.is_trip_editor(trip_id))
  with check (public.is_trip_editor(trip_id));
create policy "editor 以上可刪候選地點"
  on public.trip_candidates for delete to authenticated using (public.is_trip_editor(trip_id));

-- ============ 候選地點筆數上限（BEFORE INSERT trigger） ============
-- 防止單一行程無上限塞入候選地點拖垮清單 UI／查詢效能；上限值集中於此常數，調整只改一處。
-- create or replace：本函式在同名 table 被 drop 後仍可能以孤兒物件存在（DROP TABLE 不會連帶
-- 刪除只在函式本文文字內引用該表的函式），用 or replace 讓本檔案在任何前置狀態下都可重複套用。
create or replace function public.check_trip_candidates_limit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit constant integer := 100;
begin
  -- F-1（vuln-verifier）：BEFORE INSERT 早於 RLS WITH CHECK 求值，且本函式 SECURITY DEFINER 不受 RLS
  -- 限制；若不先擋非 editor，P0001（已滿）vs 42501（RLS 拒絕，未滿）的錯誤碼差異會讓任何登入者對任意
  -- trip_id 探測其候選筆數是否達上限（跨租戶 1 bit 洩漏）。這裡直接放行交還給 RLS：非 editor 略過計數
  -- 邏輯直接回傳 new，讓下面的 INSERT policy（is_trip_editor）統一以 42501 擋下，不讓計數邏輯先曝光
  -- 任何訊號。
  if not public.is_trip_editor(new.trip_id) then
    return new;
  end if;

  -- F-2（vuln-verifier PoC3，12/12 輪突破，最高 107 筆）：READ COMMITTED 下「先 count 再 insert」，
  -- 兩個併發交易互相看不到對方尚未提交的列，各自讀到 count=99 都判定未滿而放行。取每行程互斥鎖後才
  -- 做 count，讓後到的交易在取鎖時阻塞，直到前一交易提交／回滾才能讀到最新快照——與 cascade_shift_stops
  -- 共用同一把鎖（hashtextextended(trip_id::text, 0)，見 20260801000001_cascade_shift_v2.sql）。
  -- 兩者不構成鎖序反轉：各自的交易在整個生命週期只取這一把鎖，取得後即完成該次寫入並釋放（xact 範圍），
  -- 不會在持鎖期間再嘗試取任何其他鎖，因此不存在「A 等 B 同時 B 等 A」的循環等待條件
  -- （db-expert 2026-08-01 判斷：cascade_shift_stops 只鎖 stops、鎖持有時間亞毫秒級，共用同一把鎖僅是
  -- 讓兩個子系統對同一行程的寫入序列化，不會死鎖）。
  perform pg_advisory_xact_lock(hashtextextended(new.trip_id::text, 0));

  if (select count(*) from public.trip_candidates where trip_id = new.trip_id) >= v_limit then
    raise exception 'candidate_limit_reached' using errcode = 'P0001';
  end if;
  return new;
end $$;
-- SECURITY DEFINER 函式預設 execute 授予 public——收回；本函式僅供 trigger 內部呼叫，不開放任何角色直接呼叫
revoke execute on function public.check_trip_candidates_limit() from public, anon;

create trigger trip_candidates_limit_check
  before insert on public.trip_candidates
  for each row execute function public.check_trip_candidates_limit();

-- ============ 不可變欄位縱深防禦（vuln-verifier F-3） ============
-- WITH CHECK 拿不到 OLD，無法在 policy 內表達「trip_id 不可變」；欄位級 GRANT（update 僅 name, category）
-- 是主要防線，但若 GRANT 因故鬆動（PoC 已模擬 grant update(trip_id) 重現：身兼 A、B 兩行程 editor 者
-- 可把候選搬到另一行程，此時 WITH CHECK 在兩邊都成立、擋不住），GRANT 之外需要獨立防線。
-- category/name 刻意不列入——兩者本來就該可由使用者編輯。
create or replace function public.check_trip_candidates_immutable() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id
     or new.trip_id is distinct from old.trip_id
     or new.place_id is distinct from old.place_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'immutable_column_modified' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.check_trip_candidates_immutable() from public, anon;

create trigger trip_candidates_immutable_check
  before update on public.trip_candidates
  for each row execute function public.check_trip_candidates_immutable();

-- ============ Realtime ============
-- db-expert 實測 WAL 解碼證實：沒有 replica identity full 時 DELETE payload 只含主鍵，而
-- realtime.is_visible_through_filters 要求 filter 指名的欄位（如 trip_id）必須出現在 payload 內，
-- 否則「帶 trip_id filter 的成員收不到刪除事件」（清單不會消失）且「不帶 filter 的非成員反而收得到」
-- （DELETE 事件不套 RLS）。init.sql 對 stops/legs 設 full 正是此因，本表比照辦理，不能只靠預設
-- replica identity（primary key）。
alter table public.trip_candidates replica identity full;
alter publication supabase_realtime add table public.trip_candidates;

-- ============ 表級與欄位級權限（RLS 的前置門檻：沒有 GRANT，policy 根本不會被評估） ============
grant select, delete on public.trip_candidates to authenticated;
-- 欄位白名單擋 id/trip_id/place_id/created_by/created_at 竄改（trip_id/place_id 亦受上方
-- check_trip_candidates_immutable trigger 二次防線保護）
grant insert (trip_id, name, lat, lng, place_id, category) on public.trip_candidates to authenticated;
grant update (name, category) on public.trip_candidates to authenticated;
grant select, insert, update, delete on public.trip_candidates to service_role;
-- 刻意不 grant anon

commit;
