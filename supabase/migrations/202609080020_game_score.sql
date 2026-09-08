-- ---------------------------------------------------------------------------
-- A series needs a score. Rounds already alternate who starts
-- (202609080019_rematch.sql), but nothing remembered how the earlier rounds
-- went, so every rematch began as if it were the first game.
--
-- The counters live on the room, next to the board, and are written by the same
-- statement that decides the result — so a win cannot be recorded twice, and a
-- result cannot exist without being counted. Deriving the score from a history
-- table instead would mean a second write that can fail on its own.
-- ---------------------------------------------------------------------------
begin;

alter table public.game_invites
  add column if not exists sender_wins integer not null default 0,
  add column if not exists recipient_wins integer not null default 0,
  add column if not exists draws integer not null default 0;

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
  -- Nine moves THIS ROUND, not nine revisions ever.
  if r.result is null and moves = 9 then r.result := 'draw'; end if;

  -- The score is written by the SAME statement that sets the result. Reaching
  -- this line means result was null on entry (checked above), so the increment
  -- happens exactly once per round however many times the move is retried.
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

-- rematch_game deliberately does NOT touch the counters: carrying the score
-- across rounds is the entire point of having one.

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609080020_game_score') on conflict (id) do nothing;
