-- ===========================================================================
-- A pending friend request must not be a read on somebody's profile row.
--
-- `profiles_read` (202609060000_baseline.sql) allowed SELECT whenever ANY
-- friendships row existed for the pair:
--
--     or exists (select 1 from public.friendships f
--                 where array[f.user_a, f.user_b] = public.pair_key(auth.uid(), profiles.id))
--
-- with NO status predicate. `sendFriendRequest` creates that row unilaterally
-- and it starts life as 'pending', so anyone who could name a username could
-- send a request and immediately read the whole row back over PostgREST —
-- without the target ever accepting, and while the request still sat
-- unanswered in their list. The most sensitive column there is `birthday`,
-- which is a full `date`: the YEAR is in it, i.e. date of birth.
--
-- The client had only ever RENDERED month and day (`birthdayLabel` in
-- FriendSignals.jsx, "the year on a birthday is nobody else's business"), and
-- CLAUDE.md said "Only month/day is ever shown; the year is never rendered."
-- Both were true and neither was load-bearing: the anon key ships in the
-- bundle, so a GET returns whatever the policy allows regardless of what any
-- component chooses to draw. This is the "RLS is the security boundary" rule —
-- a privacy claim enforced in a renderer is not enforced.
--
-- Two changes, because either alone leaves half of it open:
--
--   1. `profiles_read` is narrowed to `id = auth.uid()`. Nobody reads anybody
--      else's row directly any more, at any status.
--   2. Peer identities come from `visible_profiles(ids)`, a SECURITY DEFINER
--      projection that names its columns explicitly. It returns `birthday`
--      ONLY for an accepted friendship, and even then normalised to
--      '2000-MM-DD' — the year is discarded in the database, so it cannot leak
--      from here even to an accepted friend. A fixed sentinel year is used
--      rather than NULL-ing the column so the client's existing month/day
--      formatting keeps working unchanged.
--
-- Blocked pairs are excluded too: `blocked_between` is already the boundary
-- for messages and friendships (202609080018_privacy.sql), and a block that
-- still returned a name and an avatar would be a half-block.
--
-- ORDERING: this is safe to apply in either order relative to the bundle.
-- `getProfile`/`listFriendsWithProfiles` fall back to the old direct select on
-- PGRST202 (the function is absent), the same degradation `listLatestPerFriend`
-- and `loadScheduled` use — so a frontend carrying this change works on a
-- database that has not had it applied yet, and closes the hole the moment it
-- does. It is listed in .unapplied until it is actually applied.
-- ===========================================================================
begin;

-- 1 -------------------------------------------------------------------------
-- Your own row, and nothing else.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (id = auth.uid());

-- 2 -------------------------------------------------------------------------
-- The explicit projection every peer identity now comes through.
--
-- `setof jsonb` rather than a `returns table (...)`: widening a `returns table`
-- needs a `drop function` first (the `entitlement()` lesson), and this shape is
-- the one most likely to gain a column later. Self is returned whole — it is
-- the caller's own row, which policy 1 already allows them to read directly.
create or replace function public.visible_profiles(ids uuid[])
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select case when p.id = auth.uid() then to_jsonb(p) else
    jsonb_build_object(
      'id', p.id,
      'username', p.username,
      'display_name', p.display_name,
      'avatar_seed', p.avatar_seed,
      'avatar_emoji', p.avatar_emoji,
      'avatar_hue', p.avatar_hue,
      'is_bot', p.is_bot,
      -- Accepted friends only, and month/day only. A pending request gets null.
      'birthday', case
        when f.status = 'accepted' and p.birthday is not null
          then '2000-' || to_char(p.birthday, 'MM-DD')
        else null
      end)
    end
  from public.profiles p
  left join public.friendships f
    on array[f.user_a, f.user_b] = public.pair_key(auth.uid(), p.id)
  where auth.uid() is not null
    and p.id = any(ids)
    and (p.id = auth.uid()
         or (f.user_a is not null and not public.blocked_between(auth.uid(), p.id)));
$fn$;

revoke all on function public.visible_profiles(uuid[]) from public, anon;
grant execute on function public.visible_profiles(uuid[]) to authenticated;

insert into public.schema_migrations(id) values ('202609150070_profile_projection') on conflict do nothing;
notify pgrst, 'reload schema';
commit;
