begin;

-- ============ trip_members 提權缺口補完（db-expert 審查 20260803000000 後發現） ============
-- 20260803000000 的 M-2 修復只補了 UPDATE policy 的 with check 白名單，遺漏 INSERT：
-- 「owner 可管理成員」policy 的 with check 只驗 is_trip_owner，未限制新列的 role 值，
-- owner 可直接 insert 一列 role='owner' 造出第二個 owner——UPDATE 白名單形同虛設
-- （PoC 已實測：owner insert (trip_id, stranger_id, 'owner') 成功，trip_members 出現兩個 owner，
-- 且第二個 owner 可反過來刪除第一個 owner——完整帳號接管路徑）。
-- 補上與 UPDATE policy 對稱的白名單，封死這條路徑。
drop policy "owner 可管理成員" on public.trip_members;
create policy "owner 可管理成員"
  on public.trip_members for insert to authenticated
  with check (public.is_trip_owner(trip_id) and role in ('editor', 'viewer'));

-- ============ SECURITY DEFINER search_path 加固（db-expert：pg_temp 未排除的殼層風險） ============
-- search_path 未列 pg_temp 時，Postgres 優先搜尋 pg_temp；若同一 session 能建立同名暫存表
-- （此 app 用戶端僅走 PostgREST/RPC，無裸 SQL 執行權，目前不可觸及此路徑），函式內未綴 schema
-- 前綴的關聯查詢（如 accept_trip_invite 內的 trip_invites/trip_members）就可能被暫存表頂替，
-- 繞過真實表的檢查。依 Postgres 官方建議收斂為縱深防禦；僅處理本 migration 新增的兩個函式，
-- 既有五個 SECURITY DEFINER 函式（20260730000000_init.sql）留待後續任務一併處理。
alter function public.accept_trip_invite(uuid) set search_path = public, pg_temp;
alter function public.regenerate_share_token(uuid) set search_path = public, pg_temp;

commit;
