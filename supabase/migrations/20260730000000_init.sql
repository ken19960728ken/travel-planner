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

-- 註冊時自動建立 profile
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ trips ============
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_date date not null,
  end_date date not null,
  currency text not null default 'TWD',
  owner_id uuid not null references auth.users(id) default auth.uid(),
  share_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- ============ trip_members ============
create table public.trip_members (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

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

alter table public.trips enable row level security;
-- owner 條件除了語義上合理（owner 永遠可見自己的行程），也是必要的：
-- INSERT ... RETURNING 的可見性檢查發生在 AFTER trigger 寫入 trip_members 之前，
-- 只靠 is_trip_member 會讓「建立行程並取回 id」的標準流程被 RLS 拒絕
create policy "成員可讀行程"
  on public.trips for select to authenticated
  using (public.is_trip_member(id) or owner_id = auth.uid());
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
create policy "owner 可移除成員"
  on public.trip_members for delete to authenticated using (public.is_trip_owner(trip_id));

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
  lat double precision not null,
  lng double precision not null,
  place_id text,
  is_custom boolean not null default false,
  place_refreshed_at timestamptz,
  timezone text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  locked boolean not null default false,
  notes text,
  estimated_cost numeric,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
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
create table public.legs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  from_stop_id uuid not null references public.stops(id) on delete cascade,
  to_stop_id uuid not null references public.stops(id) on delete cascade,
  mode text not null check (mode in ('transit', 'walking', 'driving', 'custom')),
  duration_minutes integer,
  distance_meters integer,
  polyline text,
  detail jsonb,
  source text not null check (source in ('auto', 'manual')),
  stale boolean not null default false,
  computed_at timestamptz,
  estimated_cost numeric,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index legs_trip_id_idx on public.legs (trip_id);

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

-- ============ updated_at 自動更新 ============
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
