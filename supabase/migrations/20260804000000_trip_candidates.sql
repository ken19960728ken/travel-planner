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
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint trip_candidates_name_len check (name ~ '\S' and length(btrim(name)) <= 200),
  -- unique (trip_id, place_id) 的 trip_id 前綴已可支援 cascade 刪除與依 trip_id 查詢兩種用途，
  -- 不另建 trip_id 單欄索引（避免重複索引維護成本）
  unique (trip_id, place_id)
);

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
create function public.check_trip_candidates_limit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit constant integer := 100;
begin
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

-- ============ Realtime ============
-- 不設 replica identity full：本表沒有高頻協作 UPDATE 情境（僅 name 可改），
-- DELETE payload 只需能辨識被刪的列，預設 replica identity（primary key）已足夠
alter publication supabase_realtime add table public.trip_candidates;

-- ============ 表級與欄位級權限（RLS 的前置門檻：沒有 GRANT，policy 根本不會被評估） ============
grant select, delete on public.trip_candidates to authenticated;
-- 欄位白名單擋 created_by/created_at/id 竄改
grant insert (trip_id, name, lat, lng, place_id) on public.trip_candidates to authenticated;
grant update (name) on public.trip_candidates to authenticated;
grant select, insert, update, delete on public.trip_candidates to service_role;
-- 刻意不 grant anon

commit;
