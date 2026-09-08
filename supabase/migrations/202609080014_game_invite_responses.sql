-- Durable game-invite responses. The inviter may be offline when an invite is
-- accepted, so keep the response until that inviter opens or dismisses it.
begin;

alter table public.game_invites
  add column if not exists responded_at timestamptz,
  add column if not exists sender_seen_at timestamptz;

create index if not exists game_invites_sender_response_idx
  on public.game_invites(sender_id, status, sender_seen_at, responded_at desc);

create or replace function public.resolve_game_invite(invite uuid, next_status text)
returns boolean language plpgsql volatile security definer set search_path=public as $fn$
begin
  if next_status not in ('accepted','dismissed') then raise exception 'invalid status'; end if;
  update public.game_invites
     set status=next_status, responded_at=now()
   where id=invite and recipient_id=auth.uid() and status='pending' and expires_at>now();
  return found;
end $fn$;
revoke all on function public.resolve_game_invite(uuid,text) from public,anon;
grant execute on function public.resolve_game_invite(uuid,text) to authenticated;

create or replace function public.accepted_game_invite_responses()
returns setof public.game_invites language sql stable security definer set search_path=public as $fn$
  select * from public.game_invites
   where sender_id=auth.uid() and status='accepted' and sender_seen_at is null and expires_at>now()
   order by responded_at desc nulls last, created_at desc limit 20;
$fn$;
revoke all on function public.accepted_game_invite_responses() from public,anon;
grant execute on function public.accepted_game_invite_responses() to authenticated;

create or replace function public.acknowledge_game_invite(invite uuid)
returns boolean language plpgsql volatile security definer set search_path=public as $fn$
begin
  update public.game_invites set sender_seen_at=now()
   where id=invite and sender_id=auth.uid() and status='accepted';
  return found;
end $fn$;
revoke all on function public.acknowledge_game_invite(uuid) from public,anon;
grant execute on function public.acknowledge_game_invite(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
