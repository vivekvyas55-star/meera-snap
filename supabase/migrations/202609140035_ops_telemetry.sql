-- ---------------------------------------------------------------------------
-- Operational telemetry. Four things currently fail in silence: a media upload
-- that never lands, a cleanup run that stops collecting, a Realtime channel
-- that drops and never comes back, and a push that is accepted by nobody. Each
-- one looks to the user like "the app is broken" and looks to the operator like
-- nothing at all, because the only evidence is a console line on a phone that
-- has since been closed.
--
-- This follows 202609080016_egress.sql exactly: a table locked the way
-- bot_quotes and prompts are locked (RLS on, no policy, grants revoked), a
-- SECURITY DEFINER writer, operator-only reads from the SQL editor with the
-- queries kept in supabase/operations/. The sink is Postgres. There is no third
-- party, no SDK and no npm dependency: egress and privacy are both scarce here
-- and an analytics vendor spends both.
--
-- ===========================================================================
-- WHAT "ANONYMOUS" MEANS HERE, AND WHERE IT STOPS
-- ===========================================================================
-- Stated plainly, because the cardinal sin in this codebase is a claim the code
-- does not back, and "anonymous telemetry" is the easiest such claim to make.
--
-- What is real:
--   • There is no user id, device id, session id or any other identifier ON a
--     row, and no column that could hold one. This is not a per-event log at
--     all — it is a COUNTER table. A row is (hour, source, kind, code, device
--     class, retry bucket) and two integers. There is nothing in it to join a
--     person to.
--   • Timestamps are truncated to the HOUR before they are stored. A precise
--     timestamp is itself an identifier: messages.created_at is right there,
--     and a telemetry row stamped to the millisecond next to a send is the same
--     row with extra steps. An hour bucket costs the dashboard nothing.
--   • `code` is validated against a strict regex, so it cannot become a
--     free-text field somebody later pipes an error message — or a file path,
--     or a message body — into. A rejected event is dropped, not stored dirty.
--   • Realtime topics are NEVER stored. The topic grammar is
--     `signal:<recipient>:<sender>`, so a raw topic name IS an edge of the
--     social graph. The client sends a topic KIND ('signal', 'typing', …) and
--     the vocabulary check here is what makes that structural rather than
--     polite.
--
-- Where it stops, and this part is not fixable by any schema:
--   • A row written by an authenticated client over PostgREST is attributable
--     AT WRITE TIME regardless of the columns. The request carries a JWT; the
--     platform's own request logs see it. Omitting a user_id column stops the
--     database from remembering who, it does not stop the infrastructure from
--     having known.
--   • `ops_event_budget` below is DELIBERATELY identifying — it is keyed by
--     user_id, because rate-limiting an open write path is not possible without
--     knowing whom to limit. It holds a count and an hour and no event content,
--     it is purged after two days, and it is the one place in this feature an
--     operator could narrow "who was emitting in hour H". That trade is made
--     knowingly: an unlimited write path for any signed-in user is a worse
--     problem than a short-lived counter.
--   • There are THREE real users. k-anonymity is arithmetically unavailable at
--     that size: an hour bucket containing one event is a one-in-three guess
--     before anyone even opens a log. Aggregation here reduces linkage; it does
--     not deliver anonymity, and nothing at this user count could. Do not
--     describe this table to anyone as anonymous data. It is data with the
--     identifiers left out, which is a different and weaker thing.
--
-- What is deliberately NOT collected anywhere in this feature: message bodies,
-- media paths or bytes, coordinates, user agents, IP addresses, endpoints,
-- topics, usernames, display names, recipient ids, error message text.
-- ---------------------------------------------------------------------------
begin;

-- ---------------------------------------------------------------------------
-- The counter table. Not a log — there is no per-event row to correlate.
-- ---------------------------------------------------------------------------
create table if not exists public.ops_events (
  -- Truncated to the hour by the writers. See the note above: precision is an
  -- identifier when the population is three people.
  on_hour timestamptz not null,
  -- Who counted it. 'client' is the only value a signed-in caller can produce;
  -- the server sources come through a service_role-only function, so a client
  -- cannot dress its own numbers up as the push worker's.
  source text not null check (source in ('client', 'push', 'cleanup')),
  kind text not null check (kind in (
    'upload_fail',      -- a media upload that did not land
    'realtime_join',    -- a channel reached SUBSCRIBED (sampled; the denominator)
    'realtime_drop',    -- a channel errored, timed out or closed under us
    'push_attempt',     -- one send, one device
    'push_outcome',     -- what the push service said
    'cleanup_run'       -- one pass of the cleanup worker
  )),
  -- A short code naming WHERE and WHY, from the client's own vocabulary:
  -- 'snap_http_413', 'signal_timeout', 'endpoint_gone'. Constrained hard so it
  -- can never carry content. 32 characters of [a-z0-9_] is enough to name a
  -- failure and far too little to smuggle anything.
  code text not null check (code ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- A CLASS, never a user agent. The vocabulary is closed on purpose: a UA
  -- string is a fingerprint, and "which browser build" has never once been the
  -- thing an operator needed to know here.
  device text not null check (device in (
    'android-chrome', 'android-other', 'ios-pwa', 'ios-safari',
    'desktop', 'other', 'server'
  )),
  -- 0, 1, 2, or 3 meaning "three or more". A raw retry count on a rare failure
  -- is a surprisingly good fingerprint; a bucket answers "is it retrying its
  -- way out of trouble or not" which is the actual question.
  retry_bucket smallint not null default 0 check (retry_bucket between 0 and 3),
  -- How many events were actually reported.
  observed integer not null default 0,
  -- The same events scaled back up by their sampling denominator. A 1-in-20
  -- sampled join contributes 1 to observed and 20 to estimated. EVERY rate and
  -- every threshold must be computed off `estimated`; comparing a sampled
  -- numerator with an unsampled denominator is how an alert lies by a factor
  -- of twenty. Both columns are kept so a reader can always see how much
  -- evidence is behind a number.
  estimated bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (on_hour, source, kind, code, device, retry_bucket)
);

create index if not exists ops_events_hour on public.ops_events (on_hour desc);

-- Locked exactly like ops_metrics, bot_quotes and prompts: RLS on, no policy,
-- grants revoked. Operator data. A signed-in client writes through the function
-- below and can never read a single row back, which also means it can never use
-- this table as a side channel to another user.
alter table public.ops_events enable row level security;
revoke all on public.ops_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The rate limit, and the one identifying artifact in this feature.
--
-- The write path has to be open to signed-in clients — upload failures and
-- Realtime drops happen nowhere else — and an open write path with no ceiling
-- is an abuse vector: one account can otherwise fill this table faster than the
-- purge empties it and drown every real signal in fabricated ones. Limiting
-- requires knowing whom to limit, so this row exists and is keyed by user.
--
-- It holds a COUNT and an HOUR. No kinds, no codes, no link to any ops_events
-- row. Purged after two days by purge_ops_events(). See the honesty note at the
-- top: this is the seam where the anonymisation is a convention rather than a
-- structure, and it is documented rather than hidden.
-- ---------------------------------------------------------------------------
create table if not exists public.ops_event_budget (
  user_id uuid primary key references auth.users(id) on delete cascade,
  on_hour timestamptz not null,
  used integer not null default 0
);
alter table public.ops_event_budget enable row level security;
revoke all on public.ops_event_budget from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The privacy filter, which is this function. Everything a client sends is
-- validated here rather than trusted, because the anon key is in the bundle and
-- a client-side filter is a suggestion. An event that fails any check is
-- SKIPPED — not clamped into something plausible, not stored with a placeholder
-- — so a malformed batch degrades to a smaller true count rather than a full
-- table of fiction.
--
-- Returns the number of events accepted. It never raises: the caller is a
-- telemetry path, and a telemetry path that can throw is a telemetry path that
-- can break a message send.
-- ---------------------------------------------------------------------------
create or replace function public.record_ops_events(events jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me uuid := auth.uid();
  hour_now timestamptz := date_trunc('hour', now());
  budget integer;
  item jsonb;
  accepted integer := 0;
  v_kind text;
  v_code text;
  v_device text;
  v_retry smallint;
  v_n integer;
begin
  if me is null then return 0; end if;
  if jsonb_typeof(events) is distinct from 'array' then return 0; end if;

  -- 120 events an hour is far more than the client's own sampling can produce
  -- in normal use, so a legitimate phone never notices the ceiling; a script
  -- pointed at this function hits it in one batch.
  insert into public.ops_event_budget as b (user_id, on_hour, used)
  values (me, hour_now, 0)
  on conflict (user_id) do update
    set on_hour = case when b.on_hour = hour_now then b.on_hour else hour_now end,
        used    = case when b.on_hour = hour_now then b.used else 0 end
  returning b.used into budget;

  for item in select * from jsonb_array_elements(events) loop
    exit when budget >= 120;
    if jsonb_typeof(item) is distinct from 'object' then continue; end if;

    v_kind   := item->>'kind';
    v_code   := item->>'code';
    v_device := item->>'device';

    -- Vocabulary, not free text. A value outside the closed set is dropped
    -- rather than mapped to 'other', so an unexpected input is visible as
    -- missing data instead of quietly inflating a real bucket.
    continue when v_kind is null or v_kind not in (
      'upload_fail','realtime_join','realtime_drop','push_attempt','push_outcome','cleanup_run');
    continue when v_code is null or v_code !~ '^[a-z][a-z0-9_]{0,31}$';
    continue when v_device is null or v_device not in (
      'android-chrome','android-other','ios-pwa','ios-safari','desktop','other');

    -- A client may not claim to be a server source. `source` is not a parameter
    -- of this function at all; there is nothing to forge.
    v_retry := least(greatest(coalesce((item->>'retries')::integer, 0), 0), 3);
    -- The sampling denominator. Capped: an uncapped `n` lets one event claim a
    -- million, which would move every threshold on its own.
    v_n := least(greatest(coalesce((item->>'n')::integer, 1), 1), 1000);

    insert into public.ops_events as t
      (on_hour, source, kind, code, device, retry_bucket, observed, estimated, updated_at)
    values (hour_now, 'client', v_kind, v_code, v_device, v_retry, 1, v_n, now())
    on conflict (on_hour, source, kind, code, device, retry_bucket) do update
      set observed = t.observed + 1,
          estimated = t.estimated + excluded.estimated,
          updated_at = now();

    accepted := accepted + 1;
    budget := budget + 1;
  end loop;

  update public.ops_event_budget set used = budget where user_id = me;
  return accepted;
exception when others then
  -- Same reasoning as chat_backup.sql's trigger and the credits trigger: a
  -- telemetry problem must never surface as an error on a path a user is
  -- waiting on. The client swallows this too; both halves are deliberate.
  return 0;
end
$fn$;

revoke all on function public.record_ops_events(jsonb) from public, anon;
grant execute on function public.record_ops_events(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- The server-side writer. The push and cleanup Edge Functions run as
-- service_role, count their own work, and report it with no user involved at
-- all — these rows are the genuinely anonymous half of the table, since the
-- cron and the relay are not people.
--
-- Separate from the client function so that `source` can be a parameter here
-- and nowhere else. If clients could name their own source, every guarantee
-- about what 'push' means would be a client-side one.
-- ---------------------------------------------------------------------------
create or replace function public.record_ops_server_events(source text, events jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  hour_now timestamptz := date_trunc('hour', now());
  item jsonb;
  accepted integer := 0;
  v_kind text;
  v_code text;
  v_retry smallint;
  v_n integer;
  v_count integer;
begin
  if source is null or source not in ('push','cleanup') then return 0; end if;
  if jsonb_typeof(events) is distinct from 'array' then return 0; end if;

  for item in select * from jsonb_array_elements(events) loop
    if jsonb_typeof(item) is distinct from 'object' then continue; end if;
    v_kind := item->>'kind';
    v_code := item->>'code';
    continue when v_kind is null or v_kind not in (
      'upload_fail','realtime_join','realtime_drop','push_attempt','push_outcome','cleanup_run');
    continue when v_code is null or v_code !~ '^[a-z][a-z0-9_]{0,31}$';
    v_retry := least(greatest(coalesce((item->>'retries')::integer, 0), 0), 3);
    v_n := least(greatest(coalesce((item->>'n')::integer, 1), 1), 1000);
    -- A server pass counts many identical outcomes at once (20 endpoints, 3
    -- pruned), so it reports a count rather than calling this 20 times.
    v_count := least(greatest(coalesce((item->>'count')::integer, 1), 1), 10000);

    insert into public.ops_events as t
      (on_hour, source, kind, code, device, retry_bucket, observed, estimated, updated_at)
    values (hour_now, source, v_kind, v_code, 'server', v_retry, v_count, v_count::bigint * v_n, now())
    on conflict (on_hour, source, kind, code, device, retry_bucket) do update
      set observed = t.observed + excluded.observed,
          estimated = t.estimated + excluded.estimated,
          updated_at = now();
    accepted := accepted + 1;
  end loop;
  return accepted;
exception when others then
  return 0;
end
$fn$;

revoke all on function public.record_ops_server_events(text, jsonb) from public, anon, authenticated;
grant execute on function public.record_ops_server_events(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Retention. Unbounded growth is a bug, and a metadata store that keeps
-- everything forever is also the wrong answer to "how long do you hold this".
-- Thirty days is two full regression cycles and long enough to see a weekly
-- pattern; the budget rows go after two days because they are the identifying
-- half and have no analytic value at all once the hour has passed.
-- ---------------------------------------------------------------------------
create or replace function public.purge_ops_events()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare removed integer;
begin
  delete from public.ops_events where on_hour < now() - interval '30 days';
  get diagnostics removed = row_count;
  delete from public.ops_event_budget where on_hour < now() - interval '2 days';
  return removed;
end
$fn$;
revoke all on function public.purge_ops_events() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Alerts. A regression is "worse than it has been", so most of these compare
-- the last 24 hours against the preceding week rather than against a number
-- somebody guessed once. Absolute floors sit alongside the ratios so a quiet
-- day with two failures against a previous zero does not page anybody.
--
-- Every figure below is `estimated`, never `observed` — see the column comment.
-- A rate built from a sampled numerator and an unsampled denominator is worse
-- than no alert, because it is confidently wrong in a fixed direction.
--
-- Warnings go into the Postgres log for the same reason record_ops_metrics()
-- does it: it is the only channel this database has that reaches a human
-- without the app being open.
-- ---------------------------------------------------------------------------
create or replace function public.ops_event_alerts()
returns table (alert text, detail text)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  day_start timestamptz := date_trunc('hour', now()) - interval '24 hours';
  week_start timestamptz := date_trunc('hour', now()) - interval '8 days';
  joins bigint; drops bigint;
  attempts bigint; delivered bigint; gone bigint;
  cleanup_fail bigint;
  uploads bigint; uploads_baseline numeric;
begin
  select coalesce(sum(estimated) filter (where kind='realtime_join'), 0),
         coalesce(sum(estimated) filter (where kind='realtime_drop'), 0)
    into joins, drops
    from public.ops_events where on_hour >= day_start;

  -- A drop is normal — phones sleep, networks flap. A drop rate ABOVE the join
  -- rate means channels are dying faster than they are being established, which
  -- is what a broken `realtime_allowed` branch looks like from the outside: the
  -- feature goes silently dead, which is the failure mode CLAUDE.md warns about
  -- for every channel opened without `private: true`.
  if joins + drops >= 50 and drops > joins then
    alert := 'realtime_drops_exceed_joins';
    detail := format('%s drops vs %s joins in 24h (estimated, sampling-scaled)', drops, joins);
    raise warning 'Meera telemetry: %', detail;
    return next;
  end if;

  select coalesce(sum(estimated) filter (where kind='push_attempt'), 0),
         coalesce(sum(estimated) filter (where kind='push_outcome' and code='delivered'), 0),
         coalesce(sum(estimated) filter (where kind='push_outcome' and code='endpoint_gone'), 0)
    into attempts, delivered, gone
    from public.ops_events where on_hour >= day_start and source='push';

  -- Push failing wholesale is invisible from inside the app: the sender sees a
  -- sent message, the recipient's phone simply never rings. A DER-encoded VAPID
  -- signature 401s every single send and looks exactly like this.
  if attempts >= 20 and delivered * 2 < attempts then
    alert := 'push_delivery_collapsed';
    detail := format('%s of %s push attempts delivered in 24h (%s pruned as gone)', delivered, attempts, gone);
    raise warning 'Meera telemetry: %', detail;
    return next;
  end if;

  select coalesce(sum(estimated) filter (where kind='cleanup_run' and code <> 'ok'), 0)
    into cleanup_fail
    from public.ops_events where on_hour >= day_start and source='cleanup';

  -- The cleanup worker runs every 15 minutes: 96 passes a day. A quarter of
  -- them failing means storage is filling with objects nothing will ever
  -- collect, and storage is the egress bill.
  if cleanup_fail >= 24 then
    alert := 'cleanup_failing';
    detail := format('%s failed cleanup passes in 24h (of ~96 scheduled)', cleanup_fail);
    raise warning 'Meera telemetry: %', detail;
    return next;
  end if;

  -- Upload failures are compared against their own recent history rather than
  -- an absolute, because the only honest denominator for "attempts" lives in
  -- ops_metrics (objects actually created), is daily, and is approximate. A
  -- regression against last week needs no denominator at all.
  select coalesce(sum(estimated), 0) into uploads
    from public.ops_events where on_hour >= day_start and kind='upload_fail';
  select coalesce(sum(estimated), 0) / 7.0 into uploads_baseline
    from public.ops_events where on_hour >= week_start and on_hour < day_start and kind='upload_fail';

  if uploads >= 10 and uploads > greatest(uploads_baseline * 3, 10) then
    alert := 'upload_failures_regressed';
    detail := format('%s upload failures in 24h against a daily baseline of %s', uploads, round(uploads_baseline, 1));
    raise warning 'Meera telemetry: %', detail;
    return next;
  end if;

  return;
end
$fn$;
revoke all on function public.ops_event_alerts() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609140035_ops_telemetry') on conflict (id) do nothing;
