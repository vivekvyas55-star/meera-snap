-- ============================================================================
-- Core-algorithm fixes (deep-audit findings).
--
-- 1. clear_viewed_chats swept the caller's OWN messages via `sender_id =
--    auth.uid()`. That clause was meant to also clear the sender's own SNAP
--    status rows — but it caught `kind='call'` logs too. Combined with
--    call_fix.sql now stamping opened_at on call logs, a caller's call log got
--    swept into the 3-visit counter and DISAPPEARED for the caller after 3
--    visits (while persisting for the recipient — asymmetric). Scope the clause
--    to snaps so call logs are never swept.
--
-- 2. bump_streak's once-per-window guard required STRICTLY >24h since the last
--    increment, anchored to the drifting last_increment timestamp. A pair
--    snapping at roughly the same time each day would be blocked (~23.5h < 24h)
--    and the streak would stall/under-count. Relax to 20h (the pre-hardening
--    value): still blocks same-day double counts (exchanges <20h apart) while
--    letting a normal daily cadence advance. The `least(a_ts,b_ts) >
--    last_increment` clause independently prevents intra-window double counting.
--
-- 3. getSnapScore(friend) was computed under the CALLER's RLS view, so a
--    friend's score was really the caller's own activity (inflated, identical
--    for every friend). Add a SECURITY DEFINER RPC that counts the TARGET's
--    snaps across their own conversations.
-- ============================================================================

-- 1 ------------------------------------------------------------------------
create or replace function public.clear_viewed_chats(other uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set view_leaves = jsonb_set(
           view_leaves,
           array[auth.uid()::text],
           to_jsonb(coalesce((view_leaves ->> auth.uid()::text)::int, 0) + 1)
         ),
         cleared_by = case
           when coalesce((view_leaves ->> auth.uid()::text)::int, 0) + 1 >= 3
                and not (auth.uid() = any(cleared_by))
             then array_append(cleared_by, auth.uid())
           else cleared_by end
   where array[user_a, user_b] = public.pair_key(auth.uid(), other)
     and opened_at is not null
     and saved_by = '{}'
     and (kind in ('chat', 'voice', 'sticker') or (sender_id = auth.uid() and kind = 'snap'))
     and not (auth.uid() = any(cleared_by));
$$;
revoke all on function public.clear_viewed_chats(uuid) from public;
grant execute on function public.clear_viewed_chats(uuid) to authenticated;

-- 2 ------------------------------------------------------------------------
create or replace function public.bump_streak()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s public.streaks%rowtype;
  now_ts timestamptz := now();
  sender_is_a boolean := (new.sender_id = new.user_a);
  a_ts timestamptz;
  b_ts timestamptz;
begin
  if new.kind <> 'snap' then return new; end if;

  insert into public.streaks (user_a, user_b) values (new.user_a, new.user_b)
    on conflict (user_a, user_b) do nothing;
  select * into s from public.streaks
   where user_a = new.user_a and user_b = new.user_b for update;
  if not found then return new; end if;

  if s.count > 0 and (
       s.last_snap_a is null or s.last_snap_b is null
       or s.last_snap_a < now_ts - interval '24 hours'
       or s.last_snap_b < now_ts - interval '24 hours') then
    s.count := 0; s.last_increment := null;
  end if;

  a_ts := case when sender_is_a then now_ts else s.last_snap_a end;
  b_ts := case when sender_is_a then s.last_snap_b else now_ts end;

  if a_ts is not null and b_ts is not null
     and a_ts > now_ts - interval '24 hours'
     and b_ts > now_ts - interval '24 hours'
     and (s.last_increment is null
          or (least(a_ts, b_ts) > s.last_increment
              and s.last_increment < now_ts - interval '20 hours'))
  then
    s.count := greatest(s.count, 0) + 1;
    s.last_increment := now_ts;
  end if;

  update public.streaks
     set count = s.count, last_snap_a = a_ts, last_snap_b = b_ts,
         last_increment = s.last_increment
   where user_a = new.user_a and user_b = new.user_b;
  return new;
end $$;

-- 3 ------------------------------------------------------------------------
-- Count the target user's snaps across their own conversations (definer, so it
-- isn't bounded by the caller's RLS view). Every snap in a conversation the
-- target is in is one they sent or received, so pair-membership = sent + recv.
create or replace function public.get_snap_score(target uuid)
returns int language sql security definer set search_path = public as $$
  select count(*)::int from public.messages
   where kind = 'snap' and (user_a = target or user_b = target);
$$;
revoke all on function public.get_snap_score(uuid) from public;
grant execute on function public.get_snap_score(uuid) to authenticated;

notify pgrst, 'reload schema';
select 'core fixes applied (call-log clear, streak cadence, snap score)' as status;
