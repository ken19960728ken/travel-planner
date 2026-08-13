-- ============ 收回 anon 在 public 的授權，讓鐵律在雲端也成立 ============
-- 2026-08-13 在雲端實跑 20260812000000 的稽核函式時查到：**本機與雲端的 anon 授權完全不同**。
--
--   本機（supabase start）  anon 對 public：零表級授權、7 顆函式
--   雲端（Supabase 託管）    anon 對 public：**八張表全部 arwdDxtm（含 TRUNCATE）**、17 顆函式
--
-- 成因是 Supabase 平台在 public schema 預設下了六筆 `alter default privileges`
-- （授予者 postgres 與 supabase_admin 各三筆，涵蓋 tables / functions / sequences），
-- 把 anon、authenticated、service_role 全部一次授足。本機的 CLI 沒有複製這組。
--
-- 【為什麼這件事非修不可】
-- 目前**沒有可利用的洞**——九張表 RLS 全開、34 條 policy 全部 `to authenticated`
-- （anon 沒有任何一條適用）、四顆寫入 RPC 第一行都是 is_trip_editor。但：
--
-- 1. **縱深防禦在雲端等於沒有。** 新增一張表忘了開 RLS、或一條 policy 忘了寫
--    `to authenticated`，那一刻就是全世界可讀可寫——anon key 印在瀏覽器 bundle 裡。
--    GRANT 層本來就是要接住這種失誤的。
--
-- 2. **本專案的 RPC 慣例在雲端是失效的。** 慣例寫法是
--        revoke execute on function … from public;
--        grant  execute on function … to authenticated;
--    在本機正確；在雲端 anon 的 EXECUTE 是 default privileges **顯式**授予的，
--    不是靠 PUBLIC 繼承，`revoke from public` 收不掉。所以**每一顆照慣例寫的新 RPC，
--    在雲端預設就是匿名可呼叫的**。實證：cascade_shift_stops、shift_following_stops、
--    upsert_trip_participant、remove_trip_participant 四顆寫入 RPC 現在都在 anon 清單裡，
--    擋住匿名寫入的只剩每顆函式第一行那個 if。
--
-- 3. **20260812000000 的斷言是假綠燈。** 它斷言「anon 對 public 零寫入權限」，
--    本機成立、雲端不成立。文件說兩層、測試說兩層、實際一層。
--
-- 【驗證方式】本機沒有那六筆 default privileges，直接在本機測等於沒測。
-- 開發時先在本機**重建雲端狀態**（補上 default privileges + 灌滿 anon 授權），
-- 再跑本檔驗證能收乾淨。腳本見 commit 訊息。

begin;

-- ============ 一、default privileges：未來的物件不再自動授權給 anon ============
-- ⚠️ `alter default privileges for role X` 要求執行者是 X 的成員。六筆裡有三筆的授予者是
-- supabase_admin，migration 以 postgres 身分執行時**可能無權修改**。逐筆嘗試、失敗只發
-- warning，不讓整支 migration 因為改不動平台角色的設定而中止——收不掉的部分由
-- invariants.test.ts 的 default_privileges 斷言持續盯著，不會被靜默遺忘。
--
-- 注意：這段**只影響未來建立的物件**，對已存在的表與函式毫無作用（那是下一段的事）。
do $$
declare
  r record;
  obj text;
  failed text[] := '{}';
begin
  for r in
    select ro.rolname as grantor, d.defaclobjtype::text as objtype
      from pg_default_acl d
      join pg_roles ro on ro.oid = d.defaclrole
     where d.defaclnamespace = 'public'::regnamespace
       and exists (
         select 1 from aclexplode(d.defaclacl) a
          where a.grantee = (select oid from pg_roles where rolname = 'anon'))
  loop
    obj := case r.objtype
             when 'r' then 'tables'
             when 'f' then 'functions'
             when 'S' then 'sequences'
             when 'T' then 'types'
           end;
    continue when obj is null;
    begin
      execute format(
        'alter default privileges for role %I in schema public revoke all on %s from anon',
        r.grantor, obj);
    exception when insufficient_privilege then
      -- 只吞權限不足。其他錯誤照樣往上拋，不把真的 bug 靜默掉。
      failed := failed || (r.grantor || '/' || r.objtype);
    end;
  end loop;

  if cardinality(failed) > 0 then
    raise warning
      'default privileges 有 % 筆改不動（權限不足）：%。需以該角色身分執行，或在 Supabase 支援工單處理。invariants.test.ts 會持續標紅。',
      cardinality(failed), failed;
  end if;
end $$;

-- ============ 二、收回 anon 已經拿到的授權 ============
-- 本機的 anon 本來就沒有這些權限，而全套測試在本機是綠的——所以這一段等於把雲端拉回
-- 本機的樣子，不是在發明新狀態。分享頁走 SECURITY DEFINER 的 get_shared_trip（以擁有者
-- 身分讀表），完全不需要 anon 的表授權。
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- ⚠️⚠️ 這行是整支最危險的地方，`from public` 不可省也不可單獨存在。
--   - 少了 `public`：本機那 6 顆 helper 的 proacl 是 NULL（＝ PUBLIC 預設），
--     單獨 `revoke … from anon` 對「靠 PUBLIC 拿到」的權限是**無效的**，本機收不乾淨。
--   - 少了 `anon`：雲端 anon 的授權是 default privileges 顯式給的，`revoke … from public`
--     同樣收不掉。兩邊都要寫，這支 migration 才能在兩個環境產生相同結果。
--   - 但 `from public` 會**連帶收掉 authenticated / service_role 靠 PUBLIC 拿到的 EXECUTE**，
--     下一段必須逐顆補回去。本專案在 20260805000000 踩過這個坑：SECURITY INVOKER 函式
--     在 policy 中求值需要**呼叫者自己**的 EXECUTE 權限，漏掉 grant 會讓全站 Realtime 停擺。
revoke execute on all functions in schema public from public, anon;

-- ============ 三、逐顆補回 EXECUTE（不用萬用字元，漏一顆就是線上故障） ============
-- policy 與 Realtime 會以呼叫者身分求值這些 helper，authenticated 必須有 EXECUTE。
-- service_role 一併給：伺服器端路徑（route proxy、快照）可能直接呼叫。
grant execute on function
  public.is_trip_member(uuid),
  public.is_trip_editor(uuid),
  public.is_trip_owner(uuid),
  public.my_trip_ids(),
  public.trip_roster_ids(uuid),
  public.resolve_stop_participants(uuid[], uuid[]),
  public.trip_id_from_realtime_topic(),
  public.get_shared_trip(uuid)
  to authenticated, service_role;

-- anon 唯一需要的一顆：分享頁。白名單自此只有這一項，「anon 到底能做什麼」一眼看完。
-- （這同時做掉 2026-08-12 critic 審查的 m-4：原本 7 顆裡有 6 顆是從沒 revoke 過的
--   PUBLIC 預設，被上一支 migration 追認成「刻意授權」。）
grant execute on function public.get_shared_trip(uuid) to anon;

-- 寫入類 RPC 早已有給 authenticated 的**顯式**授權，不受上面 revoke from public 影響，
-- 此處不重下以免與各自的 migration 分裂成兩處真相。它們在雲端多出來的 anon 授權，
-- 已由上面的 `revoke … from anon` 收掉。
-- 涉及：accept_trip_invite、regenerate_share_token、cascade_shift_stops、
--       shift_following_stops、upsert_trip_participant、remove_trip_participant。

-- ============ 四、稽核函式補上「實際防線」三個維度 ============
-- 這次最該記的教訓：**20260812000000 驗錯了層。** 它只驗 GRANT，而本機的實際防線是 GRANT、
-- 雲端的實際防線是 RLS——照本機的樣子寫斷言，於是得到一個在雲端完全不成立的綠燈。
-- 補進來的三項就是雲端真正在擋的東西，以及會讓它失效的東西：
--   tables_without_rls  — 任何一張表漏開 RLS，anon 就直接讀寫得到
--   policies_for_role   — 任何一條 policy 忘了寫 `to authenticated`（＝落到 public 角色）
--   default_privileges  — 未來新建物件會不會又自動授權回去
-- 只要這三項有一項非空，「anon 只能讀」就不成立，不管 GRANT 掃出來多乾淨。
--
-- create or replace 保留既有 ACL，不會把上面剛收掉的 anon 授權帶回來。
create or replace function public.role_privilege_audit(p_role text default 'anon') returns jsonb
language sql stable strict security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'table_writes', coalesce((
      select jsonb_agg(t.entry order by t.entry) from (
        select c.relname || ' ' || priv as entry
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
         where n.nspname = 'public'
           and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
           and has_table_privilege(p_role, c.oid, priv)
      ) t
    ), '[]'::jsonb),
    'table_reads', coalesce((
      select jsonb_agg(c.relname::text order by c.relname::text)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and has_table_privilege(p_role, c.oid, 'SELECT')
    ), '[]'::jsonb),
    'column_writes', coalesce((
      select jsonb_agg(t.entry order by t.entry) from (
        select c.relname || '.' || a.attname || ' ' || priv as entry
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          cross join unnest(array['INSERT', 'UPDATE']) priv
         where n.nspname = 'public'
           and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
           and has_column_privilege(p_role, c.oid, a.attnum, priv)
      ) t
    ), '[]'::jsonb),
    'volatile_functions', coalesce((
      select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.provolatile = 'v'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    'writes_in_source', coalesce((
      select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and coalesce(nullif(p.prosrc, ''), pg_get_functiondef(p.oid))
             ~* '\y(insert|update|delete|merge|truncate|copy)\y'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    'functions', coalesce((
      select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    'fingerprints', coalesce((
      select jsonb_object_agg(p.oid::regprocedure::text, substr(md5(pg_get_functiondef(p.oid)), 1, 12))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '{}'::jsonb),
    -- 漏開 RLS 的表。與角色無關，但它是「GRANT 敞開時唯一的防線」有沒有破口的直接答案。
    'tables_without_rls', coalesce((
      select jsonb_agg(c.relname::text order by c.relname::text)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    ), '[]'::jsonb),
    -- 適用於這個角色的 policy。`public` 角色涵蓋所有人（含 anon），所以一併算進來——
    -- 忘記寫 `to authenticated` 的 policy 正是這樣漏的。
    'policies_for_role', coalesce((
      select jsonb_agg((p.tablename || '.' || p.policyname || ' [' || p.cmd || ']')::text
                       order by p.tablename || p.policyname)
        from pg_policies p
       where p.schemaname = 'public'
         and (p.roles @> array[p_role]::name[] or p.roles @> array['public']::name[])
    ), '[]'::jsonb),
    -- 未來新建物件會不會自動授權給這個角色。這是這次事故的根因，必須長期盯著。
    'default_privileges', coalesce((
      select jsonb_agg((ro.rolname || '/' || d.defaclobjtype::text)::text
                       order by ro.rolname || d.defaclobjtype::text)
        from pg_default_acl d join pg_roles ro on ro.oid = d.defaclrole
       where d.defaclnamespace = 'public'::regnamespace
         and exists (select 1 from aclexplode(d.defaclacl) a
                      where a.grantee = (select oid from pg_roles where rolname = p_role))
    ), '[]'::jsonb),
    'scanned', jsonb_build_object(
      'relations', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')),
      'columns',   (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')),
      'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'),
      'policies',  (select count(*) from pg_policies where schemaname = 'public'))
  )
$$;

-- ============ 五、稽核函式自己的授權 ============
-- 雲端的 default privileges 也把它顯式給了 anon 與 authenticated。anon 已由第二段收掉；
-- authenticated 要另外收——它會吐出整份授權佈局，是攻擊者的地圖，沒有理由讓一般登入者拿到。
revoke execute on function public.role_privilege_audit(text) from public, anon, authenticated;
grant execute on function public.role_privilege_audit(text) to service_role;

-- trigger 函式：20260812000000 已從 public 收回，雲端還多一份 default privileges 給
-- authenticated 的顯式授權，一併收乾淨。revoke 不影響 trigger 觸發
-- （PostgreSQL 只在 create trigger 當下檢查 EXECUTE，已隔離實測兩次）。
revoke execute on function
  public.handle_new_trip(),
  public.handle_new_user(),
  public.mark_manual_legs_stale(),
  public.touch_updated_at()
  from authenticated;

commit;

-- 回滾（僅在確認本檔造成線上故障時使用；正常情況不該回滾——回滾＝把單層防禦放回去）：
--   grant all     on all tables    in schema public to anon;
--   grant all     on all sequences in schema public to anon;
--   grant execute on all functions in schema public to public;
--   alter default privileges in schema public grant all on tables    to anon;
--   alter default privileges in schema public grant all on functions to anon;
--   alter default privileges in schema public grant all on sequences to anon;
-- ⚠️ 最可能的故障徵狀是「登入後整站 Realtime 停擺」或「policy 求值失敗導致查詢全空」，
--    那代表第三段漏了某顆 helper。優先做法不是整支回滾，而是補那一顆的 grant。
