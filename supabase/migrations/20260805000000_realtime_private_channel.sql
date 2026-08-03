-- Realtime 私有頻道授權（C-1 Critical 根治，2026-08-04 critic 審查 + PoC 實證：
-- scratchpad/rt-anon-poc.mjs、rt-presence-crash.mjs）。
--
-- ⚠️⚠️ 部署順序（與一般流程相反，比照 README「migration 與程式碼的部署順序」表格的
-- 「新程式碼要讀新欄位／新表」列——這裡是「新程式碼依賴新權限」的同類情形）：
-- **這支 migration 必須先推上雲端，Vercel 程式碼（TripRealtime.tsx 改 private:true）後部署。**
-- 原因：join 私有頻道（config.private = true）需要 realtime.messages 有對應的 RLS policy 才會放行；
-- 若程式碼先上線、這支 migration 還沒套用，realtime.messages 是「RLS enabled 但 0 條 policy」的
-- 預設全拒狀態，所有使用者（含合法成員）都會 join 失敗（CHANNEL_ERROR）——Realtime 整個死掉，
-- 斷線橫幅永遠亮著、旁人變動永遠收不到。這支 migration 本身對舊版（public channel）程式碼完全
-- 透明（舊碼不會 join private channel，不會用到這些 policy），故單獨先套用無害，可安全先行。
--
-- 背景：舊版 TripRealtime.tsx 用 public channel（config 未設 private）。topic 名稱 `trip:{tripId}`
-- 不是機密——tripId 會出現在分享頁的 RSC payload、瀏覽網址、被移除成員的瀏覽紀錄等處（PoC 實測
-- 確認）。Public channel 對 join 沒有任何授權檢查：realtime.messages 雖然 RLS enabled，但那只
-- 約束「private channel」；public channel 的 presence 完全略過該表，任何持有公開 anon key 的人
-- （無需登入）都能 join 任一 trip 的頻道並偽造 presence payload（缺必要欄位），讓所有正在看該
-- 頻道的合法成員頁面在 render 期對 undefined 呼叫 .slice() 而整頁崩潰（另一顆 commit 已在
-- client 端加上防禦性型別守衛止血；這支 migration 是根治——未登入者從此完全無法 join）。
--
-- 【實測修正官方文件的簡化敘述】官方文件字面上說 postgres_changes 的資料授權與 realtime.messages
-- 無關（只走被訂閱資料表本身的 RLS）——這點沒錯，但 private channel 的「能不能 join」本身另有一層
-- 連線層級授權檢查，且經本機 PoC 反覆驗證（scratchpad/verify-private-channel.mjs，逐一切換
-- extension 值的排列測試）：**private channel 的 join 探測會對 presence / postgres_changes /
-- broadcast 三種 extension 各自探測一次**，即使本專案的 TripRealtime.tsx 只用到 presence 與
-- postgres_changes（完全不用 broadcast），SELECT policy 若只涵蓋其中一兩種 extension，join 仍會
-- 整個被拒（"Unauthorized: You do not have permissions to read from this Channel topic"）；
-- 三種都涵蓋後 join 才會成功，且成功後 postgres_changes 的實際資料流仍正確地只受各資料表自己的
-- RLS 約束（本 migration 未改動 stops/legs/trips 的既有 policy，PoC 已交叉驗證）。INSERT
-- policy 則只需涵蓋 presence（本專案唯一會送出的 client-to-server 訊息型別，track() 呼叫）。

begin;

-- 從 channel topic（TripRealtime.tsx 固定用 `trip:{tripId}` 格式）萃取 tripId。
-- 正則已限定合法 UUID 的字元集與分組長度，substring 不匹配時回傳 null、null::uuid 不拋例外，
-- is_trip_member(null) 恆為 false（trip_id = null 的比較恆非真）——不匹配的 topic 一律安全拒絕，
-- 不會讓 policy 評估過程本身出錯。
create or replace function public.trip_id_from_realtime_topic() returns uuid
language sql stable as $$
  select substring(
    realtime.topic() from '^trip:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
  )::uuid
$$;

-- 沿用既有 is_trip_member()——與 stops/legs 等表的既有 RLS 判準同一顆函式，成員資格變動
-- （加入/移除）立即對新的 join 生效，不必另外維護一份判斷邏輯。anon 完全不在 to 清單內：
-- 未登入者現在連 join 這個 private channel 都會被拒絕（CHANNEL_ERROR），不是「join 成功但看不到
-- presence」——因為 join 私有頻道本身就需要可套用的 select policy 才會放行（見上方實測說明）。
create policy "trip 成員可接收自己行程頻道的訊息"
  on realtime.messages for select to authenticated
  using (
    extension in ('presence', 'postgres_changes', 'broadcast')
    and public.is_trip_member(public.trip_id_from_realtime_topic())
  );

-- 只需 presence：本專案的 client 端只呼叫 channel.track()（presence），從不送出 broadcast。
create policy "trip 成員可送出自己行程頻道的 presence"
  on realtime.messages for insert to authenticated
  with check (extension = 'presence' and public.is_trip_member(public.trip_id_from_realtime_topic()));

commit;

-- 回滾（drop policy 不影響 postgres_changes 的資料授權，只影響 private channel 的 join/presence；
-- 單獨執行即安全）：
--   drop policy "trip 成員可接收自己行程頻道的訊息" on realtime.messages;
--   drop policy "trip 成員可送出自己行程頻道的 presence" on realtime.messages;
--   drop function public.trip_id_from_realtime_topic();
-- 應急停用（若確認問題來自這支 migration，但程式碼已部署 private:true 來不及一起回滾）：
-- 上面兩條 policy 保留，只需確認程式碼與 policy 同時存在即可正常運作，通常不需要回滾這支 migration；
-- 唯一需要回滾的情境是這支 migration 本身有其他非預期副作用（例如 to authenticated 誤傷其他既有
-- private channel 使用場景——本專案目前無其他 private channel 使用者，風險為零）。
