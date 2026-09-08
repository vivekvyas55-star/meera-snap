-- ---------------------------------------------------------------------------
-- A finished game was a dead end. Once someone won or the board drew, the only
-- things left were "Save & leave" and "End game for both" — and because
-- active_game_rooms() excluded any room with a result, the room vanished from
-- both players' lists, so a rematch meant going back to Play, picking the friend
-- again, sending a fresh invitation, and waiting for them to accept it. Nobody
-- plays a second round through that.
--
-- A rematch is a new ROUND in the same room, which keeps the whole acceptance
-- and authorisation story exactly as it is.
-- ---------------------------------------------------------------------------
begin;

alter table public.game_invites
  add column if not exists round integer not null default 0,
  -- `revision` stays MONOTONIC for the life of the room. It is the optimistic
  -- concurrency token, and resetting it to zero would make a stale client's
  -- expected_revision from the previous round look valid again in this one.
  -- Where the round began is recorded separately instead.
  add column if not exists round_start_revision integer not null default 0;

-- ---------------------------------------------------------------------------
-- Whose move it is, derived in ONE place. play_game_move and the client both
-- ask this question, and CLAUDE.md already records what happens when two
-- surfaces answer it differently.
--
-- The starter ALTERNATES by round. X moving first every single round hands the
-- inviter a standing advantage — in this game that is not a small thing, since
-- the first player is the only one who can force a win.
-- ---------------------------------------------------------------------------
create or replace function public.game_turn(moves integer, round_no integer)
returns text language sql immutable as $fn$
  select case
    when (moves % 2 = 0) = (round_no % 2 = 0) then 'X'
    else 'O'
  end;
$fn$;
revoke all on function public.game_turn(integer,integer) from public, anon;
grant execute on function public.game_turn(integer,integer) to authenticated;

create or replace function public.play_game_move(invite uuid, square integer, expected_revision integer)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites; piece text; line integer[]; moves integer;
begin
  r := public.game_room(invite); -- row lock serializes both devices and retries
  if r.status <> 'accepted' or r.expires_at <= now() or r.ended_at is not null then raise exception 'Game is not active'; end if;
  if square is null or square not between 0 and 8 or expected_revision is null then raise exception 'Invalid move'; end if;
  piece := case when auth.uid()=r.sender_id then 'X' else 'O' end;
  -- A timeout may happen after commit. The same move is safe to retry.
  if r.revision=expected_revision+1 and r.board[square+1]=piece then return r; end if;
  if r.revision<>expected_revision then raise exception 'Board changed. Sync and try again'; end if;
  moves := r.revision - r.round_start_revision;
  if r.result is not null or r.board[square+1]<>'' or piece <> public.game_turn(moves, r.round) then raise exception 'Not a legal move'; end if;
  r.board[square+1] := piece;
  r.revision := r.revision+1;
  moves := moves + 1;
  foreach line slice 1 in array array[[1,2,3],[4,5,6],[7,8,9],[1,4,7],[2,5,8],[3,6,9],[1,5,9],[3,5,7]] loop
    if r.board[line[1]]=piece and r.board[line[2]]=piece and r.board[line[3]]=piece then r.result := piece; exit; end if;
  end loop;
  -- Nine moves THIS ROUND, not nine revisions ever. The old test was
  -- `revision = 9`, which in round two would have declared a draw partway
  -- through the board and in round three never at all.
  if r.result is null and moves = 9 then r.result := 'draw'; end if;
  update game_invites set board=r.board,revision=r.revision,result=r.result where id=invite returning * into r;
  return r;
end $fn$;
revoke all on function public.play_game_move(uuid,integer,integer) from public, anon;
grant execute on function public.play_game_move(uuid,integer,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Start the next round. Either player may call it; it does not need the other
-- to agree, because the previous game is already over and there is nothing left
-- to lose by clearing the board.
-- ---------------------------------------------------------------------------
create or replace function public.rematch_game(invite uuid)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites;
begin
  r := public.game_room(invite); -- authorises, and locks the row
  if r.status <> 'accepted' or r.expires_at <= now() or r.ended_at is not null then
    raise exception 'Game is not active';
  end if;
  -- Idempotent on purpose. Both players will tap "Play again" at the same
  -- moment on a game they just watched finish together; the second call must
  -- return the fresh board rather than skipping a round past the first.
  if r.result is null then return r; end if;
  update game_invites
     set board = array['','','','','','','','',''],
         result = null,
         round = round + 1,
         round_start_revision = revision
   where id = invite
  returning * into r;
  return r;
end $fn$;
revoke all on function public.rematch_game(uuid) from public, anon;
grant execute on function public.rematch_game(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A finished room has to stay visible for the rematch to be reachable from the
-- conversation. It drops out only when someone ends it, or when it expires.
-- ---------------------------------------------------------------------------
create or replace function public.active_game_rooms()
returns setof public.game_invites language sql stable security definer set search_path=public as $fn$
  select g.* from game_invites g where auth.uid() in (g.sender_id,g.recipient_id)
    and g.status in ('pending','accepted') and g.ended_at is null and g.expires_at>now()
    and exists(select 1 from friendships f where f.user_a=least(g.sender_id,g.recipient_id) and f.user_b=greatest(g.sender_id,g.recipient_id) and f.status='accepted')
    order by g.created_at desc limit 20;
$fn$;
revoke all on function public.active_game_rooms() from public, anon;
grant execute on function public.active_game_rooms() to authenticated;

-- ...but the "they accepted your invitation" banner must NOT come back every
-- time a game finishes. That helper leaned on active_game_rooms() excluding
-- finished rooms; now it says so itself.
create or replace function public.accepted_game_invite_responses()
returns setof public.game_invites language sql stable security definer set search_path=public as $fn$
  select * from public.active_game_rooms()
   where sender_id=auth.uid() and status='accepted' and sender_seen_at is null and result is null;
$fn$;
revoke all on function public.accepted_game_invite_responses() from public, anon;
grant execute on function public.accepted_game_invite_responses() to authenticated;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609080019_rematch') on conflict (id) do nothing;
