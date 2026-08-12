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

-- 順手補齊 search_path（審查 critic m-3 / db-expert m-3 各自查到）：全庫 21 顆函式裡就這四顆
-- 不合專案硬性約束——前三顆是 `search_path=public`（缺 pg_temp）、touch_updated_at 完全沒設，
-- 整個吃呼叫端的設定。手正好按在這四顆上，不補說不過去。
-- 目前不可利用（兩顆 DEFINER 的表引用都有 public. 限定、anon/authenticated 對 public 無
-- CREATE 權限），但這是「下次有人在函式裡少寫一個 public.」就成立的洞。
-- `alter function … set` 冪等、不重建函式本體、不影響既有 trigger 綁定。
alter function public.handle_new_trip() set search_path = public, pg_temp;
alter function public.handle_new_user() set search_path = public, pg_temp;
alter function public.mark_manual_legs_stale() set search_path = public, pg_temp;
alter function public.touch_updated_at() set search_path = public, pg_temp;

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
-- 【掃描範圍：只有 public schema —— 這是誠實面，不是小字】
-- 「anon 只能讀」在**整個資料庫**的層面上目前**並不成立**，只是被 RLS 與 PostgREST 設定救著。
-- 兩位審查員各自實查出 public 以外的 anon 寫入 GRANT：
--   realtime.messages                       INSERT UPDATE   RLS=on   ← 本專案有在用
--   storage.objects / buckets / …           I U D           RLS=on   ← 本專案未使用
--   supabase_functions.hooks / migrations   I U D           RLS=off  ← 未被 PostgREST 暴露
-- 目前擋住的是別的機制：realtime.messages 兩條 policy 都 `to authenticated`（anon 被 RLS 擋死）；
-- storage 的 RLS 開著且無任何 policy；supabase_functions 不在 config.toml 的 exposed schemas。
-- 掃進來只會得到一長串平台管理的雜訊，斷言就沒人看了，所以範圍限在 public——但要知道
-- **這條斷言證明的是「anon 在 public 只能讀」，不是「anon 在整個 DB 只能讀」**。
--
-- ⚠️ 已知的未來地雷（實查 pg_default_acl）：storage / graphql_public / supabase_functions
-- 都有給 anon 的 default privileges，**未來在那些 schema 建的表，anon 自動拿到完整 DML**。
-- 好消息是 public **沒有**任何 anon 的 default acl，所以 public 的斷言不會被未來新表繞過。
-- 啟用 storage 的那一刻就要另開一條斷言，不能等它自己冒出來。
--
-- sequence（relkind 'S'）已納入掃描：`grant update on sequence … to anon` 對 has_table_privilege
-- 的 UPDATE 會回 true，而 INSERT/TRUNCATE 只回 false 不拋錯，加進來零成本零噪音。目前 public
-- 一顆 sequence 都沒有（全 uuid 主鍵），純屬防未來的 bigserial。
--
-- 【p_role 為何可傳】「全空」有兩種可能：真的沒有權限，或**查詢本身瞎了**（上面那個
-- information_schema 的坑就是後者，而且它看起來一模一樣）。開放角色參數後，測試可以拿
-- authenticated 當對照組——它確實有一大票寫入權限，回非空才證明偵測器活著。
-- 沒有這個對照，這顆函式哪天被改壞成恆回空陣列，四條斷言會一起變成永遠的綠燈。
create or replace function public.role_privilege_audit(p_role text default 'anon') returns jsonb
-- strict（= returns null on null input）：審查 db-expert M-2。傳 null 進來時，五個陣列會全部
-- 回空——與「真的沒有權限」一模一樣，五條斷言一起變綠。strict 讓它回 NULL，測試端取欄位
-- 得到 undefined，`expect(undefined).toEqual([])` 直接紅。fail-closed。
language sql stable strict security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    -- 鐵律第 1 條：這兩個陣列必須恆為空
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
      select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.provolatile = 'v'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    -- ⚠️ prosrc 對 SQL standard-body（PG14+ 的 `begin atomic … end`）函式是**空字串**，
    -- regex 恆不命中。那是官方推薦寫法（body 會做依賴追蹤），不是什麼偏門——換句話說
    -- 「有人用標準寫法改寫函式」就會讓這條訊號靜默歸零。改為 prosrc 空時退回
    -- pg_get_functiondef。（審查 critic M-2 / db-expert M-1，兩人各自實測。）
    -- prokind = 'f' 不可省：pg_get_functiondef 對 aggregate 會拋錯，整支稽核跟著死。
    'writes_in_source', coalesce((
      select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and coalesce(nullif(p.prosrc, ''), pg_get_functiondef(p.oid))
             ~* '\y(insert|update|delete|merge|truncate|copy)\y'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    -- 全部改用 regprocedure（帶參數型別的完整簽章）而非 proname：overload 用 proname 會塌成
    -- 兩個一模一樣的字串，靠「長度對不上」才勉強變紅——那是巧合不是設計，錯誤訊息也難讀。
    'functions', coalesce((
      select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    -- ============ fingerprints：唯一擋得住「原地改寫」的一項 ============
    -- 前面三個訊號加上 functions 全等，全部只看得到**新增與移除**。最危險的第三種動作是
    -- `create or replace` 原地改寫既有白名單函式的 body——名字沒變、標成 stable、body 用
    -- begin atomic 讓 prosrc 為空，四項一起綠，沒有任何 review 觸發點（實測：改成轉呼叫一顆
    -- volatile writer，寫入成功而測試全綠）。定義雜湊把「修改」也納進來：任何 anon 可執行
    -- 函式的定義動一個字元，測試就紅。
    -- ⚠️ pg_get_functiondef 的輸出格式綁 PostgreSQL 版本，升級大版本時雜湊會整批變動——
    -- 那是預期行為（去看一眼），不是壞掉。
    'fingerprints', coalesce((
      select jsonb_object_agg(p.oid::regprocedure::text, substr(md5(pg_get_functiondef(p.oid)), 1, 12))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ), '{}'::jsonb),
    -- ============ scanned：讓這顆函式自證「我真的有在看東西」 ============
    -- has_*_privilege 對不存在的角色會拋錯（fail-closed），但那道保險**只在掃描產出列時**
    -- 才被求值。條件寫壞（nspname 打成 'pubic'、relkind 條件寫反）時掃描回零列，五個陣列
    -- 一起變 []，與「真的沒有權限」無從區分。分母非零才代表偵測器活著。
    -- （審查 db-expert m-1；authenticated 對照組只覆蓋 table_writes/column_writes 兩項，
    --  補不上函式那三項，所以需要這個獨立的分母。）
    'scanned', jsonb_build_object(
      'relations', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')),
      'columns',   (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')),
      'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'))
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
