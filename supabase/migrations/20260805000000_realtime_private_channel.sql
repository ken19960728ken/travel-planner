-- Realtime 私有頻道授權（C-1 Critical 根治，2026-08-04 critic 審查 + PoC 實證：
-- scratchpad/rt-anon-poc.mjs、rt-presence-crash.mjs；db-expert 複審實測見下方各段）。
--
-- ⚠️⚠️ 部署順序（與一般流程相反，比照 README「migration 與程式碼的部署順序」表格的
-- 「新程式碼要讀新欄位／新表」列——這裡是「新程式碼依賴新權限」的同類情形）：
-- **這支 migration 必須先推上雲端，Vercel 程式碼（TripRealtime.tsx 改 private:true）後部署。**
-- 兩個方向都經 db-expert 實測：policy 先套用 + 舊版 public channel 程式碼 → 三種身分皆照常運作
-- （對舊碼完全透明，可安全先行）；policy 未套用 + private:true 程式碼 → **合法成員也被拒**
-- （CHANNEL_ERROR），Realtime 整個死掉、斷線橫幅永遠亮著。
--
-- 背景：舊版 TripRealtime.tsx 用 public channel（config 未設 private）。topic 名稱 `trip:{tripId}`
-- 不是機密——tripId 會出現在分享頁的 RSC payload、瀏覽網址、被移除成員的瀏覽紀錄等處（PoC 實測
-- 確認）。Public channel 對 join 沒有任何授權檢查：任何持有公開 anon key 的人（無需登入）都能
-- join 任一 trip 的頻道並偽造 presence payload（缺必要欄位），讓所有正在看該頻道的合法成員頁面
-- 在 render 期對 undefined 呼叫 .slice() 而整頁崩潰（另一顆 commit 已在 client 端加上防禦性型別
-- 守衛止血；這支 migration 是根治——未登入者從此完全無法 join）。
--
-- 【三種 extension 的真實語義——db-expert 逐一排列實測，勿依直覺修改】
-- 這三者是**互相獨立的三件事**，不是「各探測一次、少一種就整個被拒」（初版註解如此宣稱，實測為錯）：
--   * `broadcast`        —— **唯一決定「能不能 join」的閘門**。本專案完全不送 broadcast 訊息，
--                           但**不可移除**：拿掉它，合法成員一律 CHANNEL_ERROR。
--   * `presence`         —— 決定 join 之後 presence 讀取是否啟用。**拿掉它最危險**：join 照樣
--                           SUBSCRIBED、沒有任何 error、沒有 system 事件，但頭像列永遠空的、
--                           presenceState() 恆為空——正是 TripRealtime.tsx 的斷線橫幅設計明文要防的
--                           「靜默失聰」。維護者最容易因為「我們只用 presence 和 postgres_changes」
--                           這個直覺而砍錯東西，故兩者都保留在單內並在此標明。
--   * `postgres_changes` —— **對 join 與資料流皆無作用**，故意不列入（最小權限）。它的資料授權
--                           完全走各資料表自己的 RLS，與本 policy 無關。db-expert 決定性交叉驗證：
--                           把成員判斷拿掉讓非成員 join 成功後，非成員對 stops INSERT 仍收到 0 筆。
-- INSERT policy 只需 `presence`：client 端唯一送出的訊息型別就是 track()。改成 broadcast 或移除，
-- join 仍成功但 track() 靜默失敗。

begin;

-- 從 channel topic（TripRealtime.tsx 固定用 `trip:{tripId}` 格式）萃取 tripId。
-- 正則已錨定且無巢狀量詞（無 ReDoS）；substring 不匹配時回傳 null、null::uuid 不拋例外，
-- is_trip_member(null) 實測恆為 false（`select exists(...)` 永不回 null）——12 種畸形 topic
-- （空字串、5000 字元、含換行、雙行注入、前後綴多字元…）實測零例外、零誤放行。
--
-- **`set search_path = public, pg_temp` 不可省**（db-expert M-2，已 PoC）：pg_temp 對 relation 與
-- **資料型別名稱**會被優先搜尋，`create temp table uuid (x int)` 可遮蔽 `::uuid` 這個 cast，讓 policy
-- 評估直接拋 "return type mismatch"。今天不可達（Realtime 連線不收 client SQL、PostgREST 不給 DDL），
-- 屬縱深防禦；但本專案先前已為同類 search_path 劫持開過專門 migration（20260803000001），沿用該慣例。
--
-- **stable 不可改成 immutable**：immutable 會讓 planner 在計畫期常數摺疊，造成跨 topic 的授權串接。
create or replace function public.trip_id_from_realtime_topic() returns uuid
language sql stable set search_path = public, pg_temp as $$
  select substring(
    realtime.topic() from '^trip:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
  )::uuid
$$;

-- 權限：沿用專案慣例（20260803000005:48-52 等五處）——先 revoke from public 再顯式 grant。
-- ⚠️ **這兩行必須成對，漏掉 grant 會讓全站 Realtime 停擺**（db-expert 實測：revoke from
-- authenticated 後合法成員立刻 CHANNEL_ERROR）。原因是本函式為 **SECURITY INVOKER**，policy 求值時
-- 以 authenticated 身分執行，需要它自己的 EXECUTE 權限——與 is_trip_member（SECURITY DEFINER）
-- 性質不同，別套同一套直覺。
revoke execute on function public.trip_id_from_realtime_topic() from public;
grant execute on function public.trip_id_from_realtime_topic() to authenticated;

-- is_trip_member 等四顆 helper 補上 pg_temp（db-expert M-3，已 PoC 打穿）：它們是
-- `security definer set search_path = public`（無 pg_temp），函式體用未限定的 `from trip_members`，
-- 實測 `create temp table trip_members(...)` + 自插一列可讓非成員的 is_trip_member() 回 true。
-- 這是既有缺口（20260803000001 當時只補了 accept_trip_invite / regenerate_share_token 兩顆），
-- 但本 migration 讓 is_trip_member 第一次在 Realtime 的資料庫連線這個新執行脈絡下被求值、
-- 且用它取代一個已被 PoC 打穿的安全邊界，故一併補齊。純加固，不改任何函式邏輯。
alter function public.is_trip_member(uuid) set search_path = public, pg_temp;
alter function public.is_trip_editor(uuid) set search_path = public, pg_temp;
alter function public.is_trip_owner(uuid) set search_path = public, pg_temp;
alter function public.my_trip_ids() set search_path = public, pg_temp;

-- drop if exists 讓整支檔案可安全重跑（db-expert M-4）：本專案實務上存在繞過 CLI 手動貼 SQL 的情況，
-- 而依 M-1 調整 extension 清單時一定要先 drop。裸 create policy 重跑會炸掉整個 transaction
-- （交易邊界正確，不留半套狀態，但錯誤訊息會指向與當次改動無關的地方）。
drop policy if exists "trip 成員可接收自己行程頻道的訊息" on realtime.messages;
drop policy if exists "trip 成員可送出自己行程頻道的 presence" on realtime.messages;

-- 沿用既有 is_trip_member()——與 stops/legs 等表的既有 RLS 判準同一顆函式，成員資格變動
-- （加入/移除）立即對**新的 join** 生效。
-- ⚠️ 既有連線有殘留窗口（db-expert s-1 實測）：Realtime 只在 join 當下與 token 重新授權時評估
-- channel 授權，不做持續重驗——成員被移除後，其既有連線仍可讀到 presence（實測 28 秒以上，直到
-- JWT 換發或重連）。外洩面僅限「當前線上成員的 displayName」。對照組 postgres_changes 無此問題：
-- 資料授權逐列走 public.stops 的 RLS，被移除者在同一實驗中對 4 筆 INSERT 收到 0 個事件。
create policy "trip 成員可接收自己行程頻道的訊息"
  on realtime.messages for select to authenticated
  using (
    extension in ('presence', 'broadcast')
    and public.is_trip_member(public.trip_id_from_realtime_topic())
  );

create policy "trip 成員可送出自己行程頻道的 presence"
  on realtime.messages for insert to authenticated
  with check (extension = 'presence' and public.is_trip_member(public.trip_id_from_realtime_topic()));

commit;

-- 回滾（三行，已實測可執行；順序不可顛倒——先 policy 後 function，反過來會因依賴而安全失敗）：
--   drop policy "trip 成員可接收自己行程頻道的訊息" on realtime.messages;
--   drop policy "trip 成員可送出自己行程頻道的 presence" on realtime.messages;
--   drop function public.trip_id_from_realtime_topic();
-- ⚠️ **回滾必須與 private:true 的程式碼一同回滾**：實測 policy 移除後、private:true 程式碼仍在線時，
-- 合法成員一律 CHANNEL_ERROR。
-- 何時不該回滾：這支 migration 對舊版（public channel）程式碼完全透明，單獨存在無副作用；
-- 本專案目前無其他 private channel 使用者，`to authenticated` 不會誤傷其他場景。
-- 上面四顆 helper 的 pg_temp 加固**刻意不列入回滾**：純安全加固、對所有既有呼叫端透明，
-- 回滾等於把已 PoC 證實的劫持路徑放回去。
