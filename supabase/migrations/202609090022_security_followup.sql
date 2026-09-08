-- ---------------------------------------------------------------------------
-- Findings from an adversarial audit that applied every migration into PGlite
-- and probed as anon / owner / friend / stranger. The core boundary held —
-- every cross-user read returned zero rows — so these are the edges.
-- ---------------------------------------------------------------------------
begin;

-- H1. `push_subscriptions.endpoint` is user-writable and the anon key is in the
-- bundle, so a signed-in user could point the push Edge Function at any host on
-- the internet. Worse than plain SSRF: the function signs a VAPID JWT with the
-- endpoint's own origin as the audience, so an attacker-chosen host was handed
-- a token minted with VAPID_PRIVATE_KEY on every send.
--
-- The function now re-checks the host before fetching. This is the other half:
-- a check in the function does not stop the rows being written, and rows
-- written before today would still be there.
delete from public.push_subscriptions
 where endpoint !~ '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)/';

alter table public.push_subscriptions drop constraint if exists push_endpoint_host;
alter table public.push_subscriptions add constraint push_endpoint_host check (
  endpoint ~ '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)/'
);

-- M3. The push VERB is composed server-side from a fixed vocabulary, which is
-- correct — but the SUBJECT is the sender's own display_name, and that had no
-- limit in SQL at all. The 40 characters were a React prop. A friend could put
-- "Meera Security — verify at evil.tld" on your lock screen under Meera's name
-- and icon. The function truncates now; this stops it being stored.
update public.profiles set display_name = left(regexp_replace(display_name, '\s+', ' ', 'g'), 40)
 where display_name is not null and (char_length(display_name) > 40 or display_name ~ '\s\s|\n');
alter table public.profiles drop constraint if exists profile_display_name_len;
alter table public.profiles add constraint profile_display_name_len
  check (display_name is null or char_length(display_name) <= 40) not valid;

-- M2. `block_user()` deletes the friendship as well as writing the block row,
-- and that second half is what actually stops calls and push — both gate on an
-- accepted friendship, not on `blocks`. But INSERT was granted on the table, so
-- a client could write the row directly and skip it: messaging looked blocked
-- while the blocked party could still ring the phone. The RPC is SECURITY
-- DEFINER and keeps working; taking the grant away makes it the only door.
revoke insert on public.blocks from authenticated;
drop policy if exists blocks_insert on public.blocks;

-- L4. A properly blocked user could still reach into the shared history:
-- react to messages, and — the one with teeth — `toggle_saved`, because
-- purge_expired only deletes messages with `saved_by = '{}'`. That let a
-- blocked person pin the conversation open against the ephemeral purge
-- forever. These check only that the caller is in the pair.
create or replace function public.toggle_saved(msg uuid)
returns uuid[] language plpgsql security definer set search_path=public as $fn$
declare m public.messages; out_saved uuid[];
begin
  select * into m from public.messages where id=msg for update;
  if not found or auth.uid() is null or auth.uid() not in (m.user_a, m.user_b) then
    raise exception 'Message unavailable';
  end if;
  if public.blocked_between(m.user_a, m.user_b) then
    raise exception 'Message unavailable';
  end if;
  if m.saved_by @> array[auth.uid()] then
    out_saved := array_remove(m.saved_by, auth.uid());
  else
    out_saved := m.saved_by || auth.uid();
  end if;
  update public.messages set saved_by = out_saved where id = msg returning saved_by into out_saved;
  return out_saved;
end $fn$;
revoke all on function public.toggle_saved(uuid) from public, anon;
grant execute on function public.toggle_saved(uuid) to authenticated;

-- L7. `media_read` matched `messages.media_path` but never `messages.thumb_path`,
-- so the counterparty could read a snap's original and not its thumbnail —
-- and Kept Together renders `thumb_path || media_path` over messages from BOTH
-- parties, so every tile for a snap your friend sent failed to load. A feature
-- shipped in halves, of exactly the kind the contract test cannot see: it
-- checks RPCs and tables, not policy coverage.
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects for select to authenticated
using (
  bucket_id = 'media' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.messages m
       where (m.media_path = storage.objects.name or m.thumb_path = storage.objects.name)
         and auth.uid() in (m.user_a, m.user_b)
    )
    or exists (
      select 1 from public.stories s
       join public.friendships f
         on f.status = 'accepted'
        and f.user_a = least(s.user_id, auth.uid())
        and f.user_b = greatest(s.user_id, auth.uid())
       where s.media_path = storage.objects.name
    )
  )
);

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090022_security_followup') on conflict (id) do nothing;
