begin;

-- 目的（C-1）：部署前的 parseComputeRoutesResponse 會把 Google 對 TRANSIT 請求退化成純步行的回應
-- 誤判為正常大眾運輸路線，把步行時長原樣寫進 duration_minutes、掛著「大眾運輸」標籤（日本大眾運輸
-- fallback 修正的既有壞資料）。route_cache 已透過 cacheKey.ts 的版本前綴（v2）全面失效，但既有
-- legs 列本身仍保留舊值——強制這些 auto/transit 段回到「從未計算」狀態，下次 sync 用新邏輯
-- （transit steps 三態偵測）重算。
--
-- 部署順序（M-1，2026-08-01 複審，必讀）：本 migration 必須在 Vercel 完成本次功能部署之後才能對
-- Supabase 雲端執行。新程式碼先上線本身無害（沿用既有 TTL／computed_at 判準運作，不會誤寫任何
-- 資料）；但若本 migration 先套用、Vercel 還沒部署，這段空窗期只要有人開一次行程頁，仍在線上跑的
-- 舊版 sync 邏輯就會用舊 parse 邏輯把這批 computed_at=null 的段重算，寫回同樣錯誤的步行時長、新的
-- computed_at，並改寫 departs_at——導致 moved 判準（legSync.ts）永遠為 false、TTL 30 天在出發前
-- 不會到期，這批壞資料自此不會再被正確邏輯修正，且整個過程沒有任何告警。詳見 README.md 部署段。
--
-- 回滾語義：純資料重置（UPDATE），冪等——重跑只是再次把同一批已是 computed_at=null 的列設回相同值，
-- 無 side effect；不含 schema 變更，不需要 down migration。但若在本 migration 套用「之後」才對
-- Vercel 做 Instant Rollback（回滾回本次修復之前的程式碼），舊程式碼一樣會把這批 computed_at=null
-- 的段用舊邏輯重算、寫回相同的錯誤值，等於讓這次 migration 白做——因此只有確認新程式碼已穩定運作、
-- 不需要回滾時才執行本 migration；一旦回滾，在重新部署新程式碼前不要再套用/重跑本 migration。
--
-- m-6（2026-08-01 複審）：不再連帶寫 stale=true——auto 段的重算判準（legSync.ts:53-57）只讀
-- computed_at/departs_at，不讀 stale，computed_at=null 單獨即足以觸發重算。stale=true 唯一的效果
-- 是 UI（Timeline 連接條 ⚠️、側欄「前後行程變動過，可能過期」提示、LegEditor 橫幅）顯示一句不成立
-- 的話（行程根本沒動），且 LegEditor 的「已重新確認」按鈕只清 stale、不會觸發重算，反而讓使用者
-- 誤以為問題已處理。
update public.legs
  set computed_at = null
  where source = 'auto' and mode = 'transit';

commit;
