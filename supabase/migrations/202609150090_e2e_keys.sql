-- ===========================================================================
-- Public keys for end-to-end encrypted media.
--
-- STAGE 2 OF 4, and it changes nothing a user can see. Stage 1 was the crypto
-- layer (src/lib/e2e.js); this is where a device publishes the half of its
-- identity other people need. Media is still uploaded in the clear until the
-- upload and viewer paths are converted, and nothing in the app may describe
-- itself as end-to-end encrypted before that. Applying this early is safe and
-- deliberate: keys have to exist and be readable for a while BEFORE the first
-- encrypted object is sent, or the first send has nobody to wrap a key for.
--
-- WHAT IS PUBLIC AND WHAT IS NOT
--
--   public_jwk   the ECDH P-256 PUBLIC key. Public by construction — it is
--                useless without the private half, and every accepted friend
--                needs it to wrap a content key to you.
--   backup       the device's PRIVATE key, wrapped under the user's own
--                passphrase (PBKDF2 210k, AES-GCM — wrapIdentityForBackup).
--                The server stores ciphertext it cannot open. It is SELECT-own
--                only: a friend must never be able to read even the wrapped
--                form, because then the only thing between them and your key
--                is a passphrase they can attack offline at their leisure.
--
-- The backup column is nullable and stays null until somebody sets a
-- passphrase. A device with no backup is not broken — it simply cannot be
-- recovered, which is the honest default rather than a silent one.
--
-- ONE ROW PER DEVICE, not per user. Keys are device-bound: a second browser
-- generates its own identity and publishes its own row, and a sender wraps the
-- content key for EVERY live key the recipient has. Keying this by user id
-- instead would mean a second sign-in either silently locked you out of your
-- own media or forced the private key to travel, and both are worse.
-- ===========================================================================
begin;

create table if not exists public.user_keys (
  device_key   text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  public_jwk   jsonb not null,
  -- The private key under the user's passphrase. Never readable by anyone else.
  backup       text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists user_keys_by_user on public.user_keys(user_id);

alter table public.user_keys enable row level security;

-- Table-wide privileges are revoked in this schema and re-granted per column,
-- so every column a client writes needs naming or the write fails with 42501
-- before RLS is even consulted.
revoke all on public.user_keys from anon, authenticated;
-- SELECT is COLUMN-SCOPED and `backup` is deliberately absent. RLS is
-- row-level and cannot hide a column, so the friend read policy below would
-- otherwise hand a friend the wrapped private key along with the public one —
-- leaving only a passphrase they could attack offline at their leisure. No
-- client reads `backup` directly, including its owner; my_key_backup() is the
-- one door, and this missing grant is the wall behind it.
grant select (device_key, user_id, public_jwk, created_at, last_seen_at)
  on public.user_keys to authenticated;
grant insert (device_key, user_id, public_jwk, backup) on public.user_keys to authenticated;
grant update (public_jwk, backup, last_seen_at) on public.user_keys to authenticated;
grant delete on public.user_keys to authenticated;

-- Read: your own rows always, a friend's only once the friendship is accepted
-- and there is no block — the same boundary visible_profiles() uses. Which
-- COLUMNS come back is decided by the grant above, not here.
drop policy if exists user_keys_read_own on public.user_keys;
create policy user_keys_read_own on public.user_keys
  for select to authenticated using (user_id = auth.uid());

drop policy if exists user_keys_read_friend on public.user_keys;
create policy user_keys_read_friend on public.user_keys
  for select to authenticated using (
    user_id <> auth.uid()
    and exists (
      select 1 from public.friendships f
       where f.status = 'accepted'
         and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), user_keys.user_id))
    and not public.blocked_between(auth.uid(), user_keys.user_id)
  );

-- Write: only ever your own row, and `user_id` cannot be forged because the
-- WITH CHECK pins it to auth.uid() on both insert and update.
drop policy if exists user_keys_insert on public.user_keys;
create policy user_keys_insert on public.user_keys
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists user_keys_update on public.user_keys;
create policy user_keys_update on public.user_keys
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_keys_delete on public.user_keys;
create policy user_keys_delete on public.user_keys
  for delete to authenticated using (user_id = auth.uid());

-- A friend must get the public half WITHOUT the wrapped private half, and a
-- policy cannot hide a column. This is the door; the read policy above is the
-- wall behind it for anything selecting the table directly.
create or replace function public.friend_public_keys(other uuid)
returns table (device_key text, public_jwk jsonb)
language sql stable security definer set search_path = public as $fn$
  select k.device_key, k.public_jwk
    from public.user_keys k
   where k.user_id = other
     and auth.uid() is not null
     and (other = auth.uid() or (
       exists (select 1 from public.friendships f
                where f.status = 'accepted'
                  and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), other))
       and not public.blocked_between(auth.uid(), other)));
$fn$;
revoke all on function public.friend_public_keys(uuid) from public, anon;
grant execute on function public.friend_public_keys(uuid) to authenticated;

-- Your own wrapped private key, for restoring onto a new device. Definer
-- because the column grant is revoked for everyone; scoped to auth.uid() so it
-- can never become an oracle for somebody else's backup.
create or replace function public.my_key_backup(device text)
returns text language sql stable security definer set search_path = public as $fn$
  select k.backup from public.user_keys k
   where k.device_key = device and k.user_id = auth.uid() and auth.uid() is not null;
$fn$;
revoke all on function public.my_key_backup(text) from public, anon;
grant execute on function public.my_key_backup(text) to authenticated;

insert into public.schema_migrations(id) values ('202609150090_e2e_keys') on conflict do nothing;
notify pgrst, 'reload schema';
commit;
