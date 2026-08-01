begin;

-- 目的（C-1）：部署前的 parseComputeRoutesResponse 會把 Google 對 TRANSIT 請求退化成純步行的回應
-- 誤判為正常大眾運輸路線，把步行時長原樣寫進 duration_minutes、掛著「大眾運輸」標籤（日本大眾運輸
-- fallback 修正的既有壞資料）。route_cache 已透過 cacheKey.ts 的版本前綴（v2）全面失效，但既有
-- legs 列本身仍保留舊值——強制這些 auto/transit 段回到「從未計算」狀態，下次 sync 用新邏輯
-- （transit steps 三態偵測）重算。
--
-- 回滾語義：純資料重置（UPDATE），冪等——重跑只是再次把同一批已是 computed_at=null/stale=true
-- 的列設回相同值，無 side effect；不含 schema 變更，不需要 down migration。
update public.legs
  set computed_at = null, stale = true
  where source = 'auto' and mode = 'transit';

commit;
