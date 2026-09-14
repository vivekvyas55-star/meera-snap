-- 202609140037_deletion_grace.sql
--
-- Deleting your account becomes a decision you can take back for seven days,
-- and the export stops leaving out rows that are plainly yours.
--
-- SHELVED: this id is in supabase/migrations/.unapplied. The client is written
-- to work on a database that does not have it — account_deletion_state()
-- answering PGRST202 makes the screen fall back to the immediate delete that
-- shipped before. Remove the .unapplied line in the same change that applies
-- this, and schedule supabase/operations/schedule_account_purge.sql separately
-- (cron statements have aborted batched transactions on some projects).
--
-- ===========================================================================
-- What a pending deletion means, decided here rather than left to the UI
-- ===========================================================================
-- 1. The account KEEPS WORKING for the whole grace period. Nothing is hidden,
--    no feature is withdrawn, and the person can sign in and cancel. Locking
--    an account during the grace period makes the cancel harder to reach at
--    exactly the moment it matters, and going silent for a week is itself a
--    disclosure to the other person by another route.
-- 2. The OTHER PERSON IS NOT TOLD. A scheduled deletion is a decision that can
--    be withdrawn, so announcing it is a false alarm about somebody else's
--    conversation and a leak of a private decision that may never happen. They
--    find out when it happens, the same as they did before this migration.
-- 3. Because of 1 and 2, anything sent during the grace period is deleted with
--    the rest of it. The client says so; see components/AccountData.jsx.
-- 4. The clock NEVER MOVES ON A REPEAT. request_account_deletion() returns the
--    existing row untouched, so a second tap cannot extend a grace period the
--    user believes is nearly spent, nor shorten one they are relying on.
-- ===========================================================================

-- The grace window, in one place. Both RPCs report it to the client so the
-- copy on screen and the date in the row can never quote different numbers.
create or replace function public.deletion_grace_days()
returns integer
language sql
immutable
set search_path = public
as $fn$ select 7 $fn$;

revoke all on function public.deletion_grace_days() from public, anon;
grant execute on function public.deletion_grace_days() to authenticated;

-- One row per account, and only while a deletion is scheduled. The row
-- existing IS the pending state; cancelling deletes it rather than flipping a
-- flag, for the same reason Go Ghost deletes the location row.
create table if not exists public.deletion_requests (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  requested_at timestamptz not null default now(),
  purge_after  timestamptz not null,
  constraint deletion_requests_ordered check (purge_after > requested_at)
);

alter table public.deletion_requests enable row level security;

-- Read your own, and nothing else. There is deliberately NO insert, update or
-- delete policy and no write grant: the only way a row is written is through
-- the SECURITY DEFINER RPCs below, which is what stops a client choosing its
-- own purge_after — a hand-picked timestamp in the past is an instant delete
-- with no confirmation step, and one a century out is a row that never fires.
drop policy if exists deletion_requests_read on public.deletion_requests;
create policy deletion_requests_read on public.deletion_requests
  for select to authenticated using (user_id = auth.uid());

-- Column-scoped is pointless on a select-only grant, but table-wide privileges
-- were revoked in hardening, so without this line the policy is never even
-- consulted and every read is 42501.
grant select on public.deletion_requests to authenticated;

-- ---------------------------------------------------------------------------
-- The state one call answers
-- ---------------------------------------------------------------------------
-- Always exactly one row, whether or not a deletion is scheduled, so a single
-- round trip answers both "is one pending" and "how long is the grace" — and
-- the client never has to carry a 7 of its own that could drift from this one.
create or replace function public.account_deletion_state()
returns table (pending boolean, requested_at timestamptz, purge_after timestamptz, grace_days integer)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;
  return query
    select r.user_id is not null, r.requested_at, r.purge_after, public.deletion_grace_days()
      from (select null::uuid) z
      left join public.deletion_requests r on r.user_id = me;
end
$fn$;

revoke all on function public.account_deletion_state() from public, anon;
grant execute on function public.account_deletion_state() to authenticated;

create or replace function public.request_account_deletion()
returns table (pending boolean, requested_at timestamptz, purge_after timestamptz, grace_days integer)
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;

  -- do nothing, not do update: a repeat must return the clock that is already
  -- running rather than start a new one. See note 4 at the top of this file.
  insert into public.deletion_requests(user_id, requested_at, purge_after)
  values (me, now(), now() + make_interval(days => public.deletion_grace_days()))
  on conflict (user_id) do nothing;

  return query select * from public.account_deletion_state();
end
$fn$;

revoke all on function public.request_account_deletion() from public, anon;
grant execute on function public.request_account_deletion() to authenticated;

create or replace function public.cancel_account_deletion()
returns table (pending boolean, requested_at timestamptz, purge_after timestamptz, grace_days integer)
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;
  delete from public.deletion_requests where user_id = me;
  return query select * from public.account_deletion_state();
end
$fn$;

revoke all on function public.cancel_account_deletion() from public, anon;
grant execute on function public.cancel_account_deletion() to authenticated;

-- ---------------------------------------------------------------------------
-- The purge itself
-- ---------------------------------------------------------------------------
-- The body that used to live inside delete_my_account(), lifted out so the
-- scheduled job can run it for a user who is not the caller. Everything about
-- it is unchanged; auth.uid() was the only thing in the way.
create or replace function public.purge_account(target uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
begin
  if target is null then raise exception 'no account named'; end if;

  -- Queue the bucket objects BEFORE the rows that reference them are gone.
  -- claim_media_cleanup refuses to delete anything still referenced, so the
  -- worker picks these up on its next pass once the cascade has run.
  insert into public.media_cleanup (path, due_at)
  select o.name, now()
    from storage.objects o
   where o.bucket_id = 'media'
     and (storage.foldername(o.name))[1] = target::text
  on conflict (path) do update set due_at = excluded.due_at
   where not media_cleanup.deleting;

  -- friendships.blocked_by references profiles with NO action, so a row naming
  -- this account as the blocker would refuse the cascade.
  update public.friendships set blocked_by = null where blocked_by = target;

  -- One statement, and everything else follows it. profiles references
  -- auth.users on delete cascade; every other table references profiles the
  -- same way — deletion_requests included, so a purged account cannot leave a
  -- request behind for the job to trip over next time.
  delete from auth.users where id = target;
end
$fn$;

-- Operator-only. A signed-in caller reaching this with somebody else's uuid
-- would be an account-deletion oracle for the whole project.
revoke all on function public.purge_account(uuid) from public, anon, authenticated;
grant execute on function public.purge_account(uuid) to service_role;

-- Still here, still immediate, and still the only thing that can delete YOUR
-- account on the spot. It is what the screen falls back to where this
-- migration is not applied, and the escape hatch in the pending banner for
-- somebody who does not want to wait out their own grace period — or whose
-- purge date has passed because the cron job is not running.
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
  perform public.purge_account(me);
end
$fn$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- The scheduled half. Returns how many it took, so a hand-run in the SQL
-- editor says what it did rather than nothing.
create or replace function public.purge_due_accounts()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare victim uuid; n integer := 0;
begin
  for victim in
    select user_id from public.deletion_requests where purge_after <= now()
  loop
    perform public.purge_account(victim);
    n := n + 1;
  end loop;
  return n;
end
$fn$;

revoke all on function public.purge_due_accounts() from public, anon, authenticated;
grant execute on function public.purge_due_accounts() to service_role;

-- ===========================================================================
-- Export completeness
-- ===========================================================================
-- Two tables whose rows are unambiguously the caller's own writing were simply
-- missing from the export, while the screen described the file as everything
-- you have set. Adding them changes nothing about the deliberate exclusion of
-- other people's messages and media — an entry you wrote in the shared
-- scrapbook is yours, and so is your own opt-in.
--
-- pair_questions is deliberately STILL out: one row holds your question and
-- their answer in the same record, and splitting that is a decision about
-- somebody else's words, not a bug fix. It is named in the file's own notes so
-- the omission is stated rather than silent.
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
      ('subscriptions', 'user_id'),
      ('scrapbook_items', 'author'),
      ('together_optin', 'member'),
      ('deletion_requests', 'user_id')
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
    'Questions of the day are not included: one row holds your question and their answer together, and their answer is theirs.',
    'Your password and your security answer are stored as one-way hashes and cannot be exported.'
  ));

  return result;
end
$fn$;

revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations(id) values ('202609140037_deletion_grace') on conflict (id) do nothing;
