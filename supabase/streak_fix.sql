-- ============================================================================
-- Friendlier streaks (deep-audit + real-usage finding).
--
-- The Snapchat rule (both must send a PHOTO SNAP within each 24h window) left
-- real pairs stuck at 1: one person snaps often, the other mostly texts, so the
-- mutual-snap window keeps breaking. For this app the streak should reflect that
-- two people are TALKING every day, so count any real message (chat / snap /
-- voice / sticker — not call logs). Guards kept: a one-sided burst never
-- advances it (BOTH sides must have sent since the last count), and it advances
-- at most once per ~20h (once a day). Window widened 24h -> 36h so a late day
-- doesn't kill the streak; it only breaks after a genuine ~1.5-day silence.
-- ============================================================================
create or replace function public.bump_streak()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s public.streaks%rowtype;
  now_ts timestamptz := now();
  sender_is_a boolean := (new.sender_id = new.user_a);
  a_ts timestamptz;
  b_ts timestamptz;
begin
  if new.kind = 'call' then return new; end if; -- call logs don't count

  insert into public.streaks (user_a, user_b) values (new.user_a, new.user_b)
    on conflict (user_a, user_b) do nothing;
  select * into s from public.streaks
   where user_a = new.user_a and user_b = new.user_b for update;
  if not found then return new; end if;

  -- Break only after a real gap: either side silent for >36h.
  if s.count > 0 and (
       s.last_snap_a is null or s.last_snap_b is null
       or s.last_snap_a < now_ts - interval '36 hours'
       or s.last_snap_b < now_ts - interval '36 hours') then
    s.count := 0; s.last_increment := null;
  end if;

  a_ts := case when sender_is_a then now_ts else s.last_snap_a end;
  b_ts := case when sender_is_a then s.last_snap_b else now_ts end;

  -- Advance once per ~day when BOTH have sent since the last increment.
  if a_ts is not null and b_ts is not null
     and a_ts > now_ts - interval '36 hours'
     and b_ts > now_ts - interval '36 hours'
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

notify pgrst, 'reload schema';
select 'streaks now count daily two-way messaging (forgiving 36h)' as status;
