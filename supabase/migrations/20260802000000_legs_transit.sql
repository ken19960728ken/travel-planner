begin;

-- flight 加入 mode 白名單（init 的 inline check 自動命名為 legs_mode_check）。
-- 'custom' 保留為「使用者自填的其他交通方式」（spec §4 的 mode 用語），不改名。
alter table public.legs drop constraint if exists legs_mode_check;
alter table public.legs add constraint legs_mode_check
  check (mode in ('transit', 'walking', 'driving', 'flight', 'custom'));

-- 起訖時間，一欄兩用：
--   auto 段  = 計算基準（departs_at := 計算當下的 from_stop.ends_at；arrives_at := departs_at + duration），
--              sync 以「from_stop.ends_at 是否偏離 departs_at」判定需要重算
--   manual/flight 段 = 使用者輸入的真實班次時間（可跨日跨時區；duration_minutes 由起訖導出後冗餘儲存供衝突偵測）
alter table public.legs
  add column departs_at timestamptz,
  add column arrives_at timestamptz,
  add constraint legs_departs_arrives_check
    check (departs_at is null or arrives_at is null or arrives_at > departs_at);

-- 同一有向配對只允許一條交通段（sync 演算法的前提；legs 至今零資料，加約束零風險）
alter table public.legs add constraint legs_from_to_unique unique (from_stop_id, to_stop_id);

-- route_cache 過期清理用索引（sync 每次做有界過期刪除，見 Task 4）
create index route_cache_fetched_at_idx on public.route_cache (fetched_at);

-- spec §4：停留點時間變動時，manual 段標 stale（絕不自動覆蓋/刪除）。
-- 用 DB trigger 而非 client 邏輯：單列編輯、cascade RPC、任何未來寫入路徑一體適用且與交易原子。
--
-- 【審查 C-2，本機已復現 40P01】必須是 statement-level trigger + transition table + 依 id 決定性鎖序：
--   row-level AFTER trigger 在 cascade 語句後逐列 UPDATE legs，與單列 stop 編輯路徑的 legs 鎖序
--   互相顛倒成環（已實測 deadlock）。也不要改成 trigger 內取 advisory lock——反序換一種 deadlock。
--   statement-level trigger 不支援引用列值的 WHEN 條件，時間欄位變動的過濾由 changed CTE 承擔。
create function public.mark_manual_legs_stale() returns trigger
language plpgsql set search_path = public as $$
begin
  with changed as (
    select n.id from new_stops n join old_stops o using (id)
    where (n.starts_at, n.ends_at) is distinct from (o.starts_at, o.ends_at)
  ),
  target as (
    select l.id from public.legs l
    where l.source = 'manual' and l.stale = false
      and exists (select 1 from changed c where l.from_stop_id = c.id or l.to_stop_id = c.id)
    order by l.id
    for update
  )
  update public.legs set stale = true where id in (select id from target);
  return null;
end $$;

create trigger stops_mark_manual_legs_stale
  after update on public.stops
  referencing old table as old_stops new table as new_stops
  for each statement execute function public.mark_manual_legs_stale();

comment on table public.legs is
  '鎖序不變量（Plan 4）：stops_mark_manual_legs_stale 為 statement-level trigger，'
  '以 order by id for update 的決定性順序鎖定 legs 列。任何在單一交易內多列寫入本表的路徑，'
  '必須同樣按 id 排序取列鎖，否則與此 trigger 併發時會 deadlock（40P01 已實測）。'
  'sync 端點刻意逐列寫入（各語句自成交易），不受此限。';

commit;
