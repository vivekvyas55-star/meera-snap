-- ---------------------------------------------------------------------------
-- A pair's game record survives the room.
--
-- 202609080020 put the series score on the room row — sender_wins /
-- recipient_wins / draws, incremented by the same UPDATE that sets `result`.
-- That is the right place for a SERIES, and it is deliberately transient: a
-- score that lasts one evening is playful precisely because it lasts one
-- evening. But the room itself expires (game_invites.expires_at, swept by
-- purge_expired; an expired room even has its board reset in game_room), so
-- there is no version of "how have we done, ever" anywhere in the app.
--
-- ===========================================================================
-- THE RULE THIS FOLLOWS — 202609140034's, not a new one
-- ===========================================================================
--   MATERIALISE a fact whose evidence is deleted; DERIVE a fact whose source
--   outlives it.
--
-- `streak_milestone` is recorded because bump_streak destroys "we once reached
-- 100" with the same statement that resets the count. A finished round is the
-- same shape: the row carrying it is deleted within the day, and no query can
-- get it back afterwards. So the result is materialised as a together_events
-- row, and everything above it — games played, the split, the per-game
-- breakdown, the longest run — is DERIVED from those rows on read. A second
-- stored aggregate would be a number that can drift from the rows under it,
-- which is the argument credit_ledger makes about balances.
--
-- WHERE the write happens is the same argument 202609080020 makes about the
-- counters: inside play_game_move / play_game_path, on the same code path as
-- the increment, under the same guarantee. Reaching that line means `result`
-- was null on entry — a retried move has already returned — so a round cannot
-- be counted twice and a result cannot exist without being recorded. A
-- separate write that can fail on its own is exactly what that file argues
-- against, and it is not introduced here.
--
-- The recording is nonetheless wrapped in `begin … exception when others then
-- null`, like every trigger in 202609140034 and like chat_backup.sql's insert:
-- a lost record costs a number on a card. A failed move costs the game.
--
-- ===========================================================================
-- THE DEDUPE KEY: the invitation id and the ROUND
-- ===========================================================================
-- `<invite uuid>:<round>`, which is one row per finished round under any
-- retry, and survives rematch_game() by construction:
--
--   * rematch_game starts the next round in the SAME room — same id — and
--     increments `round`, so round 0 and round 1 of one room are two keys.
--   * It never resets `round`, and `revision` is monotonic for the life of the
--     room, so a key is never reused. (revision is deliberately NOT the key: a
--     round's revisions move with every move, and the key has to be stable for
--     the whole round.)
--   * It is idempotent — both players tap "Play again" — and returns early
--     when `result is null`, so it cannot skip a round past the first tap.
--   * A room that expires is deleted by purge_expired, and a new room gets a
--     fresh uuid. Nothing collides across rooms.
--
-- ===========================================================================
-- COLLECTION IS GATED, AND THERE IS NO BACKFILL
-- ===========================================================================
-- together_record_event() refuses to write unless together_pair_active() holds
-- for both people, so nothing is recorded for a pair who have not both opted
-- in. That is a COLLECTION gate rather than a display gate, and it has to be:
-- if events accrued regardless and the opt-in merely hid them, an opt-out
-- would delete a pile that started refilling on the next move.
--
-- The honest cost, which the screen states rather than hides: turning Together
-- on does not invent a past. together_seed_events() is NOT taught about games,
-- on purpose — the rooms those games were played in are gone, and a count
-- guessed from what is left would be a number two people would believe. An
-- opt-out purges these rows with the rest, in the same transaction: they are
-- observations, nobody authored them, so either side withdrawing ends them.
--
-- Nothing here carries a board. The questions the surface answers are how many,
-- who, which game and when — a board would be a copy of a position neither
-- person can do anything with, on a table nobody can delete a row from.
--
-- ORDERING: this file requires 202609140034_timeline_events, which is itself on
-- the shelf (supabase/migrations/.unapplied). Apply that one first, in the same
-- sitting, and remove both lines together. The guard below says so rather than
-- letting `relation "together_events" does not exist` be the error an operator
-- has to interpret.
-- ---------------------------------------------------------------------------
begin;

-- ===========================================================================
-- 0. The dependency, named rather than discovered
-- ===========================================================================
do $$
begin
  if to_regclass('public.together_events') is null then
    raise exception
      'together_events is missing. Apply 202609140034_timeline_events first, then this file.';
  end if;
end $$;

-- ===========================================================================
-- 1. The kind
-- ===========================================================================
-- Widened at its LAST definition. The CHECK is an unnamed column constraint in
-- 202609140034's create table, which Postgres names together_events_kind_check;
-- no later migration touches it (grepped, not assumed — functions and
-- constraints are last-applied-wins across the whole directory). Dropped and
-- re-added by name so a re-run is a no-op rather than a duplicate.
alter table public.together_events drop constraint if exists together_events_kind_check;
alter table public.together_events add constraint together_events_kind_check
  check (kind in ('first_snap', 'first_call', 'first_voice',
                  'mutual_save', 'streak_milestone', 'game_result'));

-- ===========================================================================
-- 2. Recording a finished round
-- ===========================================================================
-- Carries which game, who won, and which round. Not a board.
--
--   dedupe    '<invite>:<round>' — see the header
--   subject   the game CODE ('ttt' / 'c4' / 'checkers'), not a title. The title
--             lives in one place in the client (lib/threadEvent.js GAME_TITLES,
--             which lib/games.js already reads), and a code the bundle has not
--             heard of degrades to "a game" there rather than being mislabelled
--             here forever.
--   actor     the winner, or NULL for a draw. Within this kind NULL is not
--             "unknown": every writer below is the statement that decided the
--             result, and both ids are in the pair by construction. The readers
--             agree with each other — draws are counted as the rows with no
--             actor, and the split adds up to the total.
--   magnitude the round NUMBER, 1-based (the column requires > 0), so a round
--             is answerable without the room it was played in.
--
-- SECURITY DEFINER and granted to nobody: an observation a user can write is a
-- fabrication, and together_events grants SELECT only for that reason.
create or replace function public.together_record_game_result(room public.game_invites)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare winner uuid;
begin
  if room.id is null or room.result is null then return; end if;
  winner := case room.result
              when 'X' then room.sender_id
              when 'O' then room.recipient_id
              else null
            end;
  perform public.together_record_event(
    room.sender_id, room.recipient_id, 'game_result',
    room.id::text || ':' || coalesce(room.round, 0),
    now(), winner,
    greatest(1, least(coalesce(room.round, 0) + 1, 100000)),
    room.game);
end $fn$;
revoke all on function public.together_record_game_result(public.game_invites)
  from public, anon, authenticated;

-- ===========================================================================
-- 3. The two entry points, restated with the recording added
-- ===========================================================================
-- Verbatim from 202609090024_more_games.sql — the live definitions — with one
-- block added to each, immediately after the UPDATE that writes the result and
-- the counters. The argument NAMES are unchanged because PostgREST dispatches
-- on them.
create or replace function public.play_game_move(invite uuid, square integer, expected_revision integer)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites; piece text; line integer[]; moves integer; landing integer; top integer;
begin
  r := public.game_room(invite); -- row lock serializes both devices and retries
  if r.status <> 'accepted' or r.expires_at <= now() or r.ended_at is not null then raise exception 'Game is not active'; end if;
  if square is null or expected_revision is null then raise exception 'Invalid move'; end if;
  if r.game = 'checkers' then raise exception 'Wrong move for this game'; end if;
  piece := case when auth.uid()=r.sender_id then 'X' else 'O' end;
  moves := r.revision - r.round_start_revision;

  if r.game = 'c4' then
    if square not between 0 and 6 then raise exception 'Invalid move'; end if;
    -- A timeout may happen after commit. The retried drop is the one sitting on
    -- top of that column, and only my own move can have advanced the revision
    -- by one from a position where it was my turn.
    top := public.c4_top(r.board, square);
    if r.revision = expected_revision + 1 and top is not null and r.board[top + 1] = piece then return r; end if;
    if r.revision <> expected_revision then raise exception 'Board changed. Sync and try again'; end if;
    landing := public.c4_landing(r.board, square);
    if r.result is not null or landing is null or piece <> public.game_turn(moves, r.round) then raise exception 'Not a legal move'; end if;
    r.board[landing + 1] := piece;
    r.revision := r.revision + 1;
    if public.c4_wins(r.board, landing) then r.result := piece;
    elsif not ('' = any (r.board)) then r.result := 'draw'; end if;
  else
    if square not between 0 and 8 then raise exception 'Invalid move'; end if;
    if r.revision=expected_revision+1 and r.board[square+1]=piece then return r; end if;
    if r.revision<>expected_revision then raise exception 'Board changed. Sync and try again'; end if;
    if r.result is not null or r.board[square+1]<>'' or piece <> public.game_turn(moves, r.round) then raise exception 'Not a legal move'; end if;
    r.board[square+1] := piece;
    r.revision := r.revision+1;
    moves := moves + 1;
    foreach line slice 1 in array array[[1,2,3],[4,5,6],[7,8,9],[1,4,7],[2,5,8],[3,6,9],[1,5,9],[3,5,7]] loop
      if r.board[line[1]]=piece and r.board[line[2]]=piece and r.board[line[3]]=piece then r.result := piece; exit; end if;
    end loop;
    -- Nine moves THIS ROUND, not nine revisions ever.
    if r.result is null and moves = 9 then r.result := 'draw'; end if;
  end if;

  -- The score is written by the SAME statement that sets the result. Reaching
  -- this line means result was null on entry, so the increment happens exactly
  -- once per round however many times the move is retried.
  update game_invites set
    board = r.board,
    revision = r.revision,
    result = r.result,
    sender_wins    = sender_wins    + (case when r.result = 'X' then 1 else 0 end),
    recipient_wins = recipient_wins + (case when r.result = 'O' then 1 else 0 end),
    draws          = draws          + (case when r.result = 'draw' then 1 else 0 end)
  where id = invite returning * into r;

  -- ...and the pair's durable record of it, in the same transaction, resting on
  -- the same `result was null on entry` the increment above rests on. A retried
  -- move returns long before this line, so one finished round is one row; the
  -- unique index over (pair, kind, dedupe) is the second lock on it.
  --
  -- Wrapped the way chat_backup.sql's insert is: a record that fails to write
  -- must never be able to fail the move that produced it.
  if r.result is not null then
    begin
      perform public.together_record_game_result(r);
    exception when others then null;
    end;
  end if;
  return r;
end $fn$;
revoke all on function public.play_game_move(uuid,integer,integer) from public, anon;
grant execute on function public.play_game_move(uuid,integer,integer) to authenticated;

create or replace function public.play_game_path(invite uuid, path integer[], expected_revision integer)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites; side text; moves integer; n integer;
  played text[]; took integer; crowned boolean; idle integer;
begin
  r := public.game_room(invite); -- row lock serializes both devices and retries
  if r.game <> 'checkers' then raise exception 'Wrong move for this game'; end if;
  if r.status <> 'accepted' or r.expires_at <= now() or r.ended_at is not null then raise exception 'Game is not active'; end if;
  n := coalesce(array_length(path, 1), 0);
  if expected_revision is null or n < 2 or path[1] is null or path[n] is null
     or path[1] < 0 or path[1] > 63 or path[n] < 0 or path[n] > 63 then raise exception 'Invalid move'; end if;
  side := case when auth.uid()=r.sender_id then 'X' else 'O' end;
  -- A timeout may happen after commit: the same path is safe to retry, and it
  -- has already been played when my piece is standing on its last square and
  -- its first square is empty. A king taking four in a circle lands back where
  -- it started, so on those paths the first square is not empty and must not be
  -- — the two ends being the same square IS the evidence there.
  if r.revision = expected_revision + 1
     and public.checkers_owner(r.board[path[n] + 1]) = side
     and (path[1] = path[n] or r.board[path[1] + 1] = '') then return r; end if;
  if r.revision <> expected_revision then raise exception 'Board changed. Sync and try again'; end if;
  moves := r.revision - r.round_start_revision;
  if r.result is not null or side <> public.game_turn(moves, r.round) then raise exception 'Not a legal move'; end if;

  select new_board, captured, promoted into played, took, crowned
    from public.checkers_apply(r.board, path, side);
  idle := case when took > 0 or crowned then 0 else r.idle_plies + 1 end;
  r.result := public.checkers_result(played, side);
  -- Two kings can shuffle forever. Fifty plies with nothing taken and nobody
  -- crowned is the standard reading of a game that has stopped moving.
  if r.result is null and idle >= 50 then r.result := 'draw'; end if;

  update game_invites set
    board = played,
    revision = r.revision + 1,
    idle_plies = idle,
    result = r.result,
    sender_wins    = sender_wins    + (case when r.result = 'X' then 1 else 0 end),
    recipient_wins = recipient_wins + (case when r.result = 'O' then 1 else 0 end),
    draws          = draws          + (case when r.result = 'draw' then 1 else 0 end)
  where id = invite returning * into r;

  -- ...and the pair's durable record of it, in the same transaction, resting on
  -- the same `result was null on entry` the increment above rests on. A retried
  -- move returns long before this line, so one finished round is one row; the
  -- unique index over (pair, kind, dedupe) is the second lock on it.
  --
  -- Wrapped the way chat_backup.sql's insert is: a record that fails to write
  -- must never be able to fail the move that produced it.
  if r.result is not null then
    begin
      perform public.together_record_game_result(r);
    exception when others then null;
    end;
  end if;
  return r;
end $fn$;
revoke all on function public.play_game_path(uuid,integer[],integer) from public, anon;
grant execute on function public.play_game_path(uuid,integer[],integer) to authenticated;

-- ===========================================================================
-- 4. The timeline, restated to keep games off it
-- ===========================================================================
-- Verbatim from 202609140034_timeline_events.sql with one clause added to the
-- recorded half. Same seven columns, same signature: widening a `returns table`
-- would need a drop and would break every client that had not shipped yet.
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
       -- Games are the one recorded kind that is neither a first nor a high. A
       -- pair who play most evenings would push every milestone out of the
       -- 120-row window inside a month, and forty cards reading "A moment
       -- together" is not a timeline. They have their own surface below, which
       -- COUNTS them rather than listing them.
       and e.kind <> 'game_result'
     order by e.happened_at desc
     limit 120;
end $fn$;
revoke all on function public.together_timeline(uuid) from public, anon;
grant execute on function public.together_timeline(uuid) to authenticated;
-- ===========================================================================
-- 5. The lifetime record, DERIVED
-- ===========================================================================
-- Two reads, one shape each, both scoped by together_active() — the same gate
-- the timeline uses, so an opt-out closes this the moment either row goes.
--
-- Nothing is stored above the events. A `games_played` column next to the
-- opt-in would be a second number for the same fact, and the first time a purge
-- ran without it nothing could answer which of the two was right.
create or replace function public.together_game_record(other uuid)
returns table (
  games      integer,
  my_wins    integer,
  their_wins integer,
  draws      integer,
  run_best   integer,
  run_mine   boolean,
  first_at   timestamptz,
  last_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); pair uuid[]; holder uuid; best integer;
begin
  if me is null or other is null or other = me then return; end if;
  if not public.together_active(other) then return; end if;
  pair := public.pair_key(me, other);

  -- The longest run of wins by one person: gaps and islands over the events in
  -- the order they happened. The row numbering runs over EVERY result and the
  -- draws are dropped afterwards, which is what makes a draw break a run —
  -- filtering first would renumber two wins either side of a draw as
  -- consecutive and quietly inflate the number.
  with ev as (
    select e.actor, row_number() over (order by e.happened_at, e.id) as seq
      from public.together_events e
     where e.user_a = pair[1] and e.user_b = pair[2] and e.kind = 'game_result'
  ), islands as (
    select ev.actor, ev.seq - row_number() over (partition by ev.actor order by ev.seq) as island
      from ev where ev.actor is not null
  )
  select islands.actor, count(*)::int into holder, best
    from islands group by islands.actor, islands.island
   order by count(*) desc, islands.actor limit 1;

  -- An aggregate with no GROUP BY answers one row whatever is in the table, so
  -- a pair who have played nothing get a real zero rather than no row at all.
  -- No row means something else here — "the two of you are not both opted in" —
  -- and the client has to be able to tell those apart.
  return query
    select count(*)::int,
           count(*) filter (where e.actor = me)::int,
           count(*) filter (where e.actor = other)::int,
           count(*) filter (where e.actor is null)::int,
           coalesce(best, 0),
           case when holder is null then null else holder = me end,
           min(e.happened_at),
           max(e.happened_at)
      from public.together_events e
     where e.user_a = pair[1] and e.user_b = pair[2] and e.kind = 'game_result';
end $fn$;
revoke all on function public.together_game_record(uuid) from public, anon;
grant execute on function public.together_game_record(uuid) to authenticated;

-- One row per game actually played. `game` is the stored code; the client names
-- it. Games with nothing recorded are absent rather than zero — a row of zeros
-- is a sentence about a game the two of you have never opened.
create or replace function public.together_game_breakdown(other uuid)
returns table (
  game       text,
  games      integer,
  my_wins    integer,
  their_wins integer,
  draws      integer,
  last_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare me uuid := auth.uid(); pair uuid[];
begin
  if me is null or other is null or other = me then return; end if;
  if not public.together_active(other) then return; end if;
  pair := public.pair_key(me, other);

  return query
    select coalesce(e.subject, '')::text,
           count(*)::int,
           count(*) filter (where e.actor = me)::int,
           count(*) filter (where e.actor = other)::int,
           count(*) filter (where e.actor is null)::int,
           max(e.happened_at)
      from public.together_events e
     where e.user_a = pair[1] and e.user_b = pair[2] and e.kind = 'game_result'
     group by 1
     order by 2 desc, 1;
end $fn$;
revoke all on function public.together_game_breakdown(uuid) from public, anon;
grant execute on function public.together_game_breakdown(uuid) to authenticated;

notify pgrst, 'reload schema';
-- Registered INSIDE the transaction. An audit found eleven migrations doing
-- this after `commit`, where a paste truncated between the two commits the work
-- and never records it — and the drift check then reports a database that is
-- behind when it is level, or level when it is behind.
insert into public.schema_migrations(id) values ('202609150060_game_records') on conflict (id) do nothing;
commit;
