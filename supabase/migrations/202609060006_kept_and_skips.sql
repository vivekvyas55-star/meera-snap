-- Two features, both pair-scoped.
--
-- 1. "Kept together": the photos and videos either of you saved in a chat,
--    shown on that friend's profile. This needs NO new table — messages already
--    carries a shared saved_by[] that both parties can see. It only needs a
--    thumb_path, because a grid that renders 1600px originals into ~120px tiles
--    is the exact egress mistake memories_thumbs.sql was written to fix.
--
-- 2. Skipping the question of the day. todays_prompt() is deterministic on the
--    day number so both people get the same question with nothing scheduled.
--    A per-person skip would break that — you would each be answering a
--    different question. The skip is therefore stored PER PAIR: either of you
--    skips and you both move on together.
begin;

-- 1 ------------------------------------------------------------------------
alter table public.messages add column if not exists thumb_path text;

-- Any column the client writes needs its own grant, or the write fails with
-- 42501 before RLS is even consulted (table-wide privileges were revoked in
-- hardening).
grant insert (thumb_path), select (thumb_path) on public.messages to authenticated;

-- Saved media for one pair, newest first. SECURITY INVOKER so the existing
-- messages RLS still scopes it to the two participants.
create or replace function public.kept_together(other uuid, lim int default 200)
returns setof public.messages
language sql stable security invoker set search_path = public as $fn$
  select m.* from public.messages m
  where array[m.user_a, m.user_b] = public.pair_key(auth.uid(), other)
    and m.kind = 'snap'
    and m.media_path is not null
    and cardinality(m.saved_by) > 0
    and m.unsent_at is null
  order by m.created_at desc
  limit least(coalesce(lim, 200), 500);
$fn$;
revoke all on function public.kept_together(uuid, int) from public, anon;
grant execute on function public.kept_together(uuid, int) to authenticated;

-- 2 ------------------------------------------------------------------------
create table if not exists public.prompt_skips (
  user_a  uuid not null references auth.users(id) on delete cascade,
  user_b  uuid not null references auth.users(id) on delete cascade,
  on_date date not null,
  skips   int  not null default 0,
  primary key (user_a, user_b, on_date),
  constraint prompt_skips_pair_ordered check (user_a < user_b),
  constraint prompt_skips_sane check (skips >= 0 and skips <= 20)
);

alter table public.prompt_skips enable row level security;

-- Read-only to the two people in the pair; all writes go through the RPC below,
-- so nobody can set an arbitrary skip count.
drop policy if exists prompt_skips_read on public.prompt_skips;
create policy prompt_skips_read on public.prompt_skips for select to authenticated
  using (auth.uid() in (user_a, user_b));

revoke all on public.prompt_skips from public, anon, authenticated;
grant select on public.prompt_skips to authenticated;

-- How many times this pair has skipped today.
create or replace function public.pair_skips(other uuid)
returns int language sql stable security definer set search_path = public as $fn$
  select coalesce((
    select s.skips from public.prompt_skips s
    where array[s.user_a, s.user_b] = public.pair_key(auth.uid(), other)
      and s.on_date = public.ist_date()
  ), 0);
$fn$;
revoke all on function public.pair_skips(uuid) from public, anon;
grant execute on function public.pair_skips(uuid) to authenticated;

-- Today's question for this pair, offset by however many times they have
-- skipped. Same deterministic pick as todays_prompt(), plus the shared offset.
create or replace function public.pair_prompt(other uuid)
returns table (id int, body text, on_date date)
language sql stable security definer set search_path = public as $fn$
  with n as (
    select (select count(*) from public.prompts) as total,
           public.ist_date() as d,
           public.pair_skips(other) as skipped
  )
  select p.id, p.body, n.d
  from n
  join public.prompts p
    on p.id = ((((n.d - date '2024-01-01') + n.skipped) % greatest(n.total, 1)) + 1)
  where n.total > 0;
$fn$;
revoke all on function public.pair_prompt(uuid) from public, anon;
grant execute on function public.pair_prompt(uuid) to authenticated;

-- Skip to the next question. Refused once EITHER of you has answered — moving
-- the question after an answer exists would orphan that answer, and the
-- simultaneous reveal would be comparing replies to two different questions.
create or replace function public.skip_prompt(other uuid)
returns int language plpgsql volatile security definer set search_path = public as $fn$
declare pk uuid[]; d date; answered boolean; next_skips int;
begin
  if auth.uid() is null or other is null or other = auth.uid() then
    raise exception 'not allowed';
  end if;
  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted' and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), other)
  ) then
    raise exception 'not allowed';
  end if;

  pk := public.pair_key(auth.uid(), other);
  d  := public.ist_date();

  select exists (
    select 1 from public.prompt_answers a
    where a.user_a = pk[1] and a.user_b = pk[2] and a.on_date = d
  ) into answered;
  if answered then
    raise exception 'Someone has already answered today''s question';
  end if;

  insert into public.prompt_skips (user_a, user_b, on_date, skips)
  values (pk[1], pk[2], d, 1)
  on conflict (user_a, user_b, on_date)
    do update set skips = least(public.prompt_skips.skips + 1, 20)
  returning skips into next_skips;

  return next_skips;
end $fn$;
revoke all on function public.skip_prompt(uuid) from public, anon;
grant execute on function public.skip_prompt(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
