-- ===========================================================================
-- What the two of you have actually sent each other.
--
-- `friendship_charms()` already counts messages and snaps, and those counts
-- are WRONG in a way that gets worse: they query rows still in `messages`, and
-- messages here are ephemeral — cleared after three visits, purged at 31 days.
-- So "1,204 messages" is really "1,204 messages that happen to still exist",
-- and it drifts DOWNWARD over time. Showing a couple a lifetime total that
-- quietly shrinks is worse than showing nothing.
--
-- This is 202609140034's rule applied again: MATERIALISE A FACT WHOSE EVIDENCE
-- IS DELETED; DERIVE A FACT WHOSE SOURCE OUTLIVES IT. The message is gone in a
-- month; that it was sent is not something we can recompute afterwards.
--
-- THE HOT PATH. This is an AFTER INSERT trigger on `messages`, the hottest
-- write in the app. It does one upsert of five integers and nothing else — no
-- joins beyond the opt-in check, no reads of the row's content. The whole body
-- is wrapped in `begin … exception when others then null`, exactly like
-- chat_backup.sql's and every trigger in 0034: failing to count a message must
-- never fail the message. A lost count costs a number on a card.
--
-- GATED ON THE OPT-IN, like together_events, and for the same reason: a
-- durable record of a pair is an observation nobody authored, so it accrues
-- only while both people have said yes, and an opt-out deletes it. That makes
-- the opt-in mean something. The honest cost is that turning it on does not
-- invent a past — `seed_pair_totals()` backfills from the rows still on disk,
-- which is an UNDERCOUNT, and the client says so rather than presenting it as
-- a lifetime figure.
--
-- Thread events are excluded. A call log and a play invitation are not
-- messages — the same rule `bump_streak` and the unread badge already follow.
-- ===========================================================================
begin;

create table if not exists public.pair_totals (
  user_a     uuid not null references auth.users(id) on delete cascade,
  user_b     uuid not null references auth.users(id) on delete cascade,
  messages   bigint not null default 0,
  snaps      bigint not null default 0,
  voice      bigint not null default 0,
  photos     bigint not null default 0,
  videos     bigint not null default 0,
  -- Whether the numbers below started from a backfill of surviving rows rather
  -- than from the first message. The client must not call a seeded total a
  -- lifetime one.
  seeded     boolean not null default false,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint pair_totals_ordered check (user_a < user_b)
);

alter table public.pair_totals enable row level security;

-- Read-only to the two people it is about. There is deliberately no write
-- grant of any kind: every increment comes from the definer trigger below, so
-- a count cannot be forged by the person it flatters.
revoke all on public.pair_totals from anon, authenticated;
grant select on public.pair_totals to authenticated;

drop policy if exists pair_totals_read on public.pair_totals;
create policy pair_totals_read on public.pair_totals
  for select to authenticated using (auth.uid() in (user_a, user_b));

-- ---------------------------------------------------------------------------
-- The counter.
create or replace function public.bump_pair_totals()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  begin
    -- Thread events are not messages.
    if new.kind in ('call', 'game') then return new; end if;
    if not public.together_pair_active(new.user_a, new.user_b) then return new; end if;

    insert into public.pair_totals as t (user_a, user_b, messages, snaps, voice, photos, videos)
    values (
      new.user_a, new.user_b,
      1,
      case when new.kind = 'snap' then 1 else 0 end,
      case when new.kind = 'voice' then 1 else 0 end,
      case when new.kind = 'snap' and coalesce(new.media_type,'') = 'image' then 1 else 0 end,
      case when new.kind = 'snap' and coalesce(new.media_type,'') = 'video' then 1 else 0 end
    )
    on conflict (user_a, user_b) do update set
      messages   = t.messages + 1,
      snaps      = t.snaps    + case when new.kind = 'snap' then 1 else 0 end,
      voice      = t.voice    + case when new.kind = 'voice' then 1 else 0 end,
      photos     = t.photos   + case when new.kind = 'snap' and coalesce(new.media_type,'') = 'image' then 1 else 0 end,
      videos     = t.videos   + case when new.kind = 'snap' and coalesce(new.media_type,'') = 'video' then 1 else 0 end,
      updated_at = now();
  exception when others then null;  -- never fail a send over a statistic
  end;
  return new;
end $fn$;

drop trigger if exists on_message_pair_totals on public.messages;
create trigger on_message_pair_totals
  after insert on public.messages
  for each row execute function public.bump_pair_totals();

-- ---------------------------------------------------------------------------
-- Backfill, at opt-in, from what is still on disk. Deliberately marked
-- `seeded` so nothing downstream can present it as a complete history.
create or replace function public.seed_pair_totals(other uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare pair uuid[];
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  pair := public.pair_key(auth.uid(), other);
  if not public.together_pair_active(pair[1], pair[2]) then return; end if;
  if exists (select 1 from public.pair_totals t where t.user_a = pair[1] and t.user_b = pair[2]) then return; end if;

  insert into public.pair_totals (user_a, user_b, messages, snaps, voice, photos, videos, seeded)
  select pair[1], pair[2],
         count(*),
         count(*) filter (where m.kind = 'snap'),
         count(*) filter (where m.kind = 'voice'),
         count(*) filter (where m.kind = 'snap' and m.media_type = 'image'),
         count(*) filter (where m.kind = 'snap' and m.media_type = 'video'),
         true
    from public.messages m
   where m.user_a = pair[1] and m.user_b = pair[2]
     and m.kind not in ('call', 'game')
  on conflict do nothing;
end $fn$;
revoke all on function public.seed_pair_totals(uuid) from public, anon;
grant execute on function public.seed_pair_totals(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The read. Returns nothing at all rather than zeros when the pair has not
-- opted in — a row of zeros would be indistinguishable from "you have never
-- spoken", which is a claim, and the client would render it as one.
create or replace function public.together_totals(other uuid)
returns table (messages bigint, snaps bigint, voice bigint, photos bigint,
               videos bigint, seeded boolean, started_at timestamptz)
language sql stable security definer set search_path = public as $fn$
  select t.messages, t.snaps, t.voice, t.photos, t.videos, t.seeded, t.started_at
    from public.pair_totals t
   where auth.uid() is not null
     and array[t.user_a, t.user_b] = public.pair_key(auth.uid(), other)
     and public.together_pair_active(t.user_a, t.user_b);
$fn$;
revoke all on function public.together_totals(uuid) from public, anon;
grant execute on function public.together_totals(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- An opt-out deletes them, in the same transaction, exactly as it deletes
-- together_events. These are observations, not contributions: nobody wrote
-- them and nobody owns half of one, so either side withdrawing ends them.
create or replace function public.purge_pair_totals()
returns void language sql security definer set search_path = public as $fn$
  delete from public.pair_totals t
   where not public.together_pair_active(t.user_a, t.user_b);
$fn$;
revoke all on function public.purge_pair_totals() from public, anon, authenticated;

drop trigger if exists optout_pair_totals on public.together_optin;
create or replace function public.pair_totals_on_optout()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  begin
    delete from public.pair_totals t
     where t.user_a = old.user_a and t.user_b = old.user_b;
  exception when others then null;
  end;
  return old;
end $fn$;
create trigger optout_pair_totals after delete on public.together_optin
  for each row execute function public.pair_totals_on_optout();

insert into public.schema_migrations(id) values ('202609150100_pair_totals') on conflict do nothing;
notify pgrst, 'reload schema';
commit;
