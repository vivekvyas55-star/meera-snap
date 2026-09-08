-- Pair-only game invitations. Apply after the existing audit/credits upgrades.
begin;
create table if not exists public.game_invites (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  game text not null check (game in ('ttt')),
  room text not null,
  status text not null default 'pending' check (status in ('pending','accepted','dismissed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  constraint game_invites_distinct check (sender_id <> recipient_id)
);
create index if not exists game_invites_recipient_idx on public.game_invites(recipient_id, status, created_at desc);
alter table public.game_invites enable row level security;
drop policy if exists game_invites_read on public.game_invites;
create policy game_invites_read on public.game_invites for select to authenticated
  using (auth.uid() in (sender_id, recipient_id));
revoke all on public.game_invites from public, anon, authenticated;
grant select on public.game_invites to authenticated;

create or replace function public.create_game_invite(other uuid, game_code text, room_code text)
returns public.game_invites language plpgsql security definer set search_path=public as $fn$
declare row public.game_invites;
begin
  if auth.uid() is null or other is null or other = auth.uid() or game_code <> 'ttt' or room_code is null or length(room_code) > 100 then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.friendships f where f.status='accepted' and f.user_a=least(auth.uid(),other) and f.user_b=greatest(auth.uid(),other)) then raise exception 'not allowed'; end if;
  update public.game_invites set status='dismissed' where recipient_id=other and sender_id=auth.uid() and status='pending';
  insert into public.game_invites(sender_id,recipient_id,game,room) values(auth.uid(),other,game_code,room_code) returning * into row;
  return row;
end $fn$;
revoke all on function public.create_game_invite(uuid,text,text) from public, anon;
grant execute on function public.create_game_invite(uuid,text,text) to authenticated;

create or replace function public.pending_game_invites()
returns setof public.game_invites language sql stable security definer set search_path=public as $fn$
  select * from public.game_invites where recipient_id=auth.uid() and status='pending' and expires_at>now() order by created_at desc limit 20;
$fn$;
revoke all on function public.pending_game_invites() from public, anon;
grant execute on function public.pending_game_invites() to authenticated;

create or replace function public.resolve_game_invite(invite uuid, next_status text)
returns boolean language plpgsql volatile security definer set search_path=public as $fn$
begin
  if next_status not in ('accepted','dismissed') then raise exception 'invalid status'; end if;
  update public.game_invites set status=next_status where id=invite and recipient_id=auth.uid() and status='pending';
  return found;
end $fn$;
revoke all on function public.resolve_game_invite(uuid,text) from public, anon;
grant execute on function public.resolve_game_invite(uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
