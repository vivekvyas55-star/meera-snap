-- ---------------------------------------------------------------------------
-- Two bot problems, both visible in production.
--
-- 1. THE QUOTE POOL REPEATS ALMOST IMMEDIATELY. `send_morning_quotes` picks
--    with `order by md5(quote_id || user_id || ist_date()) limit 1` — a fresh
--    uniform draw from 20 quotes every day. Uniform draws collide fast: the
--    expected first repeat is around six days, and the live numbers agree —
--    34 bot messages have used only 17 distinct quotes. Half of what the bots
--    have ever said was something they had already said.
--
--    Deterministic ROTATION instead: index the pool by (day number + a
--    per-user phase) so each person walks the whole list before seeing
--    anything twice. Same property the question of the day already relies on —
--    no schedule stored, derived from the date — but without the collisions,
--    because it is a cycle rather than a draw.
--
-- 2. BOTS ARE BILLED. The signup-grant trigger and the founding grandfathering
--    both treated the 5 seed bot accounts as users: 10 credit-ledger rows and
--    5 grandfathered subscriptions for accounts that can never pay, log in, or
--    read a plan. Harmless to a human, but it makes every count of "users"
--    wrong, and a wrong denominator is how billing numbers start lying.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.send_morning_quotes()
returns int language plpgsql security definer set search_path=public as $$
declare ru record; bot_id uuid; quote text; sent int:=0; claimed uuid;
        pool int; day_no int;
begin
 select count(*) into pool from public.bot_quotes;
 if pool = 0 then return 0; end if;
 -- Days since epoch. The question of the day derives its choice the same way.
 day_no := public.ist_date() - date '2024-01-01';

 for ru in select id from public.profiles where not is_bot loop
  select b.id into bot_id from public.profiles b where b.is_bot and exists(
   select 1 from public.friendships f where f.status='accepted' and array[f.user_a,f.user_b]=public.pair_key(b.id,ru.id))
   order by md5(b.id::text||ru.id::text||public.ist_date()::text) limit 1;

  -- Rotation, not a draw. The per-user phase keeps two people on different
  -- quotes on the same morning; the modulo guarantees each of them sees all
  -- `pool` quotes before any repeats.
  select bq.text into quote from (
    select t.text, row_number() over (order by t.id) - 1 as idx
      from public.bot_quotes t
  ) bq
   where bq.idx = (day_no + ('x' || substr(md5(ru.id::text), 1, 8))::bit(32)::bigint) % pool;

  if bot_id is null or quote is null then continue; end if;
  claimed:=null;
  insert into public.bot_deliveries values(ru.id,public.ist_date()) on conflict do nothing returning user_id into claimed;
  if claimed is null then continue; end if;
  insert into public.messages(user_a,user_b,sender_id,kind,body,delivered_at)
  values(least(bot_id,ru.id),greatest(bot_id,ru.id),bot_id,'chat',quote,now());
  sent:=sent+1;
 end loop;
 return sent;
end $$;
revoke all on function public.send_morning_quotes() from public,anon,authenticated;
grant execute on function public.send_morning_quotes() to service_role;

-- Bots are not customers. Undo the grants and the grandfathering they were
-- swept into, so every count of users means what it says.
delete from public.credit_ledger l using public.profiles p
 where p.id = l.user_id and p.is_bot;
delete from public.subscriptions s using public.profiles p
 where p.id = s.user_id and p.is_bot;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090028_bot_rotation') on conflict (id) do nothing;
