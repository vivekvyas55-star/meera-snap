-- ===========================================================================
-- A play invitation leaves a timestamped record in the conversation.
--
-- Until now an invitation was entirely transient: a Realtime broadcast, a
-- 6-second active_game_rooms() poll and a sessionStorage mirror. Once the card
-- was gone, "she asked me to play at 9:40" had no answer anywhere in the app.
--
-- This adds a SIXTH messages.kind, 'game', written server-side in the same
-- transaction that creates the invitation. It is a THREAD EVENT, like a call
-- log — not a chat bubble. GameChat inside the room writes ordinary kind='chat'
-- rows for the same pair into the same thread, which is exactly the collision
-- the owner named, so the two must never be able to be mistaken for each other:
-- a 'game' row is not replyable, forwardable, reactable, savable or unsendable,
-- is never counted as an unread message, and cannot be written by a client at
-- all.
--
-- The precedent is 'call' (call_log.sql), which took a SECOND migration
-- (call_fix.sql) to repair a constraint and an unread badge it broke. Every
-- item that rollout tripped over is handled below, in order.
--
-- ORDERING: this migration makes the database produce a kind the CURRENTLY
-- DEPLOYED bundle has never seen — MessageRow's final `else` branch renders an
-- unknown kind as a photo tile, so a live frontend would show a bogus "Photo"
-- row for every invitation. It is therefore listed in
-- supabase/migrations/.unapplied and must only be applied AFTER the bundle
-- carrying the 'game' branch is live and verified. Remove the line from
-- .unapplied in the same change that applies it.
-- ===========================================================================
begin;

-- 1 -------------------------------------------------------------------------
-- The kind CHECK. Last definition wins across the whole directory; the live
-- one is 202609060000_baseline.sql (the consolidated call_log.sql), which this
-- file supersedes.
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('chat', 'snap', 'voice', 'sticker', 'call', 'game'));

-- 2 -------------------------------------------------------------------------
-- view_seconds. `logCall` put a call's DURATION here and the 1..60 range
-- rejected a missed (0s) or a long (>60s) call; the failure was swallowed by
-- useCall's .catch, so call logs silently never wrote. A game event has no
-- duration and must never be handed one, so rather than widening the exemption
-- the constraint now states all three cases explicitly.
alter table public.messages drop constraint if exists view_seconds_sane;
alter table public.messages add constraint view_seconds_sane
  check (case kind
           when 'call' then true                       -- duration, any length
           when 'game' then view_seconds is null       -- no duration, ever
           else view_seconds is null or view_seconds between 1 and 60
         end);

-- snap_has_media (`kind <> 'snap' or media_path is not null`) already exempts
-- every non-snap kind, so a game event needs no media. Left alone deliberately.

-- 3 -------------------------------------------------------------------------
-- Streaks. A streak advances only when BOTH sides send a real message inside a
-- ~36h window; a one-sided burst must not move it. An invitation is no more a
-- message than a call log is — counting it would let one person advance a
-- SHARED streak alone, simply by tapping Invite. The live definition is the
-- streak_fix.sql one consolidated into the baseline (any two-way daily
-- messaging, forgiving 36h break, advance at most once per ~20h); it is
-- restated here verbatim apart from the widened exclusion on its first line.
create or replace function public.bump_streak()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  s public.streaks%rowtype;
  now_ts timestamptz := now();
  sender_is_a boolean := (new.sender_id = new.user_a);
  a_ts timestamptz;
  b_ts timestamptz;
begin
  -- Thread events are not messages: neither a call log nor a play invitation
  -- counts towards a streak.
  if new.kind in ('call', 'game') then return new; end if;

  insert into public.streaks (user_a, user_b) values (new.user_a, new.user_b)
    on conflict (user_a, user_b) do nothing;
  select * into s from public.streaks
   where user_a = new.user_a and user_b = new.user_b for update;
  if not found then return new; end if;

  -- Break only after a real gap: either side silent for >36h.
  if s.count > 0 and (
       s.last_snap_a is null or s.last_snap_b is null
       or s.last_snap_a < now_ts - interval '36 hours'
       or s.last_snap_b < now_ts - interval '36 hours') then
    s.count := 0; s.last_increment := null;
  end if;

  a_ts := case when sender_is_a then now_ts else s.last_snap_a end;
  b_ts := case when sender_is_a then s.last_snap_b else now_ts end;

  -- Advance once per ~day when BOTH have sent since the last increment.
  if a_ts is not null and b_ts is not null
     and a_ts > now_ts - interval '36 hours'
     and b_ts > now_ts - interval '36 hours'
     and (s.last_increment is null
          or (least(a_ts, b_ts) > s.last_increment
              and s.last_increment < now_ts - interval '20 hours'))
  then
    s.count := greatest(s.count, 0) + 1;
    s.last_increment := now_ts;
  end if;

  update public.streaks
     set count = s.count, last_snap_a = a_ts, last_snap_b = b_ts,
         last_increment = s.last_increment
   where user_a = new.user_a and user_b = new.user_b;
  return new;
end $fn$;

-- 4 -------------------------------------------------------------------------
-- The 3-visit ephemeral clear. `mark_messages_seen` / `leave_seen_messages`
-- (202609060001_audit_fixes.sql) are the live receipt path — mark_chats_opened
-- and clear_viewed_chats were revoked from every client role there. Both are
-- already scoped to an explicit kind list that a caller cannot widen:
--
--   mark_messages_seen   kind in ('chat','sticker','voice','snap')
--   leave_seen_messages  kind in ('chat','voice','sticker')
--                        or (kind='snap' and sender_id=auth.uid())
--
-- so a 'game' id handed to either is ignored, and no game event can have its
-- view_leaves counter incremented or reach cleared_by. That is the same
-- protection core_fixes.sql had to add for a caller's own call log, obtained
-- here for free because the lists are allow-lists. They are deliberately NOT
-- edited: touching a receipt RPC to add a kind that must never appear in it is
-- how the call-log clear regressed the first time. Negative assertions in
-- tests/database.mjs pin this.

-- 5 -------------------------------------------------------------------------
-- The unread badge. `mark_messages_seen` stamps opened_at, which is what an
-- unread row keys off — and call_fix.sql had to add 'call' to the (then live)
-- mark_chats_opened because a received call log left a permanent New badge.
-- That layer changed: mark_messages_seen dropped 'call' when it superseded
-- mark_chats_opened, and ChatList.jsx answers the question client-side instead
-- (`last.kind !== 'call'`).
--
-- A game event belongs in the SAME layer, for two reasons. First, opened_at
-- means "the recipient actually looked at this" — it is written from Chat's
-- IntersectionObserver, which reports only ['chat','sticker'] plus your own
-- snaps, so a game id would never reach the RPC and adding 'game' to it would
-- be dead SQL that merely looks like protection. Second, a thread event has no
-- opened state to record: nobody opens an invitation, they answer it, and the
-- room row already holds that answer. So the badge is excluded in ChatList
-- (extended to every thread event, call included), not here.

-- 6 -------------------------------------------------------------------------
-- Persistence. isVisibleTo (db.js) short-circuits kind==='call' BEFORE the
-- cleared_by check so the 3-visit clear can never make a call log vanish;
-- message_visible is the server half of the same rule. A game event persists
-- the same way, and for the whole point of the feature: "she asked me to play
-- at 9:40" has to still be answerable next week, not for three visits.
create or replace function public.message_visible(m public.messages, viewer uuid)
returns boolean language sql stable set search_path = public as $fn$
 select viewer in (m.user_a,m.user_b) and m.unsent_at is null and (
   m.kind in ('call','game') or cardinality(m.saved_by) > 0 or (
     not (viewer = any(coalesce(m.cleared_by,'{}'::uuid[]))) and
     case when m.kind = 'snap' then
       case when m.sender_id = viewer then m.created_at > now() - interval '31 days'
       else coalesce(m.open_count,0) < 6 and
         coalesce(m.opened_at + interval '24 hours',m.created_at + interval '31 days') > now() end
     else coalesce(m.opened_at + interval '24 hours',m.created_at + interval '31 days') > now() end
   )
 );
$fn$;
revoke all on function public.message_visible(public.messages,uuid) from public;
grant execute on function public.message_visible(public.messages,uuid) to authenticated;

-- 7 -------------------------------------------------------------------------
-- purge_expired. Keeping message_visible and the purge disagreeing is how a
-- row stays visible right up to the moment it is deleted out from under the
-- thread: an unopened game event would have been swept at 31 days while
-- message_visible still returned true for it. 'call' is already exempt; 'game'
-- joins it. Restated from the live definition (202609080015_game_rooms.sql,
-- which carries the thumb_path queue and the game_invites sweep) with only
-- that clause changed.
--
-- message_page and latest_messages are kind-agnostic — both filter through
-- message_visible alone — so a game event pages and previews like any other
-- row with no change. latest_messages returning one as a pair's newest row is
-- intended: that is the chat-list preview this feature wants.
create or replace function public.purge_expired()
returns void language plpgsql security definer set search_path=public as $fn$
begin
  with gone as (
    delete from public.messages
     where kind not in ('call','game') and saved_by='{}' and (
       (opened_at is not null and opened_at<now()-interval '24 hours') or
       (opened_at is null and created_at<now()-interval '31 days') or
       (unsent_at is not null and unsent_at<now()-interval '1 hour') or
       cardinality(cleared_by)>=2
     )
     returning media_path, thumb_path
  )
  insert into public.media_cleanup(path,due_at)
  select distinct path, now()
    from gone cross join lateral unnest(array[media_path, thumb_path]) as f(path)
   where path is not null
  on conflict(path) do update set due_at=excluded.due_at;

  with gone as (
    delete from public.stories where expires_at<now() returning media_path
  )
  insert into public.media_cleanup(path,due_at)
  select distinct media_path,now() from gone where media_path is not null
  on conflict(path) do update set due_at=excluded.due_at;

  delete from public.game_invites where expires_at<=now();
  delete from public.message_visits where created_at<now()-interval '7 days';
end $fn$;

-- 8 -------------------------------------------------------------------------
-- The grant, and who may write a thread event.
--
-- No new column, so no new column grant: the game code rides in `body` the way
-- a call's "video|missed" does, and body already carries an INSERT grant. What
-- the existing grant DOES leave open is forgery — `kind` is in the column
-- grant list, so the moment the CHECK above accepts 'game' any signed-in user
-- could PATCH a convincing "invited you to play" line into a friend's thread
-- with no game behind it. The RPC is a door; the grant is the wall
-- (202609090032). So the wall goes up in the same change: messages_insert is
-- restated verbatim from 202609080018_privacy.sql with one added clause, and a
-- client insert of kind='game' is refused by RLS.
--
-- create_game_invite is SECURITY DEFINER and runs as the table owner, which
-- bypasses RLS (the table is not FORCE ROW LEVEL SECURITY), so the one writer
-- that should be able to write these still can.
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    auth.uid() = sender_id and auth.uid() in (user_a, user_b)
    and kind <> 'game'
    and exists (select 1 from public.friendships f
                 where f.user_a = messages.user_a and f.user_b = messages.user_b
                   and f.status = 'accepted')
    and not public.blocked_between(messages.user_a, messages.user_b)
  );

-- 9 -------------------------------------------------------------------------
-- The write itself, and why exactly one row can exist per invitation.
--
-- It happens inside create_game_invite, in the SAME transaction as the
-- game_invites row, because that is the only place an invitation is created —
-- so the record cannot drift from the fact it records.
--
--   * client_id is set to the invitation's own id, and
--     messages_sender_client_unique (sender_id, client_id) already exists from
--     202609060001. One invitation therefore cannot produce two events even if
--     something outside this function tried: the storage layer refuses it.
--   * `on conflict do nothing` so a replay is a no-op rather than an error.
--   * The paths that REPEAT do not come through here at all — the Realtime
--     re-broadcast and the 6-second active_game_rooms() poll only read, and
--     rematch_game starts the next round inside the SAME room without touching
--     create_game_invite, so a rematch adds no second line.
--   * Tapping Invite twice really is two invitations (the second dismisses the
--     first, as it already did) and honestly reads as two lines.
--
-- The insert is wrapped in begin…exception the way chat_backup.sql's is: a
-- record of the invitation failing to write must never stop the invitation.
-- Restated from 202609090024_more_games.sql, the live definition; the argument
-- NAMES are unchanged because PostgREST dispatches on them.
create or replace function public.create_game_invite(other uuid, game_code text, room_code text)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare row public.game_invites;
begin
  if auth.uid() is null or other is null or other = auth.uid()
     or game_code is null or game_code not in ('ttt','c4','checkers')
     or room_code is null or length(room_code) > 100 then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.friendships f where f.status='accepted'
    and f.user_a=least(auth.uid(),other) and f.user_b=greatest(auth.uid(),other))
    then raise exception 'not allowed'; end if;
  update public.game_invites set status='dismissed'
   where recipient_id=other and sender_id=auth.uid() and status='pending';
  insert into public.game_invites(sender_id,recipient_id,game,room,board)
    values(auth.uid(),other,game_code,room_code,public.game_initial_board(game_code))
    returning * into row;
  begin
    insert into public.messages(user_a,user_b,sender_id,kind,body,client_id,delivered_at)
    values(least(auth.uid(),other), greatest(auth.uid(),other), auth.uid(),
           'game', game_code || '|invited', row.id, now())
    on conflict (sender_id, client_id) do nothing;
  exception when others then null;  -- the game matters more than the record of it
  end;
  return row;
end $fn$;
revoke all on function public.create_game_invite(uuid,text,text) from public, anon;
grant execute on function public.create_game_invite(uuid,text,text) to authenticated;

notify pgrst, 'reload schema';
-- Registered INSIDE the transaction, unlike the eleven migrations an audit
-- found doing it after `commit`: there, a paste truncated between the two
-- commits the work and never records it, and the drift check then reports a
-- database that is behind when it is not (or, worse, level when it is not).
insert into public.schema_migrations(id) values ('202609150041_game_invite_events') on conflict (id) do nothing;
commit;
