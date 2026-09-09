-- ---------------------------------------------------------------------------
-- The Together layer — a first-class pair surface.
--
-- Three things live here, all scoped to exactly two people:
--
--   1. A TIMELINE, derived from data that already exists (the friendship, the
--      anniversary, the streak, the snaps you both kept) plus the scrapbook.
--      It is OPT-IN and both people have to choose it. `together_optin` holds
--      one row per member per pair; two rows is on, anything less is off.
--   2. A shared SCRAPBOOK (`scrapbook_items`) — photos, voice notes, notes.
--      Durable on purpose: this is the one surface in Meera that does not
--      disappear, which is exactly why both people have to agree to it first.
--   3. "ON THIS DAY" capsules, over the scrapbook and over the snaps you both
--      kept, on IST day boundaries like every other day boundary in this app.
--
-- What opt-in gates, precisely, and why the line is drawn where it is:
--
--   * The timeline and the capsules return NOTHING unless both sides opted in.
--     They are derived narrative; withholding them destroys nothing.
--   * WRITING a scrapbook item requires both sides opted in. Putting content
--     into somebody's shared surface because *you* switched it on is the exact
--     thing opt-in is supposed to prevent.
--   * READING the scrapbook is always allowed to both parties. If opting out
--     hid the rows, one person could take the other's memories hostage by
--     flipping a toggle. Opting out hides the surface; it deletes nothing, and
--     removing an item is a separate, explicit, author-only act.
--
-- Deliberately NOT here: scheduled/surprise messages. A message that sits in
-- plaintext for days, in an app whose chats clear after three visits, is a
-- trade-off the owner has to make, not one a migration should make for him.
-- ---------------------------------------------------------------------------
begin;

-- ===========================================================================
-- 1. Tables
-- ===========================================================================
-- Opt-in is per MEMBER rather than a pair row with two booleans: "which column
-- am I?" is a bug waiting to happen everywhere the pair is sorted and the
-- caller is not. A member either has a row or does not.
create table if not exists public.together_optin (
  user_a   uuid not null references public.profiles(id) on delete cascade,
  user_b   uuid not null references public.profiles(id) on delete cascade,
  member   uuid not null references public.profiles(id) on delete cascade,
  opted_at timestamptz not null default now(),
  primary key (user_a, user_b, member),
  constraint together_optin_ordered check (user_a < user_b),
  constraint together_optin_member  check (member = user_a or member = user_b)
);
create index if not exists together_optin_member_idx on public.together_optin (member);

alter table public.together_optin enable row level security;

drop policy if exists together_optin_read on public.together_optin;
create policy together_optin_read on public.together_optin
  for select to authenticated using (auth.uid() in (user_a, user_b));

-- Grants gate writes BEFORE RLS is consulted, so the absence of an insert or
-- delete grant is what makes set_together_optin() the only way in. A policy
-- alone would not do it.
revoke all on public.together_optin from public, anon, authenticated;
grant select on public.together_optin to authenticated;

-- The shared scrapbook. No UPDATE grant anywhere: an entry is what it was when
-- it was made. Deletion is author-only and goes through an RPC so the bucket
-- object is queued for the cleanup worker in the same call — a row deleted
-- without that leaves a file nothing references and nothing ever collects.
create table if not exists public.scrapbook_items (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid not null references public.profiles(id) on delete cascade,
  user_b     uuid not null references public.profiles(id) on delete cascade,
  author     uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('photo', 'voice', 'note')),
  body       text,
  media_path text,
  thumb_path text,
  media_type text check (media_type in ('image', 'audio')),
  -- The day the memory is ABOUT, not the day it was typed. A photo from 2019
  -- belongs on its own day, which is what makes "on this day" worth having on
  -- the first afternoon rather than in a year's time.
  on_date    date not null,
  created_at timestamptz not null default now(),
  constraint scrapbook_ordered        check (user_a < user_b),
  constraint scrapbook_author_in_pair check (author = user_a or author = user_b),
  -- Anything a user can write needs a ceiling. messages.body and
  -- stories.caption not having one is a known gap in this schema; this does
  -- not repeat it.
  constraint scrapbook_body_len check (body is null or char_length(body) <= 1000),
  constraint scrapbook_path_len check (
        (media_path is null or char_length(media_path) <= 400)
    and (thumb_path is null or char_length(thumb_path) <= 400)),
  constraint scrapbook_note_has_body check (kind <> 'note' or coalesce(btrim(body), '') <> ''),
  constraint scrapbook_media_present check (kind = 'note' or media_path is not null),
  constraint scrapbook_thumb_needs_media check (thumb_path is null or media_path is not null),
  -- ist_date() is STABLE, and a CHECK may only call IMMUTABLE functions, so the
  -- "not in the future" half of the rule is enforced in add_scrapbook_item().
  -- This is the half that can live here.
  constraint scrapbook_date_floor check (on_date >= date '1900-01-01')
);
create index if not exists scrapbook_pair_idx on public.scrapbook_items (user_a, user_b, on_date desc);
create index if not exists scrapbook_media_idx on public.scrapbook_items (media_path);

alter table public.scrapbook_items enable row level security;

drop policy if exists scrapbook_read on public.scrapbook_items;
create policy scrapbook_read on public.scrapbook_items
  for select to authenticated using (auth.uid() in (user_a, user_b));

revoke all on public.scrapbook_items from public, anon, authenticated;
grant select on public.scrapbook_items to authenticated;

-- ===========================================================================
-- 2. Opt-in
-- ===========================================================================
-- Both sides present. Every surface in this file asks this one question, so it
-- has exactly one answer.
create or replace function public.together_active(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select auth.uid() is not null
     and other is not null
     and other <> auth.uid()
     and (select count(*) from public.together_optin t
           where array[t.user_a, t.user_b] = public.pair_key(auth.uid(), other)
             and t.member in (auth.uid(), other)) = 2;
$fn$;
revoke all on function public.together_active(uuid) from public, anon;
grant execute on function public.together_active(uuid) to authenticated;

-- SECURITY DEFINER, but the pair is built from auth.uid() INSIDE the function,
-- so a caller can only ever ask about a pair they are half of. Same shape as
-- pair_skips() and friendship_charms().
create or replace function public.together_status(other uuid)
returns table (mine boolean, theirs boolean, active boolean, started_on date, item_count integer)
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
      where array[s.user_a, s.user_b] = public.pair_key(auth.uid(), other))
  where auth.uid() is not null and other is not null and other <> auth.uid();
$fn$;
revoke all on function public.together_status(uuid) from public, anon;
grant execute on function public.together_status(uuid) to authenticated;

create or replace function public.set_together_optin(other uuid, joined boolean)
returns table (mine boolean, theirs boolean, active boolean, started_on date, item_count integer)
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
  else
    -- Your own row only. Nobody can switch the other person off.
    delete from public.together_optin t
     where t.user_a = pair[1] and t.user_b = pair[2] and t.member = me;
  end if;

  return query select * from public.together_status(other);
end $fn$;
revoke all on function public.set_together_optin(uuid, boolean) from public, anon;
grant execute on function public.set_together_optin(uuid, boolean) to authenticated;

-- ===========================================================================
-- 3. Writing to the scrapbook
-- ===========================================================================
create or replace function public.add_scrapbook_item(
  other uuid,
  item_kind text,
  item_body text default null,
  path text default null,
  thumb text default null,
  when_on date default null)
returns public.scrapbook_items
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  me uuid := auth.uid();
  pair uuid[];
  day date;
  text_body text;
  saved public.scrapbook_items;
begin
  if me is null then raise exception 'not signed in'; end if;
  if other is null or other = me then raise exception 'Choose a friend'; end if;
  if item_kind is null or item_kind not in ('photo', 'voice', 'note') then
    raise exception 'Unknown scrapbook entry';
  end if;
  pair := public.pair_key(me, other);

  if not exists (select 1 from public.friendships f
                  where f.user_a = pair[1] and f.user_b = pair[2]
                    and f.status = 'accepted') then
    raise exception 'You can only do this with an accepted friend';
  end if;
  if public.blocked_between(pair[1], pair[2]) then raise exception 'Unavailable'; end if;
  if not public.together_active(other) then
    raise exception 'You both need to turn Together on first';
  end if;

  text_body := nullif(btrim(coalesce(item_body, '')), '');
  if text_body is not null then text_body := left(text_body, 1000); end if;

  day := coalesce(when_on, public.ist_date());
  -- Backdating is the point; postdating is a bug with a date picker attached.
  if day > public.ist_date() then day := public.ist_date(); end if;

  if item_kind = 'note' then
    if text_body is null then raise exception 'Write something first'; end if;
    path := null;
    thumb := null;
  else
    if path is null then raise exception 'Nothing was uploaded'; end if;
    -- The uploader owns the object — the same rule storage.objects enforces on
    -- write. Checked again here so a path belonging to somebody else can never
    -- be attached to a row two people can read.
    if split_part(path, '/', 1) <> me::text
       or path !~ '^[0-9a-f-]+/scrapbook/[0-9a-z_.-]+$' then
      raise exception 'invalid media owner';
    end if;
    if thumb is not null and (split_part(thumb, '/', 1) <> me::text
                              or thumb !~ '^[0-9a-f-]+/scrapbook/[0-9a-z_.-]+$') then
      raise exception 'invalid media owner';
    end if;
  end if;

  insert into public.scrapbook_items
    (user_a, user_b, author, kind, body, media_path, thumb_path, media_type, on_date)
  values (pair[1], pair[2], me, item_kind, text_body, path, thumb,
          case item_kind when 'photo' then 'image' when 'voice' then 'audio' else null end,
          day)
  returning * into saved;
  return saved;
end $fn$;
revoke all on function public.add_scrapbook_item(uuid, text, text, text, text, date) from public, anon;
grant execute on function public.add_scrapbook_item(uuid, text, text, text, text, date) to authenticated;

create or replace function public.delete_scrapbook_item(item uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); found_row public.scrapbook_items;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into found_row from public.scrapbook_items s where s.id = item;
  if not found then return; end if;
  if me not in (found_row.user_a, found_row.user_b) then raise exception 'Unavailable'; end if;
  -- Author-only. A shared scrapbook where either person can erase the other's
  -- entry is not a scrapbook, it is a lever.
  if found_row.author <> me then
    raise exception 'Only the person who added this can remove it';
  end if;

  -- Queue the objects BEFORE the row that references them is gone;
  -- claim_media_cleanup() refuses anything still referenced, so ordering it the
  -- other way round is the difference between a collected file and an orphan.
  insert into public.media_cleanup (path, due_at)
  select p, now()
    from unnest(array[found_row.media_path, found_row.thumb_path]) p
   where p is not null
  on conflict (path) do update set due_at = excluded.due_at
   where not media_cleanup.deleting;

  delete from public.scrapbook_items s where s.id = item;
end $fn$;
revoke all on function public.delete_scrapbook_item(uuid) from public, anon;
grant execute on function public.delete_scrapbook_item(uuid) to authenticated;

-- ===========================================================================
-- 4. Media: the scrapbook prefix has to exist in three places
-- ===========================================================================
-- queue_media_cleanup() whitelists the prefixes a client may register, and it
-- did not know about scrapbook — so every scrapbook upload would have thrown
-- 'invalid media owner' before a byte moved. Redefined verbatim with the one
-- prefix added (last applied wins, as everywhere else in this schema).
create or replace function public.queue_media_cleanup(object_path text)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null
     or split_part(object_path, '/', 1) <> auth.uid()::text
     or object_path !~ '^[0-9a-f-]+/(snaps|voice|stories|memories|scrapbook)/[0-9a-z_.-]+$' then
    raise exception 'invalid media owner';
  end if;
  insert into public.media_cleanup(path) values (object_path)
  on conflict(path) do update set due_at = now() + interval '24 hours'
   where not media_cleanup.deleting;
  if not found then raise exception 'Media upload expired; use a new upload'; end if;
end $fn$;
revoke all on function public.queue_media_cleanup(text) from public;
grant execute on function public.queue_media_cleanup(text) to authenticated;

-- ...and the collector has to know a scrapbook row is a reference, or it would
-- cheerfully delete every scrapbook photo 24 hours after it was uploaded.
create or replace function public.claim_media_cleanup(object_path text)
returns boolean language plpgsql security definer set search_path = public as $fn$
begin
  perform 1 from public.media_cleanup where path = object_path and due_at <= now() for update;
  if not found then return false; end if;
  if exists (select 1 from public.messages where media_path = object_path or thumb_path = object_path)
     or exists (select 1 from public.stories where media_path = object_path)
     or exists (select 1 from public.memories where media_path = object_path or thumb_path = object_path)
     or exists (select 1 from public.scrapbook_items where media_path = object_path or thumb_path = object_path) then
    delete from public.media_cleanup where path = object_path;
    return false;
  end if;
  update public.media_cleanup set deleting = true where path = object_path;
  return true;
end $fn$;
revoke all on function public.claim_media_cleanup(text) from public, anon, authenticated;
grant execute on function public.claim_media_cleanup(text) to service_role;

-- ...and the storage read policy has to let the OTHER half of the pair fetch
-- the object. The own-uid-prefix clause already covers the author; without a
-- scrapbook clause a shared scrapbook would render only for whoever uploaded
-- it — which is the missing "stories INSERT grant" failure again, in a
-- different table. Reproduced from 202609090022 with one clause added;
-- nothing else about it changes.
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects for select to authenticated
using (
  bucket_id = 'media' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.messages m
       where (m.media_path = storage.objects.name or m.thumb_path = storage.objects.name)
         and auth.uid() in (m.user_a, m.user_b)
    )
    or exists (
      select 1 from public.stories s
       join public.friendships f
         on f.status = 'accepted'
        and f.user_a = least(s.user_id, auth.uid())
        and f.user_b = greatest(s.user_id, auth.uid())
       where s.media_path = storage.objects.name
    )
    or exists (
      select 1 from public.scrapbook_items sb
       where (sb.media_path = storage.objects.name or sb.thumb_path = storage.objects.name)
         and auth.uid() in (sb.user_a, sb.user_b)
    )
  )
);

-- ===========================================================================
-- 5. The timeline
-- ===========================================================================
-- Text and thumbnails only. A timeline of full-size photos is precisely the
-- screen that would spend a month's egress in an afternoon, so this returns
-- `thumb_path` and never `media_path` — the original is fetched only when a
-- tile is actually opened.
--
-- Everything derived from `messages` is restricted to messages BOTH of you
-- kept (saved_by is a shared array, visible to both parties by design).
-- Anything else would resurrect content ephemerality has already taken away,
-- which is not a timeline, it is a leak with a nice heading.
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

    -- One row per anniversary that has actually happened. generate_series(1, 0)
    -- is empty, so a pair less than a year in gets nothing rather than a
    -- "0 years together" card.
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
end $fn$;
revoke all on function public.together_timeline(uuid) from public, anon;
grant execute on function public.together_timeline(uuid) to authenticated;

-- ===========================================================================
-- 6. "On this day"
-- ===========================================================================
-- IST, like ist_date() and the question of the day. A UTC boundary would turn
-- the capsule over at 05:30 in the morning — five and a half hours after the
-- day it is named for has begun for the two people reading it.
--
-- Previous years only: today's own entries are already on the screen below.
create or replace function public.together_on_this_day(other uuid, lim int default 12)
returns table (
  source     text,
  id         uuid,
  on_date    date,
  years_ago  integer,
  kind       text,
  body       text,
  thumb_path text,
  media_type text,
  author     uuid
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); pair uuid[]; today date := public.ist_date(); year_start date;
begin
  if me is null or other is null then return; end if;
  if not public.together_active(other) then return; end if;
  pair := public.pair_key(me, other);
  year_start := make_date(extract(year from today)::int, 1, 1);

  return query
    select x.source, x.id, x.on_date, x.years_ago, x.kind, x.body,
           x.thumb_path, x.media_type, x.author
      from (
        select 'scrapbook'::text as source,
               si.id as id,
               si.on_date as on_date,
               (extract(year from age(today, si.on_date)))::int as years_ago,
               si.kind::text as kind,
               left(coalesce(si.body, ''), 300)::text as body,
               si.thumb_path as thumb_path,
               si.media_type as media_type,
               si.author as author
          from public.scrapbook_items si
         where si.user_a = pair[1] and si.user_b = pair[2]
           and si.on_date < year_start
           and extract(month from si.on_date) = extract(month from today)
           and extract(day from si.on_date) = extract(day from today)
        union all
        -- Snaps you both kept. Not ordinary messages: those are ephemeral, and
        -- bringing one back a year later would undo the promise that took it
        -- away in the first place.
        select 'kept'::text,
               m.id,
               (m.created_at at time zone 'Asia/Kolkata')::date,
               (extract(year from age(today, (m.created_at at time zone 'Asia/Kolkata')::date)))::int,
               'photo'::text,
               left(coalesce(m.body, ''), 300)::text,
               m.thumb_path,
               coalesce(m.media_type, 'image')::text,
               m.sender_id
          from public.messages m
         where m.user_a = pair[1] and m.user_b = pair[2]
           and m.unsent_at is null and m.media_path is not null
           and cardinality(m.saved_by) > 0
           and (m.created_at at time zone 'Asia/Kolkata')::date < year_start
           and extract(month from (m.created_at at time zone 'Asia/Kolkata')::date)
               = extract(month from today)
           and extract(day from (m.created_at at time zone 'Asia/Kolkata')::date)
               = extract(day from today)
      ) x
     order by x.on_date desc
     limit least(coalesce(lim, 12), 40);
end $fn$;
revoke all on function public.together_on_this_day(uuid, int) from public, anon;
grant execute on function public.together_on_this_day(uuid, int) to authenticated;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090025_together') on conflict (id) do nothing;
