begin;

-- btrim 只去 ASCII 空白，tab/換行/全形空白可鑽過下界；改用 ~ '\S'（至少一個非空白字元），
-- 與前端 JS .trim() 的判空語義對齊
alter table public.trips drop constraint trips_title_len;
alter table public.trips add constraint trips_title_len
  check (title ~ '\S' and length(btrim(title)) <= 200);

alter table public.stops drop constraint stops_name_len;
alter table public.stops add constraint stops_name_len
  check (name ~ '\S' and length(btrim(name)) <= 200);

commit;
