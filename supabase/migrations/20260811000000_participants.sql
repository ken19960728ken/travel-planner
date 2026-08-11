-- ============ 參與人指派 ============
-- 設計文件：docs/superpowers/specs/2026-08-11-participants-design.md
--
-- ⚠️⚠️ 部署順序（README「migration 與程式碼的部署順序」表的「新程式碼要讀新欄位」列）：
-- **這支 migration 必須先推上雲端，Vercel 程式碼後部署。**
-- 正向（migration 先）：新增欄位對舊程式碼完全透明——舊碼的 select 清單不含這兩個欄位，
-- get_shared_trip 多回兩個鍵也不會讓舊 client 出錯（多餘的鍵被忽略），可安全先行。
-- 反向（程式碼先）：page.tsx 的 select 會指名不存在的欄位 → 查詢整個失敗 → 行程頁「讀取失敗」。
-- 本專案 2026-08-03 已因搞反此順序造成線上故障（stops.category），README 的順序表就是那次補的。
--
-- 【解決什麼問題】現行資料模型三處寫死「整趟行程只有一條時間軸」：
--   legSync.ts:24-30   按時間排序取相鄰配對 → 分頭時生出沒人走過的幻影交通段，真正的段落反而不建立
--   conflicts.ts:21    時間重疊一律報 overlap → 分頭必然重疊，整片紅色警告
--   interpolate.ts:15  播放重疊取最早 → 另一條分支直接消失
-- 本 migration 提供分軌所需的兩個欄位；演算法改動在應用層。

begin;

-- ---------- 名冊：trips.participants ----------
-- [{ "id": uuid, "user_id": uuid|null, "name": text, "color": "#rrggbb" }, ...]
-- user_id 為 null＝無帳號同行者（需求方明確要求「可自己加名字」）。
-- 成員也照存 name：trip_members 沒有 display_name 欄位（init.sql:47-53），且成員退出行程後，
-- 名字仍該留在歷史紀錄裡。
alter table public.trips add column if not exists participants jsonb not null default '[]'::jsonb;

-- 雙重上限，比照 legs_custom_path_shape（20260810000000:48-57）的教訓：
-- 只限元素個數擋不住「20 個元素、每個 1MB」（該次審查實測整欄可達 95MB），而 get_shared_trip
-- 會把這欄吐給匿名訪客，等於一個 editor 成員可以炸掉整個行程的分享頁。
alter table public.trips drop constraint if exists trips_participants_shape;
alter table public.trips
  add constraint trips_participants_shape check (
    jsonb_typeof(participants) = 'array'
    and jsonb_array_length(participants) <= 20
    and length(participants::text) <= 4000
  );

-- ⚠️ trips 是**欄位級**授權（20260803000000_invites_and_grants.sql:83），新欄位不會自動繼承，
-- 必須重下一次涵蓋 participants 的 grant。這與 stops/legs（表級授權，新欄位自動繼承，見
-- 20260803000004_stop_category.sql:10）刻意不同。
-- 漏掉這行的症狀是「儲存沒反應」而非明確報錯——PostgREST 對無權限的欄位是靜默忽略，
-- 不是回 403，所以很難從症狀反推原因。
grant update (title, start_date, end_date, currency, participants) on public.trips to authenticated;

-- ---------- 指派：stops.participant_ids ----------
-- null ＝ 全員。**DB 禁止空陣列**——一種語義只有一種表示，不留 null 與 [] 誰是誰的模糊地帶
-- （雙重表示在下游每個消費端都要各自判斷一次，遲早有人漏掉一邊）。
-- 既有資料全為 null，行為完全不變；這也是選「未指派＝全員」而非「未指派＝無人」的原因。
alter table public.stops add column if not exists participant_ids uuid[];
alter table public.stops drop constraint if exists stops_participant_ids_shape;
alter table public.stops
  add constraint stops_participant_ids_shape check (
    -- ⚠️ 必須用 cardinality 而非 array_length：array_length('{}', 1) 回傳的是 **NULL** 不是 0，
    -- 而 CHECK 在運算式為 NULL 時視為通過——本機實測，用 array_length 寫的版本讓空陣列
    -- 完全通行，「禁止空陣列」的保證形同虛設。cardinality('{}') 回 0，會確實被擋下。
    participant_ids is null or cardinality(participant_ids) between 1 and 20
  );
-- stops 是表級授權（authenticated=arwd，pg_attribute.attacl 為空），新欄位自動繼承
-- INSERT/UPDATE/SELECT，不需 column grant。既有 policy「editor 以上可改停留點」自動涵蓋本欄位。

-- ---------- 新增／更新參與人（在 SQL 端合併，不做 client 端 read-modify-write） ----------
-- 為何是 RPC 而不是 client 讀出整份名冊改完再寫回：後者是典型的 lost update——兩個人同時各自
-- 加一個參與人，後寫入者會把前一個人加的整個蓋掉，而且沒有任何錯誤。jsonb 欄位也無法用
-- 本專案其他地方的 `.eq('updated_at', lockToken)` 樂觀鎖（trips 沒有 updated_at，
-- 且 jsonb 值在 URL 上做等值比對不可靠）。在 SQL 端合併則天然原子。
create or replace function public.upsert_trip_participant(
  p_trip_id uuid, p_id uuid, p_user_id uuid, p_name text, p_color text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_entry jsonb;
begin
  if not public.is_trip_editor(p_trip_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'name required' using errcode = '22023';
  end if;
  -- 名稱長度上限：與 trips_participants_shape 的 4000 字元總量互補。單筆過長會讓總量提早撞頂，
  -- 使用者看到的是「加不進去」而非「這個名字太長」——在這裡明確擋下才給得出有意義的錯誤。
  if length(btrim(p_name)) > 40 then
    raise exception 'name too long' using errcode = '22023';
  end if;

  v_entry := jsonb_build_object(
    'id', p_id, 'user_id', p_user_id, 'name', btrim(p_name), 'color', p_color);

  update public.trips
     set participants = (
       select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
         from (
           -- 既有項目：命中 id 的換成新內容（就地更新，維持原順序＝維持顏色指派順序）
           select case when e->>'id' = p_id::text then v_entry else e end as e, ord
             from jsonb_array_elements(participants) with ordinality as t(e, ord)
           union all
           -- 新項目：原本不存在才附加在最後
           select v_entry, 1e9
            where not exists (
              select 1 from jsonb_array_elements(participants) x where x->>'id' = p_id::text)
         ) merged)
   where id = p_trip_id;
end;
$$;

revoke execute on function public.upsert_trip_participant(uuid, uuid, uuid, text, text) from public;
grant execute on function public.upsert_trip_participant(uuid, uuid, uuid, text, text) to authenticated;

-- ---------- 移除參與人（名冊 + 指派同一交易） ----------
-- 陣列欄位無法設外鍵，名冊移除某人後 participant_ids 不能還指著他。兩個 UPDATE 必須原子，
-- 否則中途失敗會留下指不到人的 id。
create or replace function public.remove_trip_participant(p_trip_id uuid, p_participant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- ⚠️ SECURITY DEFINER 繞過 RLS，權限檢查必須自己做。definer 身分的用意只是讓兩個 UPDATE
  -- 在同一交易內完成，不是要放行給所有人——少了這行，任何登入者都能清空別人行程的名冊。
  if not public.is_trip_editor(p_trip_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- nullif(…, '{}') 是關鍵：最後一個參與人被移除時該停留點回到 null（全員），而不是產生
  -- 會被 stops_participant_ids_shape 擋下的空陣列讓整個交易失敗。
  -- 語義後果：「只有甲會去」的停留點在甲被移除後變成「全員都去」。這是「無法表達 0 人」的
  -- 必然結果，比留下一個沒人參加的孤兒停留點好；UI 在移除前會提示受影響的停留點數量。
  update public.stops
     set participant_ids = nullif(array_remove(participant_ids, p_participant_id), '{}')
   where trip_id = p_trip_id and participant_ids @> array[p_participant_id];

  update public.trips
     set participants = (
       select coalesce(jsonb_agg(e), '[]'::jsonb)
         from jsonb_array_elements(participants) e
        where e->>'id' <> p_participant_id::text)
   where id = p_trip_id;
end;
$$;

revoke execute on function public.remove_trip_participant(uuid, uuid) from public;
grant execute on function public.remove_trip_participant(uuid, uuid) to authenticated;

-- ---------- get_shared_trip 白名單 ----------
-- 函式本體逐字沿用 20260810000000，兩處差異：
--   trip 層多 'participants'（**逐鍵投影**，見下）
--   stop 層多 'participant_ids'
--
-- ⚠️⚠️ participants 絕不可整包吐出：它含 user_id（auth.users 的 UUID），而這個 RPC 對匿名
-- 訪客開放。逐鍵投影成 id/name/color 是硬性要求，share.test.ts 有對應斷言鎖住。
-- 分享頁需要 name/color 是因為它重用同一套 TripView 渲染，不放行的話旅伴看到的播放圖示
-- 會與擁有者不一致。
--
-- create or replace 保留既有 ACL（20260804000000 已實測確認），文末仍成對重申以自我文件化。
create or replace function public.get_shared_trip(p_token uuid) returns jsonb
language sql security definer stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'trip', jsonb_build_object(
      'id', t.id, 'title', t.title, 'start_date', t.start_date,
      'end_date', t.end_date, 'currency', t.currency,
      'participants', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', e->>'id', 'name', e->>'name', 'color', e->>'color'))
        from jsonb_array_elements(t.participants) e), '[]'::jsonb)),
    'stops', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'lat', s.lat, 'lng', s.lng, 'place_id', s.place_id,
        'is_custom', s.is_custom, 'timezone', s.timezone, 'starts_at', s.starts_at,
        'category', s.category,
        'participant_ids', s.participant_ids,
        'ends_at', s.ends_at, 'locked', s.locked,
        'estimated_cost', s.estimated_cost
      ) order by s.starts_at, s.id) from (select * from stops where trip_id = t.id order by starts_at, id limit 500) s), '[]'::jsonb),
    'legs', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'from_stop_id', l.from_stop_id, 'to_stop_id', l.to_stop_id,
        'mode', l.mode, 'duration_minutes', l.duration_minutes,
        'distance_meters', l.distance_meters, 'detail', l.detail,
        'polyline', l.polyline,
        'custom_path', l.custom_path,
        'source', l.source, 'stale', l.stale, 'departs_at', l.departs_at,
        'arrives_at', l.arrives_at, 'estimated_cost', l.estimated_cost,
        'updated_at', l.updated_at
      ) order by l.id) from (select * from legs where trip_id = t.id order by id limit 500) l), '[]'::jsonb)
  )
  from trips t where t.share_token = p_token
$$;

revoke execute on function public.get_shared_trip(uuid) from public;
grant execute on function public.get_shared_trip(uuid) to anon, authenticated;

commit;

-- 回滾（三層，依需要擇一）：
--   僅解除格式限制、保留資料：
--     alter table public.trips drop constraint trips_participants_shape;
--     alter table public.stops drop constraint stops_participant_ids_shape;
--   移除移除用的 RPC：
--     drop function public.remove_trip_participant(uuid, uuid);
--   完整移除欄位（連同所有指派，不可復原）：
--     alter table public.trips drop column participants;
--     alter table public.stops drop column participant_ids;
--
-- ⚠️ 回滾順序：要移除欄位，必須**先**把 get_shared_trip 還原成 20260810000000 的版本——
-- 函式本體引用 t.participants 與 s.participant_ids，欄位不存在時該函式呼叫即報錯，分享頁全面失效。
-- 何時不該回滾：本 migration 對舊版程式碼完全透明，單獨保留無副作用。
