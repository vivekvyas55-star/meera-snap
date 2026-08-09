-- ============================================================================
-- Friendship charms — fun computed stats for a pair, shown in the FriendSheet.
-- SECURITY DEFINER so counts aren't skewed by the caller's row visibility; only
-- ever computes for a pair the caller is IN (auth.uid() is one side). Message
-- counts reflect the CURRENT (non-purged) conversation, so they're "lately"
-- vibe stats, not lifetime — framed that way in the UI. Night/day use IST
-- (Asia/Kolkata), the users' timezone.
-- ============================================================================
create or replace function public.friendship_charms(other uuid)
returns json language sql security definer set search_path = public as $$
  with pk as (select least(auth.uid(), other) ua, greatest(auth.uid(), other) ub)
  select json_build_object(
    'streak',        coalesce((select s.count from public.streaks s, pk where s.user_a = pk.ua and s.user_b = pk.ub), 0),
    'friends_since', (select f.created_at from public.friendships f, pk where f.user_a = pk.ua and f.user_b = pk.ub),
    'anniversary',   (select a.started_on from public.anniversaries a, pk where a.user_a = pk.ua and a.user_b = pk.ub),
    'snaps',         (select count(*) from public.messages m, pk where m.kind = 'snap' and m.user_a = pk.ua and m.user_b = pk.ub),
    'my_msgs',       (select count(*) from public.messages m, pk where m.user_a = pk.ua and m.user_b = pk.ub and m.sender_id = auth.uid()),
    'their_msgs',    (select count(*) from public.messages m, pk where m.user_a = pk.ua and m.user_b = pk.ub and m.sender_id = other),
    'night_msgs',    (select count(*) from public.messages m, pk where m.user_a = pk.ua and m.user_b = pk.ub
                        and extract(hour from m.created_at at time zone 'Asia/Kolkata') in (22,23,0,1,2,3,4)),
    'morning_msgs',  (select count(*) from public.messages m, pk where m.user_a = pk.ua and m.user_b = pk.ub
                        and extract(hour from m.created_at at time zone 'Asia/Kolkata') between 5 and 10)
  );
$$;
revoke all on function public.friendship_charms(uuid) from public;
grant execute on function public.friendship_charms(uuid) to authenticated;

notify pgrst, 'reload schema';
select 'friendship_charms RPC ready' as status;
