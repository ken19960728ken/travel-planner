-- ============ 鐵律：未登入身分只能讀，不能寫 ============
-- 使用者 2026-08-01 提出、2026-08-12 定案的系統鐵律：
--   1. 共同編輯一律要求成員身分；匿名使用者若未來要能編輯，只能編輯不屬於任何帳號的獨立副本。
--   2. 任何授予未登入身分（anon）的函式，必須是唯讀的。
--
-- 第 1 條在授權層已是現實（anon 對 public 全部資料表零寫入權限）。第 2 條是**必要的補丁**：
-- 表級授權擋不住 SECURITY DEFINER 函式——`get_shared_trip` 正是「anon 對表零權限、卻拿得到
-- 整份行程」的例子。少了第 2 條，哪天有人為了方便寫一顆「訪客可留言」的匿名可寫函式，
-- 前面九張表的零權限全部白費。
--
-- 本檔做兩件事：把既有的違規清掉、留下一顆可重跑的稽核函式讓斷言長期成立。

begin;

-- ============ 一、trigger 函式收回 PUBLIC 的預設 EXECUTE ============
-- `create function` 的預設是 `grant execute to public`，這六顆 trigger 函式裡有四顆從未 revoke，
-- 於是 anon 對它們有 EXECUTE。實測**不可利用**（都是 `returns trigger`：PostgREST 不暴露這類
-- 函式，直接在 SQL 呼叫回 `trigger functions can only be called as triggers`），但其中
-- handle_new_trip／handle_new_user 是 SECURITY DEFINER 且會寫表，留著等於把地雷放進斷言的
-- 例外清單裡——例外清單一長，下一顆真正該擋的就混得進去。
--
-- ⚠️ revoke 會不會害 trigger 不觸發？**不會，已隔離實測**：造一張表掛 trigger、把函式的
-- EXECUTE 從角色收乾淨（`has_function_privilege` 確認為 false），以該角色 UPDATE，trigger
-- 照樣執行。PostgreSQL 只在 `create trigger` 當下檢查 EXECUTE，觸發時不再檢查。
--
-- check_trip_candidates_immutable／check_trip_candidates_limit 不在此列——它們的 migration
-- 已經 revoke 過，此處沿用同一慣例。
revoke execute on function public.handle_new_trip() from public;
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.mark_manual_legs_stale() from public;
revoke execute on function public.touch_updated_at() from public;

-- ============ 二、稽核函式 ============
-- 寫在文件裡的規則會被忘記，能被機器檢查的才叫鐵律。這顆函式回一份指定角色（預設 anon）的
-- 權限快照，供 `src/lib/supabase/invariants.test.ts` 斷言，也供部署後在 Supabase SQL Editor
-- 直接重跑（`select public.role_privilege_audit();`）——雲端與本機用的是同一份判準。
--
-- ⚠️⚠️ 【為何不用 information_schema.role_table_grants】那些 view 只列出「當前角色是授予者、
-- 被授予者、或其成員」的權限。service_role 不是 anon 的成員，所以查出來**永遠是空的**——
-- 斷言會 fail-open：不管 anon 被授予了什麼，測試都是綠的。
-- 實測（本機，同一筆 `grant insert on t to anon` + `grant update (col) on t to anon`）：
--   information_schema  → 0 筆   ← 完全沒看到
--   has_table_privilege → 1 筆
--   has_column_privilege→ 3 筆
-- 因此一律走 has_*_privilege 系列，它們不做角色成員過濾。
--
-- 欄位級要單獨掃：本專案用過欄位級授權（20260811000000 的 `grant update (title, …) on trips`），
-- 而 has_table_privilege 只看表級，漏掉欄位級的話「只給 anon 改一欄」會整個看不見。
--
-- 【掃描範圍：只有 public schema】刻意的。Supabase 平台自己會授予 anon 一批 storage／
-- realtime／graphql_public 的權限，掃進來會有一長串平台管理的雜訊，斷言就沒人看了。
-- 本專案的資料全在 public，且未使用 storage。**若日後開始用 storage，這條斷言不覆蓋它。**
-- 同理未涵蓋 sequence 的 USAGE（沒有表的 INSERT 權限時，能 nextval 也寫不進東西）。
--
-- 【p_role 為何可傳】「全空」有兩種可能：真的沒有權限，或**查詢本身瞎了**（上面那個
-- information_schema 的坑就是後者，而且它看起來一模一樣）。開放角色參數後，測試可以拿
-- authenticated 當對照組——它確實有一大票寫入權限，回非空才證明偵測器活著。
-- 沒有這個對照，這顆函式哪天被改壞成恆回空陣列，四條斷言會一起變成永遠的綠燈。
create or replace function public.role_privilege_audit(p_role text default 'anon') returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    -- 鐵律第 1 條：這兩個陣列必須恆為空
    'table_writes', coalesce((
      select jsonb_agg(t.entry order by t.entry) from (
        select c.relname || ' ' || priv as entry
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
         where n.nspname = 'public'
           and c.relkind in ('r', 'p', 'v', 'm', 'f')
           and has_table_privilege(p_role, c.oid, priv)
      ) t
    ), '[]'::jsonb),
    'column_writes', coalesce((
      select jsonb_agg(t.entry order by t.entry) from (
        select c.relname || '.' || a.attname || ' ' || priv as entry
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          cross join unnest(array['INSERT', 'UPDATE']) priv
         where n.nspname = 'public'
           and c.relkind in ('r', 'p', 'v', 'm', 'f')
           and has_column_privilege(p_role, c.oid, a.attnum, priv)
      ) t
    ), '[]'::jsonb),
    -- ============ 鐵律第 2 條的三個訊號 ============
    -- ⚠️ 先講清楚哪個才是真正的把關：**functions 全等斷言**。volatile_functions 與
    -- writes_in_source 是輔助訊號，兩者都可以被繞過，別把它們當成唯讀的證明。
    --
    -- volatile_functions：provolatile 'i'=immutable、's'=stable、'v'=volatile。
    -- PostgreSQL 在**呼叫時**（不是建立時）對非 volatile 函式擋 DML，錯誤訊息是
    -- `INSERT is not allowed in a non-volatile function`。
    -- **但這不是唯讀證明——實測可繞**：STABLE 函式裡 `perform` 一顆 VOLATILE 函式，
    -- 該 VOLATILE 函式的 INSERT 會成功寫入。唯讀模式不會沿呼叫鏈傳遞。
    -- （函式間的呼叫關係不進 pg_depend，catalog 查不到，所以這個遞移閉包沒有便宜的機檢法。）
    --
    -- writes_in_source：掃 prosrc 的 DML 關鍵字，補上「有人把既有白名單函式改成會寫」
    -- 這個 volatile 檢查漏掉的情境（改成 volatile 才會被上一項抓到，但他也可以不改標記
    -- 而用上述的巢狀繞法）。同樣可繞——動態 SQL、或呼叫別的函式都躲得掉。
    --
    -- 真正堵住剩餘風險的是**人**：functions 是全等斷言，任何新增／移除都會讓測試變紅，
    -- 改白名單的人必須來看一眼。三個機檢訊號的作用是讓「不小心」擋在門外，
    -- 「刻意」則交給那一次 review。
    'volatile_functions', coalesce((
      select jsonb_agg(p.proname::text order by p.proname::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.provolatile = 'v'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    'writes_in_source', coalesce((
      select jsonb_agg(p.proname::text order by p.proname::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prosrc ~* '\y(insert|update|delete|merge|truncate)\y'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    'functions', coalesce((
      select jsonb_agg(p.proname::text order by p.proname::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb)
  )
$$;

-- 稽核結果本身會透露授權佈局，只給 service_role（它本來就能看整個 catalog，不擴大攻擊面）。
-- 特別注意：**不可**授予 anon——那會讓這顆函式出現在它自己的 functions 清單裡。
revoke execute on function public.role_privilege_audit(text) from public;
grant execute on function public.role_privilege_audit(text) to service_role;

commit;

-- 回滾：
--   drop function if exists public.role_privilege_audit(text);
--   grant execute on function public.handle_new_trip(), public.handle_new_user(),
--     public.mark_manual_legs_stale(), public.touch_updated_at() to public;
-- （回滾第二段只是還原成「預設就有的多餘授權」，功能上不需要，列出僅為完整性）
