-- ---------------------------------------------------------------------------
-- Two more games in the room that already exists.
--
-- Play's room is one game_invites row: it carries the board, the monotonic
-- revision, the round, the presence stamps and the series score, and every
-- surface around it — the invitation flow, acceptance, rematch, the scoreboard,
-- the Play chip in the conversation — is already game-agnostic. So Connect Four
-- and Checkers are added by widening three things and nothing else:
--
--   1. the game vocabulary (`game_invites.game` allowed exactly 'ttt'),
--   2. the starting board, which is no longer nine empty strings for everyone,
--   3. what counts as a move.
--
-- The rules stay where they were: play_game_move is SECURITY DEFINER, derives
-- whose turn it is from public.game_turn(moves, round) rather than trusting the
-- caller, and decides the result itself. Realtime still carries no board.
--
-- A move is a single integer for Tic-Tac-Toe (a square) and for Connect Four (a
-- COLUMN — gravity decides the row, which is why the client cannot be the one
-- to name the cell). Checkers cannot be one integer: a multi-jump is one turn,
-- so it gets play_game_path(invite, integer[], expected_revision), which
-- re-validates every hop of the sequence it is handed.
-- ---------------------------------------------------------------------------
begin;

-- 1. The vocabulary. The original constraint was written inline as
--    `check (game in ('ttt'))`, so it carries the default name.
alter table public.game_invites drop constraint if exists game_invites_game_check;
alter table public.game_invites
  add constraint game_invites_game_check check (game in ('ttt','c4','checkers'));

-- Checkers is the one game here that can go on forever: two kings can shuffle
-- between the same squares for as long as both players are willing. Plies since
-- the last capture or crowning is the standard measure of that, and only the
-- database sees every ply of both players, so it is counted here.
alter table public.game_invites
  add column if not exists idle_plies integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2. The starting board, in ONE place. game_room() resets an expired room with
-- it, rematch_game() clears the board with it and create_game_invite() opens
-- with it; three literals would eventually disagree.
--
-- Boards are flat text[] read in the rendering order of the grid, row 0 at the
-- top: 9 cells for Tic-Tac-Toe, 42 (7 wide) for Connect Four, 64 for Checkers.
-- 'x'/'X' are the inviter's man/king and move UP the board; 'o'/'O' are the
-- recipient's and move down. The uppercase letter is the king, which keeps the
-- owner of a cell readable as the same 'X'/'O' that the results, the score
-- columns and game_turn() already speak.
-- ---------------------------------------------------------------------------
create or replace function public.game_initial_board(game_code text)
returns text[] language sql immutable as $fn$
  select case game_code
    when 'c4' then array_fill(''::text, array[42])
    when 'checkers' then (
      select array_agg(
        case
          when (i / 8 + i % 8) % 2 = 0 then ''  -- light squares are never played on
          when i < 24 then 'o'                  -- rows 0-2
          when i > 39 then 'x'                  -- rows 5-7
          else ''
        end order by i)
      from generate_series(0, 63) i)
    else array_fill(''::text, array[9])
  end;
$fn$;
revoke all on function public.game_initial_board(text) from public, anon;
grant execute on function public.game_initial_board(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Connect Four. Index = row * 7 + col, row 0 at the top.
-- ---------------------------------------------------------------------------

-- Where a disc dropped into this column comes to rest: the lowest empty row.
-- Null means the column is full. The column is constant across the scan, so the
-- largest index is the lowest row.
create or replace function public.c4_landing(board text[], col integer)
returns integer language sql immutable as $fn$
  select max(r * 7 + col) from generate_series(0, 5) r
   where col between 0 and 6 and board[r * 7 + col + 1] = '';
$fn$;

-- The highest occupied cell in a column — what a retried drop landed on top of.
create or replace function public.c4_top(board text[], col integer)
returns integer language sql immutable as $fn$
  select min(r * 7 + col) from generate_series(0, 5) r
   where col between 0 and 6 and board[r * 7 + col + 1] <> '';
$fn$;

-- Four in a row through the cell just filled, scanned both ways along each of
-- the four axes. Out-of-range array subscripts read as NULL in Postgres, and
-- the bounds test in front of them is what actually stops the walk.
create or replace function public.c4_wins(board text[], at integer)
returns boolean language plpgsql immutable as $fn$
declare
  axes integer[] := array[0,1, 1,0, 1,1, 1,-1];
  d integer; sgn integer; step integer; run integer;
  r integer; c integer; nr integer; nc integer; piece text;
begin
  if at is null or at < 0 or at > 41 then return false; end if;
  piece := board[at + 1];
  if piece is null or piece = '' then return false; end if;
  r := at / 7; c := at % 7;
  d := 1;
  while d <= 8 loop
    run := 1;
    foreach sgn in array array[1, -1] loop
      step := 1;
      loop
        nr := r + axes[d] * step * sgn;
        nc := c + axes[d + 1] * step * sgn;
        exit when step > 3 or nr < 0 or nr > 5 or nc < 0 or nc > 6
               or board[nr * 7 + nc + 1] is distinct from piece;
        run := run + 1;
        step := step + 1;
      end loop;
    end loop;
    if run >= 4 then return true; end if;
    d := d + 2;
  end loop;
  return false;
end $fn$;

revoke all on function public.c4_landing(text[],integer), public.c4_top(text[],integer),
  public.c4_wins(text[],integer) from public, anon;
grant execute on function public.c4_landing(text[],integer), public.c4_top(text[],integer),
  public.c4_wins(text[],integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Checkers (English draughts). Index = row * 8 + col, row 0 at the top.
--
-- The rules chosen, and they are choices:
--   * Capture is FORCED — if any jump exists for the side to move, only jumps
--     are legal.
--   * A jump sequence must be played to the end.
--   * Crowning ENDS the turn: a man that reaches the far row is kinged and
--     stops there, even mid-sequence.
--   * Kings step one square diagonally in any direction. No flying kings.
--   * Captured pieces are lifted as they are jumped rather than at the end of
--     the sequence. That differs from the strictest reading only for a path
--     that would re-cross a square it has already captured on, and the client
--     mirrors the same choice.
--   * A side that has no pieces, or none that can move, has lost.
-- ---------------------------------------------------------------------------

create or replace function public.checkers_owner(cell text)
returns text language sql immutable as $fn$
  select case when cell in ('x','X') then 'X' when cell in ('o','O') then 'O' end;
$fn$;

-- Which way this piece may travel, flattened as {dr,dc,dr,dc,...}. A man goes
-- forward only; a king goes both ways.
create or replace function public.checkers_dirs(cell text)
returns integer[] language sql immutable as $fn$
  select case
    when cell = 'x' then array[-1,-1, -1,1]
    when cell = 'o' then array[1,-1, 1,1]
    when cell in ('X','O') then array[-1,-1, -1,1, 1,-1, 1,1]
    else array[]::integer[]
  end;
$fn$;

-- Simple, non-capturing destinations for the piece standing on from_sq.
create or replace function public.checkers_steps(board text[], from_sq integer)
returns integer[] language plpgsql immutable as $fn$
declare dirs integer[]; i integer; r integer; c integer; nr integer; nc integer;
  found integer[] := array[]::integer[];
begin
  if from_sq is null or from_sq < 0 or from_sq > 63 then return found; end if;
  dirs := public.checkers_dirs(board[from_sq + 1]);
  r := from_sq / 8; c := from_sq % 8;
  i := 1;
  while i <= coalesce(array_length(dirs, 1), 0) loop
    nr := r + dirs[i]; nc := c + dirs[i + 1];
    if nr between 0 and 7 and nc between 0 and 7 and board[nr * 8 + nc + 1] = '' then
      found := found || (nr * 8 + nc);
    end if;
    i := i + 2;
  end loop;
  return found;
end $fn$;

-- Landing squares of the jumps available to the piece standing on from_sq.
create or replace function public.checkers_jumps(board text[], from_sq integer)
returns integer[] language plpgsql immutable as $fn$
declare dirs integer[]; i integer; r integer; c integer; enemy text;
  midr integer; midc integer; nr integer; nc integer; found integer[] := array[]::integer[];
begin
  if from_sq is null or from_sq < 0 or from_sq > 63 then return found; end if;
  enemy := case public.checkers_owner(board[from_sq + 1]) when 'X' then 'O' when 'O' then 'X' end;
  if enemy is null then return found; end if;
  dirs := public.checkers_dirs(board[from_sq + 1]);
  r := from_sq / 8; c := from_sq % 8;
  i := 1;
  while i <= coalesce(array_length(dirs, 1), 0) loop
    midr := r + dirs[i]; midc := c + dirs[i + 1];
    nr := r + dirs[i] * 2; nc := c + dirs[i + 1] * 2;
    if nr between 0 and 7 and nc between 0 and 7
       and public.checkers_owner(board[midr * 8 + midc + 1]) = enemy
       and board[nr * 8 + nc + 1] = '' then
      found := found || (nr * 8 + nc);
    end if;
    i := i + 2;
  end loop;
  return found;
end $fn$;

create or replace function public.checkers_can_jump(board text[], side text)
returns boolean language sql immutable as $fn$
  select exists (
    select 1 from generate_series(0, 63) i
     where public.checkers_owner(board[i + 1]) = side
       and coalesce(array_length(public.checkers_jumps(board, i), 1), 0) > 0);
$fn$;

create or replace function public.checkers_can_move(board text[], side text)
returns boolean language sql immutable as $fn$
  select exists (
    select 1 from generate_series(0, 63) i
     where public.checkers_owner(board[i + 1]) = side
       and (coalesce(array_length(public.checkers_jumps(board, i), 1), 0) > 0
         or coalesce(array_length(public.checkers_steps(board, i), 1), 0) > 0));
$fn$;

-- Apply a whole turn — [from, ...landing squares] — validating every hop, the
-- forced capture and the completeness of the sequence. Raises on anything it
-- will not allow, so a caller cannot mistake a rejected move for a played one.
create or replace function public.checkers_apply(
  board text[], path integer[], side text,
  out new_board text[], out captured integer, out promoted boolean)
language plpgsql immutable as $fn$
declare n integer; i integer; cur integer; dest integer; piece text; must boolean; over integer;
begin
  new_board := board; captured := 0; promoted := false;
  n := coalesce(array_length(path, 1), 0);
  -- Twelve pieces is the most anything can capture in one turn.
  if n < 2 or n > 13 then raise exception 'Not a legal move'; end if;
  cur := path[1];
  if cur is null or cur < 0 or cur > 63 then raise exception 'Not a legal move'; end if;
  piece := new_board[cur + 1];
  if public.checkers_owner(piece) is distinct from side then raise exception 'Not a legal move'; end if;
  must := public.checkers_can_jump(board, side);
  for i in 2..n loop
    dest := path[i];
    if dest is null or dest < 0 or dest > 63 or new_board[dest + 1] <> '' then
      raise exception 'Not a legal move';
    end if;
    if promoted then raise exception 'Not a legal move'; end if;  -- crowning ends the turn
    if dest = any (public.checkers_jumps(new_board, cur)) then
      over := ((cur / 8 + dest / 8) / 2) * 8 + ((cur % 8 + dest % 8) / 2);
      new_board[over + 1] := '';
      captured := captured + 1;
    elsif i = 2 and n = 2 and not must and dest = any (public.checkers_steps(new_board, cur)) then
      null;  -- a quiet move, legal only when no capture is on offer
    elsif must then
      raise exception 'A capture is available';
    else
      raise exception 'Not a legal move';
    end if;
    new_board[cur + 1] := '';
    new_board[dest + 1] := piece;
    cur := dest;
    if piece = 'x' and cur < 8 then piece := 'X'; new_board[cur + 1] := 'X'; promoted := true;
    elsif piece = 'o' and cur > 55 then piece := 'O'; new_board[cur + 1] := 'O'; promoted := true;
    end if;
  end loop;
  if captured = 0 and must then raise exception 'A capture is available'; end if;
  if captured > 0 and not promoted
     and coalesce(array_length(public.checkers_jumps(new_board, cur), 1), 0) > 0 then
    raise exception 'Finish the jump';
  end if;
end $fn$;

-- Did that move end the game? The side that cannot move has lost.
create or replace function public.checkers_result(board text[], mover text)
returns text language sql immutable as $fn$
  select case when public.checkers_can_move(board, case when mover = 'X' then 'O' else 'X' end)
    then null else mover end;
$fn$;

revoke all on function public.checkers_owner(text), public.checkers_dirs(text),
  public.checkers_steps(text[],integer), public.checkers_jumps(text[],integer),
  public.checkers_can_jump(text[],text), public.checkers_can_move(text[],text),
  public.checkers_apply(text[],integer[],text), public.checkers_result(text[],text)
  from public, anon;
grant execute on function public.checkers_owner(text), public.checkers_dirs(text),
  public.checkers_steps(text[],integer), public.checkers_jumps(text[],integer),
  public.checkers_can_jump(text[],text), public.checkers_can_move(text[],text),
  public.checkers_apply(text[],integer[],text), public.checkers_result(text[],text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The room functions, generalised. Only the board shape and the move differ.
-- ---------------------------------------------------------------------------

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
  return row;
end $fn$;
revoke all on function public.create_game_invite(uuid,text,text) from public, anon;
grant execute on function public.create_game_invite(uuid,text,text) to authenticated;

create or replace function public.game_room(invite uuid)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites;
begin
  select * into r from game_invites where id=invite for update;
  if not found or auth.uid() is null or auth.uid() not in (r.sender_id,r.recipient_id)
    or not exists(select 1 from friendships where user_a=least(r.sender_id,r.recipient_id) and user_b=greatest(r.sender_id,r.recipient_id) and status='accepted')
    then raise exception 'Game unavailable'; end if;
  if r.expires_at > now() and r.ended_at is null and r.status <> 'dismissed' then
    update game_invites set sender_present_at=case when auth.uid()=sender_id then now() else sender_present_at end,
      recipient_present_at=case when auth.uid()=recipient_id then now() else recipient_present_at end
      where id=invite returning * into r;
  end if;
  if r.expires_at<=now() then r.board := public.game_initial_board(r.game); r.result := null; end if;
  return r;
end $fn$;
revoke all on function public.game_room(uuid) from public, anon;
grant execute on function public.game_room(uuid) to authenticated;

-- One integer: a square in Tic-Tac-Toe, a COLUMN in Connect Four. Checkers is
-- refused here rather than half-handled — it has its own entry point.
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
  return r;
end $fn$;
revoke all on function public.play_game_move(uuid,integer,integer) from public, anon;
grant execute on function public.play_game_move(uuid,integer,integer) to authenticated;

-- A whole turn as a path, because a multi-jump is one turn. The sequence is
-- re-validated hop by hop here; the client's staging is a convenience, never
-- the authority.
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
  return r;
end $fn$;
revoke all on function public.play_game_path(uuid,integer[],integer) from public, anon;
grant execute on function public.play_game_path(uuid,integer[],integer) to authenticated;

-- The next round clears the board this game started from, and resets the idle
-- counter with it — a fresh board has taken nothing yet. The score columns are
-- deliberately left alone: carrying them across rounds is the point of them.
create or replace function public.rematch_game(invite uuid)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites;
begin
  r := public.game_room(invite); -- authorises, and locks the row
  if r.status <> 'accepted' or r.expires_at <= now() or r.ended_at is not null then
    raise exception 'Game is not active';
  end if;
  -- Idempotent on purpose: both players tap "Play again" on a game they just
  -- watched finish together, and the second call must not skip a round.
  if r.result is null then return r; end if;
  update game_invites
     set board = public.game_initial_board(game),
         result = null,
         idle_plies = 0,
         round = round + 1,
         round_start_revision = revision
   where id = invite
  returning * into r;
  return r;
end $fn$;
revoke all on function public.rematch_game(uuid) from public, anon;
grant execute on function public.rematch_game(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090024_more_games') on conflict (id) do nothing;
