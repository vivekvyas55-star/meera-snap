begin;
-- One immutable account encryption identity. Login alone cannot unwrap backup.
-- New devices must recover the private identity with the offline recovery key.
create table if not exists public.private_identities (
 user_id uuid primary key references auth.users(id) on delete cascade,
 public_jwk jsonb not null check (public_jwk->>'kty'='EC' and public_jwk->>'crv'='P-256' and public_jwk ? 'x' and public_jwk ? 'y' and not public_jwk ? 'd'),
 recovery_backup jsonb not null check (octet_length(recovery_backup::text)<12000),
 created_at timestamptz not null default now()
);
alter table public.private_identities enable row level security;
revoke all on public.private_identities from public,anon,authenticated;
grant select,insert on public.private_identities to authenticated;
drop policy if exists private_identity_self_read on public.private_identities;
create policy private_identity_self_read on public.private_identities for select to authenticated using (user_id=auth.uid());
drop policy if exists private_identity_self_insert on public.private_identities;
create policy private_identity_self_insert on public.private_identities for insert to authenticated with check (user_id=auth.uid());
create or replace function public.private_peer_identity(other uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select public_jwk from private_identities where user_id=other and auth.uid() is not null and
 (other=auth.uid() or (exists(select 1 from friendships f where f.status='accepted' and array[f.user_a,f.user_b]=pair_key(auth.uid(),other)) and not blocked_between(auth.uid(),other)));
$$;
revoke all on function public.private_peer_identity(uuid) from public,anon;
grant execute on function public.private_peer_identity(uuid) to authenticated;
-- Ciphertext is binary, never active HTML/SVG. Original media remains private.
update storage.buckets set allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','audio/*','video/*','application/octet-stream'] where id='media';
-- Coordinate enrollment with scheduled writes. Do not silently delete old drafts
-- or allow their later plaintext delivery after encryption is enabled.
create or replace function public.guard_private_enrollment()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,160));
 if exists(select 1 from scheduled_messages where new.user_id in (user_a,user_b)) then
   raise exception 'Pending scheduled messages must be sent or cancelled before enabling private content. Ask your contact to cancel incoming scheduled messages.';
 end if;
 return new;
end $$;
revoke all on function public.guard_private_enrollment() from public,anon,authenticated;
drop trigger if exists guard_private_enrollment on public.private_identities;
create trigger guard_private_enrollment before insert on public.private_identities for each row execute function public.guard_private_enrollment();
create or replace function public.guard_private_schedule()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_a::text,160));
 perform pg_advisory_xact_lock(hashtextextended(new.user_b::text,160));
 if exists(select 1 from private_identities where user_id in (new.user_a,new.user_b)) then
   raise exception 'Scheduled sending is unavailable for encrypted conversations. Send directly instead.';
 end if;
 return new;
end $$;
revoke all on function public.guard_private_schedule() from public,anon,authenticated;
drop trigger if exists guard_private_schedule on public.scheduled_messages;
create trigger guard_private_schedule before insert on public.scheduled_messages for each row execute function public.guard_private_schedule();
-- Old clients must fail closed after either party enables encryption.
create or replace function public.enforce_private_messages()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.kind in ('chat','sticker','snap','voice') and exists(select 1 from private_identities where user_id in (new.user_a,new.user_b)) then
   if coalesce(new.body,'') not like 'meera:e2e:1:%' then raise exception 'Encrypted messaging required. Update Meera and verify your contact.'; end if;
   if new.media_path is not null and new.media_path not like '%.meera' then raise exception 'Encrypted media required'; end if;
   if new.thumb_path is not null then raise exception 'Plaintext thumbnails are disabled for encrypted messages'; end if;
 end if;
 return new;
end $$;
revoke all on function public.enforce_private_messages() from public,anon,authenticated;
drop trigger if exists enforce_private_messages on public.messages;
create trigger enforce_private_messages before insert on public.messages for each row execute function public.enforce_private_messages();
-- Owner-only encryption enrollment is not leaked by a public table query.
create or replace function public.my_private_identity_enabled()
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from private_identities where user_id=auth.uid())
$$;
revoke all on function public.my_private_identity_enabled() from public,anon;
grant execute on function public.my_private_identity_enabled() to authenticated;
drop policy if exists encrypted_direct_uploads on storage.objects;
create policy encrypted_direct_uploads on storage.objects as restrictive for insert to authenticated
 with check (bucket_id <> 'media' or not public.my_private_identity_enabled() or (storage.foldername(name))[2] not in ('snaps','voice') or name like '%.meera');
insert into public.schema_migrations(id) values ('202610170160_private_identity') on conflict do nothing;
notify pgrst,'reload schema';
commit;
