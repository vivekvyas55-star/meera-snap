-- ---------------------------------------------------------------------------
-- The drift check had a blind spot, and it found it the honest way: by being
-- wrong about production.
--
-- `schema_version()` returns max(id), and the bundle carries the newest
-- migration FILE. Compare only those two and a migration missing from the
-- MIDDLE is invisible — apply 0028 while 0026 was never run and both sides say
-- "202609090028", match, no warning. That is precisely the half-deployed state
-- the whole check exists to catch, and it sailed straight through.
--
-- The count closes it: the newest id AND how many have been applied. A gap
-- changes the count even when it cannot change the maximum.
-- ---------------------------------------------------------------------------
create or replace function public.schema_state()
returns table (newest text, applied integer)
language sql stable security definer set search_path = public
as $fn$ select max(id), count(*)::integer from public.schema_migrations $fn$;

revoke all on function public.schema_state() from public, anon;
grant execute on function public.schema_state() to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations(id) values ('202609090029_schema_gap') on conflict (id) do nothing;
