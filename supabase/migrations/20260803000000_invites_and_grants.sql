begin;

-- ============ trip_invites：id 即邀請 token（gen_random_uuid = 122 bit 隨機，不可枚舉） ============
-- 撤銷 = 刪除列（不設 revoked_at；Simplicity First）。多次可用直到過期/撤銷（貼到群組聊天的真實用法）。
create table public.trip_invites (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index trip_invites_trip_id_idx on public.trip_invites (trip_id);

alter table public.trip_invites enable row level security;
-- 僅 owner 可管理與檢視邀請（editor/viewer/非成員一律不可見——token 本身就是機密）。
-- insert 的 with check 同時封頂效期 30 天（用 policy 而非 CHECK 約束：now() 非 IMMUTABLE，
-- CHECK 內用 now() 是未定義行為的溫床；policy 每次寫入時評估，語義正確）
create policy "owner 可讀邀請"
  on public.trip_invites for select to authenticated using (public.is_trip_owner(trip_id));
create policy "owner 可建邀請"
  on public.trip_invites for insert to authenticated
  with check (public.is_trip_owner(trip_id) and expires_at <= now() + interval '30 days');
create policy "owner 可撤銷邀請"
  on public.trip_invites for delete to authenticated using (public.is_trip_owner(trip_id));

grant select, insert, delete on public.trip_invites to authenticated;
-- 刻意不 grant anon；service_role 必須顯式補——init 的 grant all on all tables 是一次性快照，
-- 不涵蓋未來新表（Plan 1 教訓：無 GRANT 則 policy 根本不被評估）
grant select, insert, update, delete on public.trip_invites to service_role;

-- ============ 接受邀請 RPC ============
-- 語義：無效/過期一律回 null（不區分原因，不給 token 枚舉者訊號）；
-- 已是成員 on conflict do nothing（不升不降——角色調整是 owner 在成員面板的權力）。
create function public.accept_trip_invite(p_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_trip_id uuid;
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select trip_id, role into v_trip_id, v_role
    from trip_invites where id = p_token and expires_at > now();
  if not found then
    return null;
  end if;
  insert into trip_members (trip_id, user_id, role)
    values (v_trip_id, auth.uid(), v_role)
    on conflict (trip_id, user_id) do nothing;
  return v_trip_id;
end $$;
-- SECURITY DEFINER 函式預設 execute 授予 public——必須顯式收回再只給 authenticated
revoke execute on function public.accept_trip_invite(uuid) from public, anon;
grant execute on function public.accept_trip_invite(uuid) to authenticated;

-- ============ trip_members 角色提權缺口（審查 M-2） ============
-- 既有 policy 的 with check 只驗 is_trip_owner，未限制新值：owner 可把成員 role 改成 'owner'
-- 造成多 owner（不可移除、不可降級——owner 保護規則反而把提權鎖死）。重建 policy：
-- with check 補「不能改自己 + 新角色只能是 editor/viewer」。owner 轉移屬後續迭代（spec §8）。
drop policy "owner 可調整成員角色" on public.trip_members;
create policy "owner 可調整成員角色"
  on public.trip_members for update to authenticated
  using (public.is_trip_owner(trip_id) and user_id <> (select auth.uid()))
  with check (
    public.is_trip_owner(trip_id)
    and user_id <> (select auth.uid())
    and role in ('editor', 'viewer')
  );

-- ============ trips 寫入面收緊（共編上線的前置）：欄位級 GRANT ============
-- 現行 UPDATE policy（editor 以上可改行程）無欄位限制，editor 可竄改 share_token/owner_id。
-- RLS 不能做欄位級控制，用 GRANT 收斂：authenticated 只能改四個計畫欄位；
-- share_token 重生成改走下方 owner-only RPC；owner_id 任何 client 均不可改。
-- 注意：表級/欄位級 GRANT 只約束以呼叫者身分執行的語句；SECURITY DEFINER 函式（如下方
-- regenerate RPC）與 policy 內部的判斷函式（is_trip_owner 等）以定義者身分執行，
-- 不受本節 revoke 影響——收緊不會弄壞既有 policy。
-- 回滾（單條 SQL，寫進本 migration 的 commit 訊息與 README 部署段）：
--   grant update on public.trips to authenticated;                                    -- 還原欄位收緊
--   revoke execute on function public.accept_trip_invite(uuid) from authenticated;    -- 應急停用邀請
revoke update on public.trips from authenticated;
grant update (title, start_date, end_date, currency) on public.trips to authenticated;

create function public.regenerate_share_token(p_trip_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_token uuid;
begin
  if not public.is_trip_owner(p_trip_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update trips set share_token = gen_random_uuid() where id = p_trip_id
    returning share_token into v_token;
  return v_token;
end $$;
revoke execute on function public.regenerate_share_token(uuid) from public, anon;
grant execute on function public.regenerate_share_token(uuid) to authenticated;

commit;
