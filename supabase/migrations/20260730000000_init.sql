begin;

-- ============ profiles ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text
);
alter table public.profiles enable row level security;

create policy "authenticated 可讀 profiles"
  on public.profiles for select to authenticated using (true);
create policy "本人可更新 profile"
  on public.profiles for update to authenticated using (id = auth.uid());

-- 註冊時自動建立 profile；on conflict 保護：profile 建立失敗不能擋住註冊本身
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ trips ============
-- owner_id 可空 + on delete set null：帳號刪除時行程保留給其他成員（cascade 會把行程從旅伴腳下刪掉）
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_date date not null,
  end_date date not null,
  currency text not null default 'TWD',
  owner_id uuid references auth.users(id) on delete set null default auth.uid(),
  share_token uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (currency ~ '^[A-Z]{3}$')
);
create index trips_owner_id_idx on public.trips (owner_id);

-- ============ trip_members ============
create table public.trip_members (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
create index trip_members_user_id_idx on public.trip_members (user_id);

-- 權限判斷函式（security definer 避免 RLS 遞迴）
create function public.is_trip_member(p_trip_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from trip_members
    where trip_id = p_trip_id and user_id = auth.uid()
  )
$$;

create function public.is_trip_editor(p_trip_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from trip_members
    where trip_id = p_trip_id and user_id = auth.uid()
      and role in ('owner', 'editor')
  )
$$;

create function public.is_trip_owner(p_trip_id uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from trip_members
    where trip_id = p_trip_id and user_id = auth.uid() and role = 'owner'
  )
$$;

-- 「我的行程」集合（security definer 繞過 trip_members 的 RLS 疊加）：
-- 讓 trips 的 SELECT policy 走 semi-join 而非逐列呼叫 is_trip_member，
-- 成本從 O(全站行程數) 降為 O(自己的行程數)
create function public.my_trip_ids() returns setof uuid
language sql security definer stable set search_path = public as $$
  select trip_id from trip_members where user_id = (select auth.uid())
$$;

alter table public.trips enable row level security;
-- owner 條件除了語義上合理（owner 永遠可見自己的行程），也是必要的：
-- INSERT ... RETURNING 的可見性檢查發生在 AFTER trigger 寫入 trip_members 之前，
-- 只靠成員資格會讓「建立行程並取回 id」的標準流程被 RLS 拒絕
create policy "成員可讀行程"
  on public.trips for select to authenticated
  using (owner_id = (select auth.uid()) or id in (select public.my_trip_ids()));
create policy "登入者可建行程（owner 是自己）"
  on public.trips for insert to authenticated with check (owner_id = auth.uid());
create policy "editor 以上可改行程"
  on public.trips for update to authenticated using (public.is_trip_editor(id));
create policy "owner 可刪行程"
  on public.trips for delete to authenticated using (public.is_trip_owner(id));

alter table public.trip_members enable row level security;
create policy "成員可讀成員名單"
  on public.trip_members for select to authenticated using (public.is_trip_member(trip_id));
create policy "owner 可管理成員"
  on public.trip_members for insert to authenticated with check (public.is_trip_owner(trip_id));
-- 排除自己：owner 不能把自己移掉，避免行程變成無人可管的孤兒
create policy "owner 可移除其他成員"
  on public.trip_members for delete to authenticated
  using (public.is_trip_owner(trip_id) and user_id <> (select auth.uid()));
create policy "owner 可調整成員角色"
  on public.trip_members for update to authenticated
  using (public.is_trip_owner(trip_id) and user_id <> (select auth.uid()))
  with check (public.is_trip_owner(trip_id));
create policy "非 owner 成員可自行退出"
  on public.trip_members for delete to authenticated
  using (user_id = (select auth.uid()) and role <> 'owner');

-- 建行程時 owner 自動入 membership（security definer 繞過上面的 insert policy）
create function public.handle_new_trip() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.trip_members (trip_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end $$;

create trigger on_trip_created
  after insert on public.trips
  for each row execute function public.handle_new_trip();

-- ============ stops ============
create table public.stops (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  place_id text,
  is_custom boolean not null default false,
  place_refreshed_at timestamptz,
  timezone text not null check (timezone = 'UTC' or timezone ~ '^[A-Za-z]+(/[A-Za-z0-9_+~-]+){1,2}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  locked boolean not null default false,
  notes text check (notes is null or length(notes) <= 10000),
  estimated_cost numeric(12,2) check (estimated_cost is null or estimated_cost >= 0),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (id, trip_id)  -- 冗餘 unique key，供 legs 的複合 FK 鎖定同行程引用
);
create index stops_trip_id_idx on public.stops (trip_id);

alter table public.stops enable row level security;
create policy "成員可讀停留點"
  on public.stops for select to authenticated using (public.is_trip_member(trip_id));
create policy "editor 以上可增停留點"
  on public.stops for insert to authenticated with check (public.is_trip_editor(trip_id));
create policy "editor 以上可改停留點"
  on public.stops for update to authenticated using (public.is_trip_editor(trip_id));
create policy "editor 以上可刪停留點"
  on public.stops for delete to authenticated using (public.is_trip_editor(trip_id));

-- ============ legs ============
-- 複合 FK (stop_id, trip_id)：資料庫層保證交通段的兩端停留點必屬同一行程
create table public.legs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  from_stop_id uuid not null,
  to_stop_id uuid not null,
  mode text not null check (mode in ('transit', 'walking', 'driving', 'custom')),
  duration_minutes integer check (duration_minutes is null or duration_minutes >= 0),
  distance_meters integer check (distance_meters is null or distance_meters >= 0),
  polyline text,
  detail jsonb,
  source text not null check (source in ('auto', 'manual')),
  stale boolean not null default false,
  computed_at timestamptz,
  estimated_cost numeric(12,2) check (estimated_cost is null or estimated_cost >= 0),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  foreign key (from_stop_id, trip_id) references public.stops (id, trip_id) on delete cascade,
  foreign key (to_stop_id, trip_id) references public.stops (id, trip_id) on delete cascade,
  check (from_stop_id <> to_stop_id)
);
create index legs_trip_id_idx on public.legs (trip_id);
-- FK 欄位 index：沒有它們，刪 stop/trip 會對 legs 全表掃描（實測慢 130-421 倍）
create index legs_from_stop_id_idx on public.legs (from_stop_id, trip_id);
create index legs_to_stop_id_idx on public.legs (to_stop_id, trip_id);

alter table public.legs enable row level security;
create policy "成員可讀交通段"
  on public.legs for select to authenticated using (public.is_trip_member(trip_id));
create policy "editor 以上可增交通段"
  on public.legs for insert to authenticated with check (public.is_trip_editor(trip_id));
create policy "editor 以上可改交通段"
  on public.legs for update to authenticated using (public.is_trip_editor(trip_id));
create policy "editor 以上可刪交通段"
  on public.legs for delete to authenticated using (public.is_trip_editor(trip_id));

-- ============ trip_snapshots ============
create table public.trip_snapshots (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  label text not null,
  snapshot jsonb not null,
  snapshot_version integer not null default 1,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.trip_snapshots enable row level security;
create policy "成員可讀快照"
  on public.trip_snapshots for select to authenticated using (public.is_trip_member(trip_id));
create policy "editor 以上可建快照"
  on public.trip_snapshots for insert to authenticated with check (public.is_trip_editor(trip_id));
create policy "owner 可刪快照"
  on public.trip_snapshots for delete to authenticated using (public.is_trip_owner(trip_id));

-- ============ route_cache（僅伺服器端以 service role 存取；RLS 開啟且不建 policy = 用戶端全拒） ============
create table public.route_cache (
  cache_key text primary key,
  result jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.route_cache enable row level security;
comment on table public.route_cache is
  'server-side only (service_role); RLS enabled with no policies = deny all client access';

-- ============ updated_at / updated_by 自動維護 ============
-- 同時掛 insert 與 update：防止 client 在 INSERT 時竄改 updated_by（共編歸屬顯示的真實性）
create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger stops_touch before update on public.stops
  for each row execute function public.touch_updated_at();
create trigger legs_touch before update on public.legs
  for each row execute function public.touch_updated_at();
create trigger stops_touch_ins before insert on public.stops
  for each row execute function public.touch_updated_at();
create trigger legs_touch_ins before insert on public.legs
  for each row execute function public.touch_updated_at();

-- ============ Realtime 廣播（後續計畫使用，先開好） ============
alter publication supabase_realtime add table public.trips, public.stops, public.legs;
alter table public.stops replica identity full;
alter table public.legs replica identity full;

-- ============ 表級權限（RLS 的前置門檻：沒有 GRANT，policy 根本不會被評估） ============
-- CLI migration 以 postgres 角色執行，不套用 supabase_admin 的 default ACL，必須顯式 GRANT
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete
  on public.profiles, public.trips, public.trip_members,
     public.stops, public.legs, public.trip_snapshots
  to authenticated;
-- route_cache 刻意不 grant 給 authenticated/anon（用戶端全拒）；service_role 全表可用
grant select, insert, update, delete on all tables in schema public to service_role;
revoke all on public.route_cache from anon, authenticated;

commit;
