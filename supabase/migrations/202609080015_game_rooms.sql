-- Upgrade existing invitations to authoritative, resumable games.
begin;
alter table public.game_invites
  add column if not exists board text[] not null default array['','','','','','','','',''],
  add column if not exists revision integer not null default 0,
  add column if not exists result text,
  add column if not exists ended_at timestamptz,
  add column if not exists sender_present_at timestamptz,
  add column if not exists recipient_present_at timestamptz;

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
  if r.expires_at<=now() then r.board := array['','','','','','','','','']; r.result := null; end if;
  return r;
end $fn$;

create or replace function public.play_game_move(invite uuid, square integer, expected_revision integer)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites; piece text; line integer[];
begin
  r := public.game_room(invite); -- row lock serializes both devices and retries
  if r.status <> 'accepted' or r.expires_at <= now() or r.ended_at is not null then raise exception 'Game is not active'; end if;
  if square is null or square not between 0 and 8 or expected_revision is null then raise exception 'Invalid move'; end if;
  piece := case when auth.uid()=r.sender_id then 'X' else 'O' end;
  -- A timeout may happen after commit. The same move is safe to retry.
  if r.revision=expected_revision+1 and r.board[square+1]=piece then return r; end if;
  if r.revision<>expected_revision then raise exception 'Board changed. Sync and try again'; end if;
  if r.result is not null or r.board[square+1]<>'' or piece<>(case when r.revision%2=0 then 'X' else 'O' end) then raise exception 'Not a legal move'; end if;
  r.board[square+1] := piece;
  r.revision := r.revision+1;
  foreach line slice 1 in array array[[1,2,3],[4,5,6],[7,8,9],[1,4,7],[2,5,8],[3,6,9],[1,5,9],[3,5,7]] loop
    if r.board[line[1]]=piece and r.board[line[2]]=piece and r.board[line[3]]=piece then r.result := piece; exit; end if;
  end loop;
  if r.result is null and r.revision=9 then r.result := 'draw'; end if;
  update game_invites set board=r.board,revision=r.revision,result=r.result where id=invite returning * into r;
  return r;
end $fn$;

create or replace function public.end_game_room(invite uuid)
returns void language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites;
begin
  r := public.game_room(invite);
  update game_invites set ended_at=coalesce(ended_at,now()),
    status=case when status='pending' then 'dismissed' else status end where id=invite;
end $fn$;

create or replace function public.active_game_rooms()
returns setof public.game_invites language sql stable security definer set search_path=public as $fn$
  select g.* from game_invites g where auth.uid() in (g.sender_id,g.recipient_id)
    and g.status in ('pending','accepted') and g.ended_at is null and g.result is null and g.expires_at>now()
    and exists(select 1 from friendships f where f.user_a=least(g.sender_id,g.recipient_id) and f.user_b=greatest(g.sender_id,g.recipient_id) and f.status='accepted')
    order by g.created_at desc limit 20;
$fn$;

create or replace function public.resolve_game_invite(invite uuid, next_status text)
returns boolean language plpgsql security definer set search_path=public as $fn$
declare r public.game_invites;
begin
  if next_status is null or next_status not in ('accepted','dismissed') then raise exception 'Invalid status'; end if;
  r := public.game_room(invite);
  if auth.uid()<>r.recipient_id or r.expires_at<=now() or r.ended_at is not null then return false; end if;
  if r.status=next_status then return true; end if;
  if r.status<>'pending' then return false; end if;
  update game_invites set status=next_status,responded_at=now() where id=invite;
  return true;
end $fn$;

revoke all on function public.game_room(uuid),public.play_game_move(uuid,integer,integer),public.end_game_room(uuid),public.active_game_rooms() from public,anon;
grant execute on function public.game_room(uuid),public.play_game_move(uuid,integer,integer),public.end_game_room(uuid),public.active_game_rooms() to authenticated;

-- Hide expired games immediately; remove rows on the existing purge schedule.
drop policy if exists game_invites_read on public.game_invites;
create policy game_invites_read on public.game_invites for select to authenticated
  using (auth.uid() in (sender_id,recipient_id) and expires_at>now()
    and exists(select 1 from public.friendships f where f.user_a=least(sender_id,recipient_id) and f.user_b=greatest(sender_id,recipient_id) and f.status='accepted'));
create or replace function public.purge_expired()
returns void language plpgsql security definer set search_path=public as $fn$
begin
  with gone as (
    delete from public.messages
     where kind <> 'call' and saved_by='{}' and (
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


create or replace function public.pending_game_invites()
returns setof public.game_invites language sql stable security definer set search_path=public as $fn$
  select * from public.active_game_rooms() where recipient_id=auth.uid() and status='pending';
$fn$;
create or replace function public.accepted_game_invite_responses()
returns setof public.game_invites language sql stable security definer set search_path=public as $fn$
  select * from public.active_game_rooms() where sender_id=auth.uid() and status='accepted' and sender_seen_at is null;
$fn$;
notify pgrst,'reload schema';
commit;
