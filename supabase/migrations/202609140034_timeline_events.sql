-- ---------------------------------------------------------------------------
-- Typed timeline events for the Together layer.
--
-- 202609090025 built the pair surface: an opt-in, a scrapbook, capsules, and a
-- timeline DERIVED on read from whatever rows happened to still exist. This is
-- the half that derivation cannot do.
--
-- ===========================================================================
-- DERIVED OR MATERIALISED — the decision, and the rule it follows
-- ===========================================================================
-- CLAUDE.md argues, about the game series score, that a second write is a
-- second thing that can fail on its own, so the score is written by the
-- statement that decides the result. That argument is right and it is why most
-- of this timeline stays derived. But it only holds where the evidence
-- survives, and in Meera most of it does not:
--
--   * `messages` are ephemeral. purge_expired() takes them at 31 days, and
--     clear_viewed_chats takes them after three visits. "The first snap you
--     ever sent each other" is derivable for a month and then quietly stops
--     being true — the card does not go wrong, it disappears, which is worse.
--   * `streaks` stores a COUNT, not a history. bump_streak resets it to 0 on a
--     36h gap, and the fact that you once reached 100 days is destroyed by the
--     same statement. No query can get it back.
--
--   THE RULE: materialise a fact whose evidence is deleted; derive a fact
--   whose source outlives it.
--
-- So this file splits the timeline in two, and the split is not cosmetic — it
-- lands exactly on the purge boundary (see below):
--
--   MATERIALISED here, by triggers, at the moment the thing happens:
--     first_snap · first_call · first_voice · mutual_save · streak_milestone
--   DERIVED still, by together_timeline(), from durable rows:
--     the friendship date · the anniversary and its yearly rollovers ·
--     every scrapbook entry
--
-- Deriving what is durable is not laziness, it is correctness: the anniversary
-- date is editable, and a materialised "4 years together" row would go on
-- saying four after the date behind it moved.
--
-- The second-write-can-fail objection is answered the way chat_backup.sql
-- answers it, because it is the same hot path: every recording trigger wraps
-- its work in `begin … exception when others then null`. A milestone that
-- fails to record costs a card. A milestone that fails a message send costs the
-- message. There is no version of this worth a failed send.
--
-- ===========================================================================
-- OPT-IN IS A COLLECTION GATE, NOT A DISPLAY GATE
-- ===========================================================================
-- Nothing is recorded for a pair that has not both opted in. The triggers ask
-- together_pair_active() and return without writing. That is what makes the
-- purge mean something: if events accrued regardless and opt-in merely hid
-- them, an opt-out would delete a pile that started refilling on the next
-- message.
--
-- The honest cost, said in the UI rather than discovered: turning Together on
-- does not invent the past. together_seed_events() backfills only from
-- evidence that is still on disk at that moment, and deliberately seeds NO
-- streak milestone — the day a streak crossed 30 is written down nowhere, and
-- guessing a date on a surface two people share is how a memory becomes a
-- small lie.
--
-- ===========================================================================
-- EGRESS: these events carry no media at all, not even a thumbnail
-- ===========================================================================
-- Capsules go further than "thumbnails, never media_path" here, and on purpose.
-- A mutual_save names a message that will be purged at 31 days, and its object
-- collected with it. Carrying its thumb_path would leave two bad options: teach
-- claim_media_cleanup() that an event is a reference — which pins a file in
-- storage forever for a card nobody asked to keep, the toggle_saved pinning bug
-- with better manners — or leave a tile whose signed URL 404s. So an event is
-- text and a date. The photo lives in the scrapbook, which is the surface built
-- to be durable. No image means no tile, which means no tap target that does
-- nothing: the same place 202609090025's capsules landed, reached from the
-- other side.
-- ---------------------------------------------------------------------------
begin;

-- ===========================================================================
-- 1. Is this pair actually together?
-- ===========================================================================
-- together_active(other) asks about auth.uid(); a trigger has no such luxury —
-- it holds two ids and needs the same answer. This is the one definition, and
-- together_active() becomes a wrapper over it so the two can never disagree.
--
-- It also closes a real hole. The old together_active() counted opt-in rows and
-- nothing else, so a pair who had been UNFRIENDED — or where one had BLOCKED
-- the other, which deletes the friendship precisely so stories, presence, calls
-- and push all stop — kept a working shared timeline, because the opt-in rows
-- reference profiles and survive. A block has to be a boundary here too.
create or replace function public.together_pair_active(a uuid, b uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare pair uuid[];
begin
  if a is null or b is null or a = b then return false; end if;
  pair := public.pair_key(a, b);
  if not exists (select 1 from public.friendships f
                  where f.user_a = pair[1] and f.user_b = pair[2]
                    and f.status = 'accepted') then
    return false;
  end if;
  if public.blocked_between(pair[1], pair[2]) then return false; end if;
  return (select count(*) from public.together_optin t
           where t.user_a = pair[1] and t.user_b = pair[2]
             and t.member in (pair[1], pair[2])) = 2;
end $fn$;
revoke all on function public.together_pair_active(uuid, uuid) from public, anon;
grant execute on function public.together_pair_active(uuid, uuid) to authenticated;

create or replace function public.together_active(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.together_pair_active(auth.uid(), other);
$fn$;
revoke all on function public.together_active(uuid) from public, anon;
grant execute on function public.together_active(uuid) to authenticated;

-- ===========================================================================
-- 2. The events
-- ===========================================================================
create table if not exists public.together_events (
  id          uuid primary key default gen_random_uuid(),
  user_a      uuid not null references public.profiles(id) on delete cascade,
  user_b      uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in
                ('first_snap', 'first_call', 'first_voice',
                 'mutual_save', 'streak_milestone')),
  -- What makes this event THIS event rather than another of its kind: '' for a
  -- first (there is only ever one), the milestone number for a streak, the
  -- message id for a save. The unique index over it is the whole idempotency
  -- story — a retried trigger, a replayed statement and a re-seed after a purge
  -- all cost exactly one row, the way (user_id, period) does for credits.
  dedupe      text not null default '',
  happened_at timestamptz not null default now(),
  -- The IST calendar day, like every other day boundary in this app. A UTC date
  -- would file a 4am memory under yesterday for the two people who lived it.
  on_date     date not null,
  magnitude   integer,
  -- A short noun the recorder knew and the reader cannot recover — 'photo',
  -- 'video', 'voice note' — because the row it came from is going to be purged.
  subject     text,
  actor       uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint together_events_ordered   check (user_a < user_b),
  constraint together_events_actor_in_pair
    check (actor is null or actor = user_a or actor = user_b),
  constraint together_events_dedupe_len  check (char_length(dedupe) <= 64),
  constraint together_events_subject_len check (subject is null or char_length(subject) <= 40),
  constraint together_events_magnitude   check (magnitude is null or (magnitude > 0 and magnitude <= 100000)),
  constraint together_events_date_floor  check (on_date >= date '1900-01-01')
);
create unique index if not exists together_events_once
  on public.together_events (user_a, user_b, kind, dedupe);
create index if not exists together_events_pair_idx
  on public.together_events (user_a, user_b, happened_at desc);

alter table public.together_events enable row level security;

-- "No public sharing or discoverability" is a database rule here, not a screen.
-- The second clause is what makes an opt-out take effect instantly: the rows
-- are invisible the moment either side's opt-in row is gone, whether or not the
-- purge in the same transaction has run, and whether or not the sweep has.
drop policy if exists together_events_read on public.together_events;
create policy together_events_read on public.together_events
  for select to authenticated
  using (auth.uid() in (user_a, user_b) and public.together_pair_active(user_a, user_b));

-- SELECT and nothing else, to anyone. A milestone is an observation, and an
-- observation a user can write is a fabrication: without this, a client could
-- PATCH itself a 365-day streak it never had. Every write goes through the
-- definer functions below, which are not granted to authenticated either.
revoke all on public.together_events from public, anon, authenticated;
grant select on public.together_events to authenticated;

-- ===========================================================================
-- 3. Recording
-- ===========================================================================
create or replace function public.together_record_event(
  a uuid,
  b uuid,
  event_kind text,
  dedupe_key text default '',
  happened timestamptz default null,
  actor_id uuid default null,
  size integer default null,
  subject_text text default null)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare pair uuid[]; stamp timestamptz := coalesce(happened, now());
begin
  if a is null or b is null or a = b then return; end if;
  pair := public.pair_key(a, b);
  -- The collection gate. Not a filter on the way out — a refusal to write.
  if not public.together_pair_active(pair[1], pair[2]) then return; end if;

  insert into public.together_events
    (user_a, user_b, kind, dedupe, happened_at, on_date, magnitude, subject, actor)
  values (
    pair[1], pair[2], event_kind, left(coalesce(dedupe_key, ''), 64), stamp,
    (stamp at time zone 'Asia/Kolkata')::date,
    size,
    left(nullif(btrim(coalesce(subject_text, '')), ''), 40),
    case when actor_id in (pair[1], pair[2]) then actor_id else null end)
  on conflict (user_a, user_b, kind, dedupe) do nothing;
end $fn$;
revoke all on function public.together_record_event(uuid, uuid, text, text, timestamptz, uuid, integer, text)
  from public, anon, authenticated;

-- --- the triggers ----------------------------------------------------------
-- On the hottest path in the app. `kind` is tested first so an ordinary chat —
-- which is most of them — leaves in one comparison, and the whole body is
-- exception-guarded for the reason chat_backup.sql's is: a milestone must never
-- be able to fail a message send.
create or replace function public.together_event_from_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.kind not in ('snap', 'call', 'voice') then return new; end if;
  begin
    perform public.together_record_event(
      new.user_a, new.user_b,
      case new.kind when 'snap' then 'first_snap'
                    when 'call' then 'first_call'
                    else 'first_voice' end,
      '', coalesce(new.created_at, now()), new.sender_id, null, null);
  exception when others then null;
  end;
  return new;
end $fn$;
drop trigger if exists together_message_events on public.messages;
create trigger together_message_events
  after insert on public.messages
  for each row execute function public.together_event_from_message();

-- "Mutually saved media": BOTH ids in saved_by, not the one-sided
-- cardinality > 0 the derived timeline calls "kept together". The only writer
-- of saved_by is toggle_saved(), so this fires inside that RPC's own statement.
-- The WHEN clause keeps it off every other update of a message row.
create or replace function public.together_event_from_save()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.media_path is null then return new; end if;
  begin
    perform public.together_record_event(
      new.user_a, new.user_b, 'mutual_save', new.id::text, now(), null, null,
      case when new.kind = 'voice' then 'voice note'
           when new.media_type = 'video' then 'video'
           else 'photo' end);
  exception when others then null;
  end;
  return new;
end $fn$;
drop trigger if exists together_save_events on public.messages;
create trigger together_save_events
  after update of saved_by on public.messages
  for each row
  when (new.saved_by @> array[new.user_a, new.user_b]
        and not (old.saved_by @> array[new.user_a, new.user_b]))
  execute function public.together_event_from_save();

-- Streak milestones. Its own trigger on `streaks` rather than a line inside
-- bump_streak, and for the reason 202609070011 gives for not editing
-- handle_new_user(): bump_streak is redefined across four files under
-- last-applied-wins, so a hook inside it is one future migration away from
-- being silently dropped.
--
-- Once per pair per milestone, ever — the unique index says so. A streak that
-- breaks at 40 and climbs back past 30 does not re-announce 30: a timeline is a
-- list of firsts and highs, and a card you have already read is the thing that
-- made the bot quotes feel cheap.
create or replace function public.together_event_from_streak()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare mark integer;
begin
  begin
    foreach mark in array array[7, 30, 50, 100, 200, 365] loop
      if new.count >= mark and coalesce(old.count, 0) < mark then
        perform public.together_record_event(
          new.user_a, new.user_b, 'streak_milestone', mark::text,
          coalesce(new.last_increment, now()), null, mark, null);
      end if;
    end loop;
  exception when others then null;
  end;
  return new;
end $fn$;
drop trigger if exists together_streak_events on public.streaks;
create trigger together_streak_events
  after update of count on public.streaks
  for each row
  when (new.count > old.count)
  execute function public.together_event_from_streak();

-- ===========================================================================
-- 4. Seeding, when a pair turns it on
-- ===========================================================================
-- Only from rows that are still here. Everything below has an exact date on it;
-- nothing is estimated. Streak milestones are absent on purpose — see the
-- header.
create or replace function public.together_seed_events(a uuid, b uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare pair uuid[]; row_one record;
begin
  if not public.together_pair_active(a, b) then return; end if;
  pair := public.pair_key(a, b);

  for row_one in
    select m.kind as msg_kind, min(m.created_at) as at
      from public.messages m
     where m.user_a = pair[1] and m.user_b = pair[2]
       and m.unsent_at is null and m.kind in ('snap', 'call', 'voice')
     group by m.kind
  loop
    perform public.together_record_event(
      pair[1], pair[2],
      case row_one.msg_kind when 'snap' then 'first_snap'
                            when 'call' then 'first_call'
                            else 'first_voice' end,
      '', row_one.at, null, null, null);
  end loop;

  -- Bounded: a pair who have saved hundreds of things do not want hundreds of
  -- cards, and an unbounded seed inside an opt-in tap is a write nobody sized.
  for row_one in
    select m.id as msg_id, m.created_at as at, m.kind as msg_kind,
           m.media_type as msg_media_type
      from public.messages m
     where m.user_a = pair[1] and m.user_b = pair[2]
       and m.unsent_at is null and m.media_path is not null
       and m.saved_by @> array[pair[1], pair[2]]
     order by m.created_at
     limit 50
  loop
    perform public.together_record_event(
      pair[1], pair[2], 'mutual_save', row_one.msg_id::text, row_one.at,
      null, null,
      case when row_one.msg_kind = 'voice' then 'voice note'
           when row_one.msg_media_type = 'video' then 'video'
           else 'photo' end);
  end loop;
end $fn$;
revoke all on function public.together_seed_events(uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- 5. The purge
-- ===========================================================================
-- WHAT IS PURGED, AND WHOSE. This is the line the whole feature turns on:
--
--   The purge deletes what the SYSTEM OBSERVED. It never deletes what a PERSON
--   MADE.
--
-- together_events are observations. Nobody wrote them, nobody owns half of one,
-- and there is no way to split "you reached a 30 day streak" down the middle.
-- They exist only because both people consented to their being collected, so
-- either person withdrawing that consent ends them — immediately, not once the
-- other person also agrees. Making the deletion wait on the second person turns
-- an opt-out into a request, and hands the other party a veto over it.
--
-- scrapbook_items are contributions. They are authored, they are attributed,
-- and half of them are the other person's. One person opting out must not
-- destroy them, which is why this function does not touch that table and why
-- reading the scrapbook stays open whatever the toggle says (202609090025).
-- Somebody who wants their own entries gone has purge_my_scrapbook() below —
-- author-scoped, explicit, and a separate decision.
--
-- The derived half of the timeline is not purged because it is not stored:
-- turning Together off simply stops together_timeline() returning it. That the
-- derived/materialised split lands exactly on the purge boundary is not a
-- coincidence — a fact you can recompute was never yours to delete.
create or replace function public.together_purge_events(a uuid, b uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare pair uuid[]; removed integer;
begin
  if a is null or b is null or a = b then return 0; end if;
  pair := public.pair_key(a, b);
  delete from public.together_events e
   where e.user_a = pair[1] and e.user_b = pair[2];
  get diagnostics removed = row_count;
  return removed;
end $fn$;
revoke all on function public.together_purge_events(uuid, uuid) from public, anon, authenticated;

-- The sweep. The synchronous purge covers the tap; this covers everything that
-- ends a pair without going through set_together_optin() — block_user()
-- deleting the friendship, removeFriend(), a profile deletion cascading the
-- opt-in rows away. Without it a blocked pair's milestones sit in the table
-- indefinitely, invisible but present, which is the state data minimisation
-- exists to avoid.
create or replace function public.purge_together_events()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare removed integer;
begin
  delete from public.together_events e
   where not public.together_pair_active(e.user_a, e.user_b);
  get diagnostics removed = row_count;
  return removed;
end $fn$;
revoke all on function public.purge_together_events() from public, anon, authenticated;

-- Author-scoped, and the only bulk delete a person may perform on a shared
-- artifact: their own entries, never the other person's. Goes item by item
-- through delete_scrapbook_item() rather than one DELETE, so every object is
-- queued for the cleanup worker exactly as a single removal would be — a bulk
-- path that skips that is how a hundred orphaned files appear at once.
create or replace function public.purge_my_scrapbook(other uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); pair uuid[]; doomed uuid; removed integer := 0;
begin
  if me is null then raise exception 'not signed in'; end if;
  if other is null or other = me then raise exception 'Choose a friend'; end if;
  pair := public.pair_key(me, other);
  for doomed in
    select s.id from public.scrapbook_items s
     where s.user_a = pair[1] and s.user_b = pair[2] and s.author = me
  loop
    perform public.delete_scrapbook_item(doomed);
    removed := removed + 1;
  end loop;
  return removed;
end $fn$;
revoke all on function public.purge_my_scrapbook(uuid) from public, anon;
grant execute on function public.purge_my_scrapbook(uuid) to authenticated;

-- ===========================================================================
-- 6. Opt-in, widened
-- ===========================================================================
-- together_status() gains event_count, so the confirmation can say how many
-- recorded milestones an opt-out is about to delete rather than asking someone
-- to agree to an unnamed quantity. Widening a `returns table` needs a drop
-- first, and set_together_optin() returns the same shape, so both go — the same
-- dance 202609070011 does for entitlement()/start_trial(). A drop that fails
-- loudly beats a stale definition left behind.
drop function if exists public.set_together_optin(uuid, boolean);
drop function if exists public.together_status(uuid);

create or replace function public.together_status(other uuid)
returns table (mine boolean, theirs boolean, active boolean,
               started_on date, item_count integer, event_count integer,
               my_item_count integer)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    exists (select 1 from public.together_optin t
             where array[t.user_a, t.user_b] = public.pair_key(auth.uid(), other)
               and t.member = auth.uid()),
    exists (select 1 from public.together_optin t
             where array[t.user_a, t.user_b] = public.pair_key(auth.uid(), other)
               and t.member = other),
    public.together_active(other),
    (select a.started_on from public.anniversaries a
      where array[a.user_a, a.user_b] = public.pair_key(auth.uid(), other)),
    (select count(*)::int from public.scrapbook_items s
      where array[s.user_a, s.user_b] = public.pair_key(auth.uid(), other)),
    (select count(*)::int from public.together_events e
      where array[e.user_a, e.user_b] = public.pair_key(auth.uid(), other)),
    -- What a purge of YOUR OWN contributions would cost, counted separately,
    -- because "delete 3 of the 11 entries here" is a different sentence from
    -- "delete the 11 entries here" and only one of them is true.
    (select count(*)::int from public.scrapbook_items s
      where array[s.user_a, s.user_b] = public.pair_key(auth.uid(), other)
        and s.author = auth.uid())
  where auth.uid() is not null and other is not null and other <> auth.uid();
$fn$;
revoke all on function public.together_status(uuid) from public, anon;
grant execute on function public.together_status(uuid) to authenticated;

create or replace function public.set_together_optin(other uuid, joined boolean)
returns table (mine boolean, theirs boolean, active boolean,
               started_on date, item_count integer, event_count integer,
               my_item_count integer)
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); pair uuid[];
begin
  if me is null then raise exception 'not signed in'; end if;
  if other is null or other = me then raise exception 'Choose a friend'; end if;
  pair := public.pair_key(me, other);
  if not exists (select 1 from public.friendships f
                  where f.user_a = pair[1] and f.user_b = pair[2]
                    and f.status = 'accepted') then
    raise exception 'You can only do this with an accepted friend';
  end if;
  if public.blocked_between(pair[1], pair[2]) then raise exception 'Unavailable'; end if;

  if joined then
    insert into public.together_optin (user_a, user_b, member)
    values (pair[1], pair[2], me)
    on conflict (user_a, user_b, member) do nothing;
    -- Turning it on cannot invent a past, but it should not throw away the one
    -- that is still on disk either. Idempotent by the same unique index, so the
    -- pair toggling it twice does not double anything.
    perform public.together_seed_events(pair[1], pair[2]);
  else
    -- Your own row only. Nobody can switch the other person off.
    delete from public.together_optin t
     where t.user_a = pair[1] and t.user_b = pair[2] and t.member = me;
    -- ...and the observations go with it, in the same transaction. The
    -- scrapbook is untouched: see the note on together_purge_events().
    perform public.together_purge_events(pair[1], pair[2]);
  end if;

  return query select * from public.together_status(other);
end $fn$;
revoke all on function public.set_together_optin(uuid, boolean) from public, anon;
grant execute on function public.set_together_optin(uuid, boolean) to authenticated;

-- ===========================================================================
-- 7. The timeline, with the recorded half folded in
-- ===========================================================================
-- Same seven columns as 202609090025 deliberately: a widened signature would
-- need a drop and would break every client that had not shipped yet, and the
-- recorded rows need nothing the derived rows do not already have. `ref` is the
-- event id, `thumb_path` is always null for them — see the egress note above.
create or replace function public.together_timeline(other uuid)
returns table (
  at         timestamptz,
  on_date    date,
  kind       text,
  title      text,
  detail     text,
  ref        uuid,
  thumb_path text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); pair uuid[]; started date; today date := public.ist_date();
begin
  if me is null or other is null then return; end if;
  if not public.together_active(other) then return; end if;
  pair := public.pair_key(me, other);

  -- --- derived: durable sources, recomputed every read ---------------------
  return query
    select f.created_at,
           (f.created_at at time zone 'Asia/Kolkata')::date,
           'friends'::text,
           'You became friends'::text,
           null::text, null::uuid, null::text
      from public.friendships f
     where f.user_a = pair[1] and f.user_b = pair[2] and f.status = 'accepted';

  select a.started_on into started
    from public.anniversaries a
   where a.user_a = pair[1] and a.user_b = pair[2];

  if started is not null then
    return query
      select (started::timestamp at time zone 'Asia/Kolkata'),
             started,
             'anniversary_start'::text,
             'Together since'::text,
             to_char(started, 'FMDD Mon YYYY')::text,
             null::uuid, null::text;

    return query
      select ((started + (n || ' years')::interval)::date::timestamp at time zone 'Asia/Kolkata'),
             (started + (n || ' years')::interval)::date,
             'anniversary'::text,
             (n || case when n = 1 then ' year together' else ' years together' end)::text,
             null::text, null::uuid, null::text
        from generate_series(1, greatest(0, (extract(year from age(today, started)))::int)) n;
  end if;

  return query
    select m.created_at,
           (m.created_at at time zone 'Asia/Kolkata')::date,
           'first_kept'::text,
           'The first snap you kept'::text,
           null::text, m.id, m.thumb_path
      from public.messages m
     where m.user_a = pair[1] and m.user_b = pair[2]
       and m.kind = 'snap' and m.unsent_at is null
       and cardinality(m.saved_by) > 0
     order by m.created_at
     limit 1;

  return query
    select max(m.created_at),
           (max(m.created_at) at time zone 'Asia/Kolkata')::date,
           'kept'::text,
           (count(*) || case when count(*) = 1 then ' snap kept together'
                             else ' snaps kept together' end)::text,
           null::text, null::uuid, null::text
      from public.messages m
     where m.user_a = pair[1] and m.user_b = pair[2]
       and m.unsent_at is null and m.media_path is not null
       and cardinality(m.saved_by) > 0
    having count(*) > 0;

  return query
    select coalesce(s.last_increment, greatest(s.last_snap_a, s.last_snap_b), now()),
           (coalesce(s.last_increment, greatest(s.last_snap_a, s.last_snap_b), now())
             at time zone 'Asia/Kolkata')::date,
           'streak'::text,
           (s.count || ' day streak')::text,
           case when s.count >= 100 then 'Past 100 days'
                when s.count >= 30  then 'Past a month'
                else null end::text,
           null::uuid, null::text
      from public.streaks s
     where s.user_a = pair[1] and s.user_b = pair[2] and s.count > 0;

  return query
    select si.created_at,
           si.on_date,
           ('scrapbook_' || si.kind)::text,
           case si.kind
             when 'photo' then 'Photo in your scrapbook'
             when 'voice' then 'Voice note in your scrapbook'
             else 'Note in your scrapbook' end::text,
           left(coalesce(si.body, ''), 140)::text,
           si.id,
           si.thumb_path
      from public.scrapbook_items si
     where si.user_a = pair[1] and si.user_b = pair[2]
     order by si.on_date desc, si.created_at desc
     limit 80;

  -- --- recorded: facts whose evidence is gone or going ---------------------
  return query
    select e.happened_at,
           e.on_date,
           e.kind,
           case e.kind
             when 'first_snap'  then 'Your first snap'
             when 'first_call'  then 'Your first call'
             when 'first_voice' then 'Your first voice note'
             when 'mutual_save' then 'A ' || coalesce(e.subject, 'moment') || ' you both saved'
             when 'streak_milestone' then e.magnitude || ' days in a row'
             else 'A moment together'
           end::text,
           case
             when e.kind = 'streak_milestone' and e.magnitude >= 365 then 'A year without missing a day'
             when e.kind = 'streak_milestone' and e.magnitude >= 100 then 'Past 100 days'
             when e.kind = 'streak_milestone' and e.magnitude >= 30  then 'Past a month'
             else null
           end::text,
           e.id,
           null::text
      from public.together_events e
     where e.user_a = pair[1] and e.user_b = pair[2]
     order by e.happened_at desc
     limit 120;
end $fn$;
revoke all on function public.together_timeline(uuid) from public, anon;
grant execute on function public.together_timeline(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609140034_timeline_events') on conflict (id) do nothing;
