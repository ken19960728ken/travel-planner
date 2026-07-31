begin;

alter table public.trips
  add constraint trips_title_len check (length(btrim(title)) between 1 and 200);
alter table public.stops
  add constraint stops_name_len check (length(btrim(name)) between 1 and 200);

commit;
