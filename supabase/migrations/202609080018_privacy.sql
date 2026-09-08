-- ---------------------------------------------------------------------------
-- Privacy Centre.
--
-- The Profile screen had grown into a pile of unrelated switches, and the ones
-- a person actually reaches for when they feel uneasy — who can reach me, what
-- is this app holding, how do I get out — were either missing or scattered
-- between the others. This migration is the database half of grouping them.
--
-- Five things, in the order they matter:
--
--   1. user_devices   — an honest record of the browsers that have signed in.
--                       It is NOT a session store and deleting a row revokes
--                       nothing; see the comment on the table.
--   2. blocks         — a real boundary, enforced by the messages and
--                       friendships INSERT policies, not by the client.
--   3. locations.expires_at — location sharing that stops on its own.
--   4. my_storage_usage()  — how much of the bucket is yours.
--   5. export_my_data() / delete_my_account() — take it with you, or go.
--
-- Every table here gets RLS policies AND explicit grants in this same file.
-- Table-wide privileges were revoked during hardening, so a policy without a
-- matching grant fails 42501 before RLS is ever consulted — which reads as
-- "the feature is broken", not "the feature is denied".
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Devices
-- ===========================================================================
-- What this is, stated plainly because the UI has to say the same thing:
-- Supabase gives a browser client NO way to enumerate or revoke another
-- device's session. auth.sessions is not exposed through PostgREST and there
-- is no client API for "sign this other phone out". Rather than draw a
-- convincing list of sessions that cannot actually be acted on, this table
-- records what the app genuinely knows: each browser that has been signed in,
-- when it was last seen, and what it looks like. Forgetting a row here tidies
-- the list; it does NOT end that device's session. The one real revocation a
-- client has is auth.signOut({ scope: 'global' }), which ends every session
-- including this one.
--
-- device_key is not in the shape the feature was sketched with, and it has to
-- be: without a stable per-browser key the "upsert on sign in" is an insert on
-- every sign in, and a week later the list is forty rows for one phone. The
-- key is a random uuid minted in localStorage — it identifies a browser
-- profile, and clearing site data legitimately produces a new one.
create table if not exists public.user_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  device_key   text not null check (length(device_key) between 1 and 64),
  label        text not null default 'Unknown device'
                 check (length(label) between 1 and 60),
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (user_id, device_key)
);

create index if not exists user_devices_recent_idx
  on public.user_devices (user_id, last_seen_at desc);

alter table public.user_devices enable row level security;

drop policy if exists user_devices_read on public.user_devices;
create policy user_devices_read on public.user_devices
  for select to authenticated using (user_id = auth.uid());

drop policy if exists user_devices_insert on public.user_devices;
create policy user_devices_insert on public.user_devices
  for insert to authenticated with check (user_id = auth.uid());

-- The client upserts to refresh last_seen_at, which supabase-js sends as
-- ON CONFLICT DO UPDATE — so UPDATE has to be granted and permitted even on
-- the first, non-conflicting insert.
drop policy if exists user_devices_update on public.user_devices;
create policy user_devices_update on public.user_devices
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_devices_delete on public.user_devices;
create policy user_devices_delete on public.user_devices
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.user_devices to authenticated;

-- ===========================================================================
-- 2. Blocks
-- ===========================================================================
-- Own-rows-only: you can read, add and remove your own blocks and nobody
-- else's. Whether YOU have been blocked is deliberately not readable — the
-- only thing a blocked account observes is that sending fails.
create table if not exists public.blocks (
  blocker    uuid not null references public.profiles(id) on delete cascade,
  blocked    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  constraint blocks_not_self check (blocker <> blocked)
);

alter table public.blocks enable row level security;

drop policy if exists blocks_read on public.blocks;
create policy blocks_read on public.blocks
  for select to authenticated using (blocker = auth.uid());

drop policy if exists blocks_insert on public.blocks;
create policy blocks_insert on public.blocks
  for insert to authenticated with check (blocker = auth.uid());

drop policy if exists blocks_delete on public.blocks;
create policy blocks_delete on public.blocks
  for delete to authenticated using (blocker = auth.uid());

-- No UPDATE: a block has nothing to change. Unblocking is a delete.
grant select, insert, delete on public.blocks to authenticated;

-- The policies below have to ask "is this pair blocked in EITHER direction",
-- and blocks_read only shows a caller their own rows — so an inline exists()
-- would see nothing when the other party is the blocker, which is exactly the
-- direction that matters. SECURITY DEFINER is what lets the check see both
-- rows without making anyone's block list readable.
--
-- It answers only for pairs the caller is part of. Granting a general
-- "is A blocking B?" oracle to every signed-in user would turn a private list
-- into a queryable one.
create or replace function public.blocked_between(u1 uuid, u2 uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case
    when auth.uid() is null or auth.uid() not in (u1, u2) then false
    else exists (
      select 1 from public.blocks b
       where (b.blocker = u1 and b.blocked = u2)
          or (b.blocker = u2 and b.blocked = u1))
  end;
$fn$;

revoke all on function public.blocked_between(uuid, uuid) from public, anon;
-- Policy expressions run with the CALLING role's privileges, so authenticated
-- needs EXECUTE or every insert below fails with a permission error.
grant execute on function public.blocked_between(uuid, uuid) to authenticated;

-- Messages: unchanged except for the last clause. Kept verbatim otherwise so
-- the accepted-friendship rule is not quietly weakened by a rewrite.
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    auth.uid() = sender_id and auth.uid() in (user_a, user_b)
    and exists (select 1 from public.friendships f
                 where f.user_a = messages.user_a and f.user_b = messages.user_b
                   and f.status = 'accepted')
    and not public.blocked_between(messages.user_a, messages.user_b)
  );

-- Friend requests: a blocked person cannot re-open the conversation by asking
-- to be friends again. Symmetric, so the blocker cannot accidentally re-add
-- them either — unblock first, which is a deliberate act.
drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (auth.uid() in (user_a, user_b)
              and requested_by = auth.uid()
              and status = 'pending'
              and not public.blocked_between(user_a, user_b));

-- Blocking has to do two things at once, or it is half a block: record the
-- block AND drop the friendship. Everything else in this app gates on an
-- accepted friendship — stories, presence, the private signaling topics, the
-- push relay — so leaving the row in place would block the messages and let
-- the ringing continue.
create or replace function public.block_user(target uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); pair uuid[];
begin
  if me is null then raise exception 'not signed in'; end if;
  if target is null or target = me then raise exception 'cannot block yourself'; end if;
  if not exists (select 1 from public.profiles p where p.id = target) then
    raise exception 'no such account';
  end if;

  insert into public.blocks (blocker, blocked) values (me, target)
    on conflict (blocker, blocked) do nothing;

  pair := public.pair_key(me, target);
  delete from public.friendships f
   where f.user_a = pair[1] and f.user_b = pair[2];
end
$fn$;

revoke all on function public.block_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;

create or replace function public.unblock_user(target uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $fn$
  delete from public.blocks b
   where b.blocker = auth.uid() and b.blocked = target;
$fn$;

revoke all on function public.unblock_user(uuid) from public, anon;
grant execute on function public.unblock_user(uuid) to authenticated;

-- profiles_read is scoped to self plus anyone you share a friendships row
-- with, and block_user deletes that row — so straight after blocking someone
-- the client can no longer read their name, and the list would be a column of
-- uuids. This returns just enough to render the row, for the caller's own
-- blocks only.
create or replace function public.list_my_blocks()
returns table (
  user_id      uuid,
  username     citext,
  display_name text,
  avatar_emoji text,
  avatar_hue   int,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $fn$
  select p.id, p.username, p.display_name, p.avatar_emoji, p.avatar_hue, b.created_at
    from public.blocks b
    join public.profiles p on p.id = b.blocked
   where b.blocker = auth.uid()
   order by b.created_at desc;
$fn$;

revoke all on function public.list_my_blocks() from public, anon;
grant execute on function public.list_my_blocks() to authenticated;

-- ===========================================================================
-- 3. Location sharing that stops on its own
-- ===========================================================================
-- Ghost Mode is still the default and a row still only exists once you tap
-- Share. What was missing is the middle option: share for an hour without
-- having to remember to turn it off. null means "until I turn it off", which
-- is the behaviour every existing row already has.
alter table public.locations add column if not exists expires_at timestamptz;

-- The expiry belongs in the POLICY, exactly like status_notes: an elapsed
-- share is invisible the second it elapses, rather than at whatever point a
-- purge job happens to run. A client-side filter would have been a promise
-- kept by the app rather than by the database.
drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations
  for select to authenticated using (
    (expires_at is null or expires_at > now())
    and (
      user_id = auth.uid()
      or (
        sharing
        and exists (
          select 1 from public.friendships f
           where f.status = 'accepted'
             and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), locations.user_id)
        )
      )
    )
  );

-- locations_write was FOR ALL, and FOR ALL includes SELECT — so it sat beside
-- locations_read as a second, expiry-free way to read your own row, and the
-- rule above would have been true for everyone except the person it is meant
-- to reassure. Split into the three write commands so SELECT has exactly one
-- policy governing it.
drop policy if exists locations_write on public.locations;

drop policy if exists locations_insert on public.locations;
create policy locations_insert on public.locations
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists locations_delete on public.locations;
create policy locations_delete on public.locations
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.locations to authenticated;

-- The trap this closes: once expires_at is in the past the row is invisible,
-- so Snap Map shows "not sharing" — and the Share button upserts lat/lng/
-- sharing WITHOUT touching expires_at, leaving the stale timestamp in place
-- and the user invisible with the switch apparently on. A deliberate re-share
-- therefore clears a spent expiry and returns to "until I turn it off".
--
-- Safe only because nothing writes this table on a timer: Snap Map writes on
-- an explicit tap and nowhere else. A background position push would need this
-- to be much more careful.
create or replace function public.clear_spent_location_expiry()
returns trigger
language plpgsql
as $fn$
begin
  -- OLD is only touched inside the UPDATE branch: referencing it at all in an
  -- INSERT trigger is not something to rely on across versions.
  if new.expires_at is not null and new.expires_at <= now() then
    if tg_op = 'INSERT' then
      new.expires_at := null;
    elsif new.expires_at is not distinct from old.expires_at then
      new.expires_at := null;
    end if;
  end if;
  return new;
end
$fn$;

drop trigger if exists clear_spent_location_expiry on public.locations;
create trigger clear_spent_location_expiry
  before insert or update on public.locations
  for each row execute function public.clear_spent_location_expiry();

-- Reading your own sharing state has to go through a definer function for one
-- reason: once the share has elapsed the policy above hides the row from you
-- too, so the screen could not tell "you were never sharing" from "your hour
-- is up". It deletes the spent row on the way past — Go Ghost deletes rather
-- than flipping a flag so no coordinates linger, and an expiry running out is
-- the same event happening on a timer.
create or replace function public.location_sharing_state()
returns table (sharing boolean, expires_at timestamptz, updated_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid();
begin
  if me is null then return; end if;
  delete from public.locations l
   where l.user_id = me and l.expires_at is not null and l.expires_at <= now();
  return query
    select l.sharing, l.expires_at, l.updated_at
      from public.locations l where l.user_id = me;
end
$fn$;

revoke all on function public.location_sharing_state() from public, anon;
grant execute on function public.location_sharing_state() to authenticated;

-- hours null = until I turn it off. Capped at 24 so a "duration" cannot be
-- used to set something indistinguishable from permanent while looking
-- temporary.
create or replace function public.set_location_expiry(hours numeric)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); result timestamptz;
begin
  if me is null then raise exception 'not signed in'; end if;
  if hours is not null and (hours <= 0 or hours > 24) then
    raise exception 'duration must be between 0 and 24 hours';
  end if;
  update public.locations l
     set expires_at = case when hours is null then null
                           else now() + make_interval(mins => round(hours * 60)::int) end
   where l.user_id = me
  returning l.expires_at into result;
  if not found then raise exception 'Turn on location sharing first'; end if;
  return result;
end
$fn$;

revoke all on function public.set_location_expiry(numeric) from public, anon;
grant execute on function public.set_location_expiry(numeric) to authenticated;

-- Housekeeping for everyone else's spent shares. Already invisible under the
-- policy; this is what stops the coordinates sitting in the table. Operator
-- only, for the cleanup worker.
create or replace function public.purge_expired_locations()
returns void
language sql
volatile
security definer
set search_path = public
as $fn$
  delete from public.locations where expires_at is not null and expires_at <= now();
$fn$;

revoke all on function public.purge_expired_locations() from public, anon, authenticated;
grant execute on function public.purge_expired_locations() to service_role;

-- ===========================================================================
-- 4. Storage usage
-- ===========================================================================
-- Media lives under media/<uid>/(snaps|voice|stories|memories)/<file>, which
-- is the same prefix the storage policies enforce on upload — so "your bytes"
-- is a real, checkable definition rather than an estimate.
--
-- SECURITY DEFINER because storage.objects is not the client's to read in
-- aggregate, and pinned to auth.uid() INSIDE the function so the caller cannot
-- name someone else. It takes no arguments for exactly that reason.
create or replace function public.my_storage_usage()
returns table (
  bytes        bigint,
  objects      integer,
  snap_bytes   bigint,
  voice_bytes  bigint,
  story_bytes  bigint,
  memory_bytes bigint
)
language sql
stable
security definer
set search_path = public
as $fn$
  with mine as (
    select (storage.foldername(o.name))[2] as kind,
           coalesce((o.metadata->>'size')::bigint, 0) as size
      from storage.objects o
     where o.bucket_id = 'media'
       and auth.uid() is not null
       and (storage.foldername(o.name))[1] = auth.uid()::text
  )
  select coalesce(sum(size), 0)::bigint,
         count(*)::integer,
         coalesce(sum(size) filter (where kind = 'snaps'), 0)::bigint,
         coalesce(sum(size) filter (where kind = 'voice'), 0)::bigint,
         coalesce(sum(size) filter (where kind = 'stories'), 0)::bigint,
         coalesce(sum(size) filter (where kind = 'memories'), 0)::bigint
    from mine;
$fn$;

revoke all on function public.my_storage_usage() from public, anon;
grant execute on function public.my_storage_usage() to authenticated;

-- ===========================================================================
-- 5. Export and delete
-- ===========================================================================
-- Built with to_regclass guards and dynamic SQL on purpose. Migrations here
-- are applied by hand and production is deliberately behind on at least one of
-- them (the credit meter). A plain SQL function naming credit_ledger would
-- fail to CREATE on a database that has not applied it — turning a privacy
-- feature into a failed migration for the one project that matters.
create or replace function public.export_my_data()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  me uuid := auth.uid();
  result jsonb := '{}'::jsonb;
  part jsonb;
  tbl text;
  col text;
begin
  if me is null then raise exception 'not signed in'; end if;

  select to_jsonb(p) into part from public.profiles p where p.id = me;
  result := jsonb_build_object(
    'exported_at', now(),
    'account', coalesce(part, 'null'::jsonb)
  );

  -- Tables keyed by a single owning column.
  for tbl, col in select v.t, v.c from (values
      ('memories', 'user_id'),
      ('stories', 'user_id'),
      ('locations', 'user_id'),
      ('status_notes', 'user_id'),
      ('push_subscriptions', 'user_id'),
      ('user_devices', 'user_id'),
      ('blocks', 'blocker'),
      ('story_views', 'viewer_id'),
      ('credit_ledger', 'user_id'),
      ('subscriptions', 'user_id')
    ) v(t, c) loop
    if to_regclass('public.' || tbl) is not null then
      execute format(
        'select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x where x.%I = $1',
        tbl, col) into part using me;
      result := result || jsonb_build_object(tbl, part);
    end if;
  end loop;

  -- Pair-keyed tables: both halves name you.
  for tbl in select v.t from (values
      ('friendships'), ('streaks'), ('anniversaries')
    ) v(t) loop
    if to_regclass('public.' || tbl) is not null then
      execute format(
        'select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x where x.user_a = $1 or x.user_b = $1',
        tbl) into part using me;
      result := result || jsonb_build_object(tbl, part);
    end if;
  end loop;

  -- Messages YOU sent, and nothing else. Everything a friend sent you is
  -- theirs, and the whole premise of this app is that it disappears — putting
  -- it into a permanent file you can hand to anyone would quietly undo that
  -- for the person who trusted it. Said out loud in the export itself so
  -- nobody assumes the file is a complete transcript.
  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at), '[]'::jsonb)
    into part from public.messages m where m.sender_id = me;
  result := result || jsonb_build_object('messages_sent', part);

  if to_regclass('public.prompt_answers') is not null then
    select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into part
      from public.prompt_answers a where a.responder = me;
    result := result || jsonb_build_object('prompt_answers', part);
  end if;

  -- The security ANSWER is a bcrypt hash the client can never read, and it
  -- stays that way in an export: the question only.
  if to_regclass('public.security_questions') is not null then
    select coalesce(jsonb_agg(jsonb_build_object('question', q.question)), '[]'::jsonb)
      into part from public.security_questions q where q.user_id = me;
    result := result || jsonb_build_object('security_question', part);
  end if;

  result := result || jsonb_build_object('notes', jsonb_build_array(
    'Messages other people sent you are not included. They are ephemeral by design and belong to the sender.',
    'Media files are not included — this is the record of them, not the photos and videos themselves.',
    'Your password and your security answer are stored as one-way hashes and cannot be exported.'
  ));

  return result;
end
$fn$;

revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

-- Irreversible. Deleting the auth.users row cascades through profiles and from
-- there through every table in this schema, which is why the client has to
-- state plainly that the conversations go for the other person too: messages
-- are pair-keyed with ON DELETE CASCADE on both halves, so deleting your
-- account deletes the thread, not just your side of it.
create or replace function public.delete_my_account()
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;

  -- Queue the bucket objects BEFORE the rows that reference them are gone.
  -- claim_media_cleanup refuses to delete anything still referenced, so the
  -- worker will pick these up on its next pass once the cascade has run.
  insert into public.media_cleanup (path, due_at)
  select o.name, now()
    from storage.objects o
   where o.bucket_id = 'media'
     and (storage.foldername(o.name))[1] = me::text
  on conflict (path) do update set due_at = excluded.due_at
   where not media_cleanup.deleting;

  -- friendships.blocked_by references profiles with NO action, so a row that
  -- names you as the blocker would refuse the cascade. Every such row is one
  -- of your own pairs and goes anyway, but clearing it first means the delete
  -- can never fail on a technicality at the worst possible moment.
  update public.friendships set blocked_by = null where blocked_by = me;

  -- One statement, and everything else follows it. profiles references
  -- auth.users on delete cascade; every other table references profiles the
  -- same way.
  delete from auth.users where id = me;
end
$fn$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations(id) values ('202609080018_privacy') on conflict (id) do nothing;
