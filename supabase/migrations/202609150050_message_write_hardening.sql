-- ---------------------------------------------------------------------------
-- Message write hardening — closing the column grants behind the RPCs.
--
-- H1. `baseline.sql:390` granted UPDATE on six columns of public.messages to
-- authenticated, and `202609090032` revoked exactly one of them (saved_by).
-- `opened_at` was the dangerous one left open, because of how three separate
-- pieces compose:
--
--   1. `messages_update` is `using (auth.uid() in (user_a, user_b))` — either
--      party may update the row.
--   2. `guard_message_update` only blocks CHANGING a non-null value:
--        if old.opened_at is not null and new.opened_at is distinct from old...
--      so null -> any timestamp is permitted, INCLUDING ONE IN THE PAST. There
--      is no CHECK constraint on the column anywhere.
--   3. `message_visible` hides a row once `opened_at + 24h < now()`, and
--      `purge_expired` HARD DELETES it on the same condition.
--
-- So one request from either party —
--
--   PATCH /rest/v1/messages?user_a=eq.X&user_b=eq.Y&opened_at=is.null
--   {"opened_at": "2020-01-01T00:00:00Z"}
--
-- — makes the whole conversation vanish from both phones immediately and be
-- permanently deleted, with its media, by the next cleanup pass (every 15
-- minutes). Unread messages the recipient never saw go too. Unlike unsent_at,
-- which is sender-only and renders as "unsent", it leaves no trace. It forges
-- read receipts as a side effect.
--
-- The fix is a revoke rather than a new guard, because THE CLIENT DOES NOT USE
-- THESE COLUMNS. `markOpened` and `markReplayed` in src/lib/db.js have zero
-- callers outside the test harness; `cleared_at` is referenced by nothing in
-- the entire schema. The real write paths are all SECURITY DEFINER and
-- therefore unaffected by a grant revoke:
--
--   mark_messages_seen   (202609060001)  sets opened_at for received messages
--   record_snap_open     (baseline)      sets opened_at + open_count
--   leave_seen_messages  (202609060001)  the 3-visit ephemerality counter
--
-- That is the whole point of the lesson this codebase already wrote down:
-- "The RPC is a door; the grant is the wall." Hardening record_snap_open while
-- leaving `opened_at` writable closed the door and left the wall open.
--
-- `screenshot_at` keeps a door because SnapViewer legitimately needs one, but
-- it is now an RPC with the recipient check the raw grant could not express.
--
-- M1. `react_to_message` (baseline:904) checks pair membership and nothing
-- else. `202609090022`'s own comment names it — "A properly blocked user could
-- still reach into the shared history: react to messages, and ... toggle_saved"
-- — and then hardens only toggle_saved. block_user() deletes the friendship,
-- but react_to_message never looked at one, so a blocked person could keep
-- dropping emoji onto messages in the victim's thread. Closed here.
-- ---------------------------------------------------------------------------

begin;

-- 1. The three columns no client writes. `unsent_at` and `saved_by` keep their
--    existing treatment: saved_by was revoked by 0032 (toggle_saved is its
--    door), unsent_at is sender-scoped by guard_message_update and is a
--    visible, reversible action.
revoke update (opened_at, replayed_at, cleared_at) on public.messages from authenticated;

-- 2. Belt and braces on the trigger. Even if a later migration re-widens the
--    grant — which has now happened twice in this repo, both times silently —
--    a backdated open is refused. now() is what every sanctioned path writes,
--    so this cannot affect them; the 1-minute slack absorbs clock skew between
--    the statement and the trigger.
create or replace function public.guard_message_open_at()
returns trigger language plpgsql as $fn$
begin
  if new.opened_at is not null and old.opened_at is null
     and new.opened_at < now() - interval '1 minute' then
    raise exception 'opened_at cannot be backdated';
  end if;
  return new;
end $fn$;

drop trigger if exists guard_message_open_at on public.messages;
create trigger guard_message_open_at
  before update of opened_at on public.messages
  for each row execute function public.guard_message_open_at();

-- 3. The one legitimate caller keeps a door, with the check a column grant
--    cannot express: only the RECIPIENT may mark a screenshot, and only once.
--    Set-once matters because screenshot_at is a claim shown to the other
--    person (lib/status.js renders it as "Screenshot!"), so it must not be
--    re-writable to a different time.
create or replace function public.mark_screenshot(msg uuid)
returns void language sql security definer set search_path = public as $fn$
  update public.messages
     set screenshot_at = now()
   where id = msg
     and auth.uid() in (user_a, user_b)
     and sender_id <> auth.uid()
     and screenshot_at is null;
$fn$;
revoke all on function public.mark_screenshot(uuid) from public, anon;
grant execute on function public.mark_screenshot(uuid) to authenticated;

-- ...and the raw grant it replaces goes too.
revoke update (screenshot_at) on public.messages from authenticated;

-- 4. M1: a blocked user cannot reach into the shared history.
--    blocked_between() is SECURITY DEFINER on purpose — blocks_read shows a
--    caller only their OWN rows, so an inline exists() would be blind in
--    exactly the direction that matters.
create or replace function public.react_to_message(msg uuid, emoji text)
returns void language sql security definer set search_path = public as $fn$
  update public.messages
     set reactions = case when emoji is null or emoji = ''
                          then reactions - auth.uid()::text
                          else jsonb_set(reactions, array[auth.uid()::text], to_jsonb(emoji), true) end
   where id = msg
     and auth.uid() in (user_a, user_b)
     and not public.blocked_between(user_a, user_b);
$fn$;
revoke all on function public.react_to_message(uuid, text) from public, anon;
grant execute on function public.react_to_message(uuid, text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations(id) values ('202609150050_message_write_hardening') on conflict (id) do nothing;

commit;
