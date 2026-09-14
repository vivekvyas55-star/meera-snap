-- ---------------------------------------------------------------------------
-- Scheduled messages — write it now, it sends later.
--
-- THE DECISION, AND WHY. This was deferred three times on one objection, and
-- the objection was right: a scheduled message sits in plaintext for days in an
-- app that clears chats after three visits. Three ways out were on the table.
--
--   Device-local scheduling (hold it in localStorage, send it when the app next
--   opens) was rejected TWICE OVER. It fails SILENTLY — a phone that does not
--   open Meera at 9am means the message simply never sends, and the sender
--   finds out afterwards, if ever. That is the worst failure this app can have:
--   the whole point of scheduling is that you are not there. And it is not even
--   the more private option. localStorage on this device sits behind a 4-digit
--   passcode whose default ships in the source and is documented as public
--   knowledge; Postgres sits behind RLS, which is the one boundary here that
--   actually holds.
--
--   Real encryption was rejected because there is no key infrastructure in this
--   app and building one is not a migration. Claiming encryption we do not have
--   is precisely the "claim the code does not back" failure this codebase keeps
--   catching in itself.
--
-- So: SERVER-SIDE PLAINTEXT, with the window BOUNDED and the user TOLD. The
-- honesty is the feature. Everything below is a bound or a disclosure, and none
-- of it is decoration:
--
--   1. 7-day horizon, in a CHECK constraint, not just in the picker. Past a
--      week this stops being scheduling and becomes storage.
--   2. The pending row is deleted in the SAME TRANSACTION that inserts the real
--      message. No "sent" tombstone: the moment it exists as a message it is an
--      ordinary message and inherits ordinary ephemerality (3-visit clear, the
--      31-day purge, unsend, everything).
--   3. Excluded from private.message_backup — see deliver_scheduled_messages().
--      Otherwise a message that already waited a week server-side would quietly
--      buy itself three more days on delivery.
--   4. SENDER-ONLY RLS. The recipient must not be able to see it before it
--      fires — a surprise you can read early is not one. THIS INVERTS THE
--      CONVENTION of every other pair-keyed table here (messages, friendships,
--      streaks, anniversaries are all pair-readable). It is deliberate. Do not
--      "fix" it by adding the recipient to the read policy.
--   5. Text only. No media path, no media columns, nothing to upload. A
--      scheduled photo is a storage object that is alive-but-unreferenced for a
--      week, which fights claim_media_cleanup's reference check, and it
--      multiplies the retention problem by the size of the object.
--   6. Cancelled on unfriend AND on block — deleted, not delivered. Both, via
--      triggers, because two audits this session found exactly this bug class
--      twice (consent surviving an unfriend; only block_user() clearing it).
--   7. Capped per sender (MAX_PENDING below), so this cannot quietly become a
--      message store with a 7-day retention policy.
--
-- Not applied to production when written; listed in supabase/migrations/.unapplied.
-- ---------------------------------------------------------------------------
begin;

-- ---------------------------------------------------------------------------
-- The table.
--
-- Pair-ordered like every other pair table (user_a < user_b, via pair_key), so
-- the cancellation triggers can match a friendship row directly. sender_id and
-- recipient_id are stored as well as the pair, and a CHECK pins the three
-- together: the pair columns are for matching, the named columns are for
-- meaning, and a row where they disagree is a bug waiting to deliver a message
-- from the wrong person.
-- ---------------------------------------------------------------------------
create table if not exists public.scheduled_messages (
  id           uuid primary key default gen_random_uuid(),
  user_a       uuid not null references public.profiles(id) on delete cascade,
  user_b       uuid not null references public.profiles(id) on delete cascade,
  sender_id    uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body         text not null,
  send_at      timestamptz not null,
  created_at   timestamptz not null default now(),
  constraint ordered_pair_scheduled check (user_a < user_b),
  constraint scheduled_pair_matches check (
    (case when sender_id < recipient_id then sender_id else recipient_id end) = user_a
    and (case when sender_id < recipient_id then recipient_id else sender_id end) = user_b),
  constraint scheduled_not_self check (sender_id <> recipient_id),
  -- A message you cannot see and did not mean to write is not worth keeping.
  -- Rejected rather than capped: add_scrapbook_item CAPS a long paste at 1000
  -- because losing a paste is worse than truncating one, but a message is not a
  -- note — silently sending three quarters of what you wrote, days later, when
  -- you are not there to notice, is a lie about what you said. The UI stops you
  -- at the same number so this should never fire.
  constraint scheduled_body_len check (length(body) between 1 and 2000),
  -- THE HORIZON, in the schema. The picker enforces it too, and the RPC
  -- enforces it again against now(); this is the one nothing can talk its way
  -- past. Compared against created_at rather than now() because a CHECK is
  -- evaluated on write only — comparing to now() would make every existing row
  -- fail revalidation the moment its time arrived.
  constraint scheduled_horizon check (
    send_at > created_at and send_at <= created_at + interval '7 days')
);

create index if not exists scheduled_messages_due_idx
  on public.scheduled_messages (send_at);
create index if not exists scheduled_messages_sender_idx
  on public.scheduled_messages (sender_id);
create index if not exists scheduled_messages_pair_idx
  on public.scheduled_messages (user_a, user_b);

alter table public.scheduled_messages enable row level security;

-- ---------------------------------------------------------------------------
-- RLS: SENDER ONLY. Read your own, cancel your own. Nothing else.
--
-- Note what is NOT here: no insert policy and no update policy, and below, no
-- insert or update GRANT either. The grant is the wall and the RPC is the door
-- (the lesson from 202609090032, where a hardened RPC left its column grant
-- open and the client path was the only one that closed). schedule_message()
-- is the only way a row is ever written, which is what makes the horizon, the
-- cap, the friendship check and the IST wall-clock resolution unforgeable
-- rather than merely enforced-in-one-place.
--
-- There is no update path at all, deliberately. "Edit" is cancel and
-- reschedule, which is one extra tap and cannot leave a half-moved row.
-- ---------------------------------------------------------------------------
drop policy if exists scheduled_read on public.scheduled_messages;
create policy scheduled_read on public.scheduled_messages
  for select to authenticated using (sender_id = auth.uid());

drop policy if exists scheduled_cancel on public.scheduled_messages;
create policy scheduled_cancel on public.scheduled_messages
  for delete to authenticated using (sender_id = auth.uid());

revoke all on public.scheduled_messages from anon, authenticated;
grant select, delete on public.scheduled_messages to authenticated;

-- ---------------------------------------------------------------------------
-- schedule_message(other, body, local_date, local_time)
--
-- TIMES ARE AN IST WALL CLOCK, RESOLVED SERVER-SIDE. The client sends the date
-- and the time the user actually picked — "2026-09-16", "09:00" — and never an
-- absolute instant computed from the device. That is not fussiness: a status
-- note written from a skewed client clock was invisible forever, to everyone
-- including its author, because the client overrode a timestamp the server was
-- perfectly able to compute. The same trap here sends a message at the wrong
-- hour, days later, with nobody watching. Day boundaries in this app are IST
-- (ist_date(), the question of the day, friendship_charms) and India has no DST,
-- so `at time zone 'Asia/Kolkata'` is exact and independent of both the device's
-- clock and the device's timezone.
--
-- Parameter names are part of the API — PostgREST dispatches on them, so
-- renaming one breaks every client in the same breath. The argument is read
-- into a local before the table comes into scope: `body` is also a column name
-- here, and a bare parameter that shadows a column is ambiguous inside an
-- UPDATE (answer_question sat broken in production for exactly that reason).
-- An INSERT's VALUES list has no table columns in scope so it would work by
-- luck; luck is not the plan.
--
-- It returns `setof public.scheduled_messages` rather than a `returns table`
-- for a duller reason: a RETURNS TABLE column is an OUT parameter, so a `body`
-- column and a `body` argument are the same name twice and the function will
-- not create at all. The whole row is the sender's own data either way.
-- ---------------------------------------------------------------------------
create or replace function public.schedule_message(
  other uuid, body text, local_date date, local_time time)
returns setof public.scheduled_messages
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  me       uuid := auth.uid();
  v_body   text;
  v_when   timestamptz;
  v_pair   uuid[];
  v_row    public.scheduled_messages;
  -- THE CAP. 20 pending messages per sender, across every conversation.
  --
  -- The real use is a handful: a birthday note, a good-morning each day of a
  -- week you are away (that is 7), the odd reminder. 20 leaves room for all of
  -- that at once and still bounds the worst case to 20 x 2000 characters — 40 kB
  -- of plaintext per account, for at most a week. Past that this is not
  -- scheduling, it is an outbox with a retention policy, and the whole reason
  -- this feature was deferred three times is that nobody wanted one of those.
  -- It is deliberately a number a real person will never reach and an automated
  -- client hits immediately.
  v_cap    int  := 20;
  v_count  int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if other is null or other = me then raise exception 'choose a friend to send to'; end if;
  v_body := btrim(schedule_message.body);
  if v_body is null or v_body = '' then
    raise exception 'write something to schedule' using errcode = '23514';
  end if;
  if length(v_body) > 2000 then
    raise exception 'that message is too long to schedule (2000 characters)'
      using errcode = '23514';
  end if;

  v_pair := public.pair_key(me, other);

  -- Same gate as messages_insert: an accepted friendship, and not blocked
  -- either way. Checked here because this function is SECURITY DEFINER and so
  -- runs past the policies on public.messages that would otherwise say it.
  if not exists (
    select 1 from public.friendships f
     where f.user_a = v_pair[1] and f.user_b = v_pair[2] and f.status = 'accepted')
  then
    raise exception 'you can only schedule a message to a friend';
  end if;
  if public.blocked_between(v_pair[1], v_pair[2]) then
    raise exception 'you can only schedule a message to a friend';
  end if;

  if local_date is null or local_time is null then
    raise exception 'pick a day and a time';
  end if;
  v_when := (local_date::text || ' ' || local_time::text)::timestamp
              at time zone 'Asia/Kolkata';

  if v_when <= now() then
    raise exception 'that time has already passed' using errcode = '23514';
  end if;
  if v_when > now() + interval '7 days' then
    raise exception 'messages can only be scheduled up to 7 days ahead'
      using errcode = '23514';
  end if;

  select count(*) into v_count from public.scheduled_messages s where s.sender_id = me;
  if v_count >= v_cap then
    raise exception 'you already have % messages waiting to send — cancel one first', v_cap
      using errcode = '23514';
  end if;

  insert into public.scheduled_messages (user_a, user_b, sender_id, recipient_id, body, send_at)
  values (v_pair[1], v_pair[2], me, other, v_body, v_when)
  returning * into v_row;
  return next v_row;
end
$fn$;

revoke all on function public.schedule_message(uuid, text, date, time) from public, anon;
grant execute on function public.schedule_message(uuid, text, date, time) to authenticated;

-- ---------------------------------------------------------------------------
-- deliver_scheduled_messages() — the cron side.
--
-- IDEMPOTENT under a double-fired cron and under a retry, three ways over:
--
--   * `for update skip locked` — a second overlapping run takes nothing rather
--     than racing the first. pg_cron will happily start a second run of a job
--     whose previous run is still going.
--   * the pending row is deleted in the SAME TRANSACTION as the insert, so
--     either both happened or neither did. A crash mid-batch re-sends the ones
--     that rolled back and nothing else.
--   * `client_id` is set to the pending row's own id, so even a pathological
--     double-insert collides with messages_sender_client_unique — the same
--     duplicate-suppression every client send path already uses.
--
-- EXEMPTION FROM private.message_backup (constraint 3). chat_backup.sql puts an
-- AFTER INSERT trigger on public.messages that copies every row and keeps it
-- three days. A scheduled message has already spent up to a week in plaintext
-- server-side; letting it buy three more days on the way out would undo the
-- bound that made the feature acceptable in the first place.
--
-- We do NOT teach private.backup_message() about scheduling. Its insert is
-- wrapped in `begin ... exception when others then null` precisely so a backup
-- problem can never roll back a real send, and it sits on the hottest path in
-- the app. Adding a lookup there would put a new failure mode on every message
-- anyone ever sends, for the sake of the rarest one. Instead: the AFTER INSERT
-- trigger has already run by the time control returns here, in this same
-- transaction, so we delete the copy it just made, by message_id. Nothing ever
-- observes that row — `private` is not exposed by PostgREST, no app role can
-- read it, and the delete commits atomically with the insert. If the backup
-- trigger silently failed (it is allowed to), the delete is a no-op and the
-- outcome is the same.
--
-- The to_regclass guard + dynamic SQL is the export_my_data() pattern: this
-- function must be creatable on a database that has never run chat_backup.sql,
-- and plpgsql would otherwise fail at first call rather than at creation.
-- ---------------------------------------------------------------------------
create or replace function public.deliver_scheduled_messages(batch int default 200)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  pending public.scheduled_messages;
  new_id  uuid;
  sent    int := 0;
begin
  for pending in
    select * from public.scheduled_messages s
     where s.send_at <= now()
     order by s.send_at
     limit batch
     for update skip locked
  loop
    -- Backstop for constraint 6. The triggers below delete these rows the
    -- moment a friendship ends or a block lands, so reaching this branch means
    -- something got past them. It is here because this function is the owner
    -- and therefore runs past messages_insert, which is what would otherwise
    -- have refused the send: without it, a hole in the triggers delivers a
    -- message to somebody who blocked the sender. Deleted, never delivered.
    if not exists (
         select 1 from public.friendships f
          where f.user_a = pending.user_a and f.user_b = pending.user_b
            and f.status = 'accepted')
       or exists (
         select 1 from public.blocks b
          where (b.blocker = pending.sender_id and b.blocked = pending.recipient_id)
             or (b.blocker = pending.recipient_id and b.blocked = pending.sender_id))
    then
      delete from public.scheduled_messages where id = pending.id;
      continue;
    end if;

    insert into public.messages
      (user_a, user_b, sender_id, kind, body, client_id, delivered_at)
    values
      (pending.user_a, pending.user_b, pending.sender_id, 'chat', pending.body,
       pending.id, now())
    on conflict (sender_id, client_id) do nothing
    returning messages.id into new_id;

    if new_id is null then
      -- Only reachable if a previous run's insert committed without its delete,
      -- which the same-transaction rule forbids. Resolve it anyway so the
      -- backup exemption below still applies to the row that does exist.
      select m.id into new_id from public.messages m
       where m.sender_id = pending.sender_id and m.client_id = pending.id;
    end if;

    if new_id is not null and to_regclass('private.message_backup') is not null then
      execute 'delete from private.message_backup where message_id = $1' using new_id;
    end if;

    delete from public.scheduled_messages where id = pending.id;
    sent := sent + 1;
  end loop;
  return sent;
end
$fn$;

-- Operator/cron only. A signed-in user firing the whole queue early is exactly
-- the surprise this feature is supposed to protect.
revoke all on function public.deliver_scheduled_messages(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Constraint 6 — cancelled on unfriend AND on block, deleted rather than
-- delivered. BOTH ways a relationship ends get their own trigger.
--
-- block_user() deletes the friendship as part of blocking, so the friendship
-- trigger alone would cover today's code. It is not enough on its own, and the
-- reason is written down twice in this repo already: this exact bug class was
-- found twice in one audit session — a consent flag that survived an unfriend,
-- and a cleanup that only ran inside block_user(). A direct DELETE on
-- friendships (which is what removeFriend does) and a block are different
-- doors; each needs its own bolt.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_scheduled_on_friendship_end()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  delete from public.scheduled_messages s
   where s.user_a = old.user_a and s.user_b = old.user_b;
  return null;
end
$fn$;

drop trigger if exists trg_cancel_scheduled_unfriend on public.friendships;
create trigger trg_cancel_scheduled_unfriend
  after delete on public.friendships
  for each row execute function public.cancel_scheduled_on_friendship_end();

-- A friendship can also stop being accepted without the row going away.
drop trigger if exists trg_cancel_scheduled_unaccepted on public.friendships;
create trigger trg_cancel_scheduled_unaccepted
  after update on public.friendships
  for each row when (new.status is distinct from 'accepted')
  execute function public.cancel_scheduled_on_friendship_end();

create or replace function public.cancel_scheduled_on_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare pair uuid[] := public.pair_key(new.blocker, new.blocked);
begin
  -- Both directions: blocking someone also cancels what they had waiting for
  -- you. A block is a boundary, not a filter, and a message that arrives after
  -- one is the block failing.
  delete from public.scheduled_messages s
   where s.user_a = pair[1] and s.user_b = pair[2];
  return null;
end
$fn$;

drop trigger if exists trg_cancel_scheduled_block on public.blocks;
create trigger trg_cancel_scheduled_block
  after insert on public.blocks
  for each row execute function public.cancel_scheduled_on_block();

notify pgrst, 'reload schema';

-- Inside the transaction, not after it. An audit this session found 11
-- migrations registering themselves below their own `commit`, where a paste
-- truncated at the wrong byte commits the work and never records it — and the
-- drift check then reports a database that is behind when it is not.
insert into public.schema_migrations(id) values ('202609150040_scheduled_messages')
  on conflict (id) do nothing;

commit;
