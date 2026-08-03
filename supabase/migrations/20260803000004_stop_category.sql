begin;

-- ============ stops.category（Plan 7 Task 2） ============
-- 我方六值分類 slug（transport/sight/food/lodging/shopping/other），單一事實來源見
-- src/lib/domain/placeCategory.ts；DB 只存本檔六值，不存 Google raw types/primaryType（ToS 紅線）。
--
-- 不需要任何 GRANT：pg_class.relacl 顯示 stops 是表級 authenticated=arwd（非 trips/trip_candidates
-- 的欄位級白名單），且 pg_attribute.attacl 對 stops 目前完全為空（無任何欄位級 ACL，實測見
-- docs/superpowers/plans/2026-08-01-travel-planner-categories.md 事實一）。新欄位在表級授權下
-- 自動繼承 INSERT/UPDATE/SELECT，不需額外 grant column 語句——這與 trips（title/start_date/
-- end_date/currency 欄位級 UPDATE 白名單，見 20260803000000_invites_and_grants.sql）、
-- trip_candidates（INSERT/UPDATE 皆走欄位白名單，見 20260803000003_trip_candidates.sql）
-- 刻意不同：後兩者已收緊到欄位級，新欄位需顯式補 grant 才可寫入；stops 尚未收緊，維持表級即可。
--
-- 用 text + check 不用 enum type：沿用本專案既有慣例（trip_candidates.category 同作法），
-- 避免 enum 型別在 migration 間新增/刪除值時的鎖表與相容性成本。
--
-- 既有列一律回填 'other'：無法回填成真實分類——建立當時未存 Google types/primaryType
-- （ToS 不允許為了回填而重新呼叫 Places API 取得分類依據），僅能落預設值，待使用者手動編輯。
--
-- PG 11+ 對 add column ... not null default 走 metadata-only 路徑，不重寫既有資料列、
-- 不長時間鎖表，零停機。
alter table public.stops add column category text not null default 'other'
  constraint stops_category_check
  check (category in ('transport','sight','food','lodging','shopping','other'));

-- 回滾路徑：
--   僅解除格式限制、保留資料：alter table public.stops drop constraint stops_category_check;
--   完整移除欄位（連同資料）：alter table public.stops drop column category;

commit;
