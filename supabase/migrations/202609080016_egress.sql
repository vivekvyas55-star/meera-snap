-- ---------------------------------------------------------------------------
-- Egress is the scarcest resource in this project — 5 GB/month on the free tier,
-- and with ~250 MB stored and 17 users it was already at 1.11 GB. Nothing
-- watched it. The first sign of a problem was going to be the bill.
--
-- What this can and cannot measure, stated plainly: Storage downloads never
-- touch Postgres, so the transfer figure on the Supabase dashboard is NOT
-- readable from here and this does not pretend to read it. What is readable is
-- everything that DRIVES it — how many bytes are stored, how fast that is
-- growing, and how many times each new object is going to be sent. That last
-- one is the whole game: a story is fetched once per friend, a snap once, and
-- the difference between them is the difference between a comfortable month and
-- a throttled one.
--
-- The projection is therefore built from real rows: every story posted in the
-- window, multiplied by the audience that story actually has.
-- ---------------------------------------------------------------------------

create table if not exists public.ops_metrics (
  on_date date primary key,
  stored_bytes bigint not null default 0,
  object_count integer not null default 0,
  -- Posted in the 24h the row covers, so a run is a daily delta rather than a
  -- running total that hides when the growth happened.
  story_bytes bigint not null default 0,
  snap_bytes bigint not null default 0,
  memory_bytes bigint not null default 0,
  -- story bytes × the number of friends who can see each one, plus one send per
  -- snap. The number that should be compared against the 5 GB allowance.
  projected_daily_egress bigint not null default 0,
  recorded_at timestamptz not null default now()
);

-- Locked exactly like bot_quotes and prompts: RLS on, no policy, grants
-- revoked. This is operator data — per-day totals across every user — and a
-- signed-in client has no business reading or writing it.
alter table public.ops_metrics enable row level security;
revoke all on public.ops_metrics from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The daily measurement. Written to be safe to run repeatedly: the primary key
-- is the IST date and a re-run overwrites that day rather than doubling it, so
-- a retried cron, a manual run and a backfill all cost one row.
--
-- IST because every other day boundary in this app is IST (ist_date(), the
-- question of the day, billing periods). A UTC day would put half of an
-- evening's stories in the wrong bucket.
-- ---------------------------------------------------------------------------
create or replace function public.record_ops_metrics(for_date date default null)
returns public.ops_metrics
language plpgsql
security definer
set search_path = public
as $fn$
declare
  day date := coalesce(for_date, public.ist_date());
  -- The window is the IST day, converted back to the timestamps the rows carry.
  from_ts timestamptz := (day::text || ' 00:00:00')::timestamp at time zone 'Asia/Kolkata';
  to_ts timestamptz := from_ts + interval '1 day';
  row public.ops_metrics;
  total_bytes bigint;
  total_objects integer;
  stories bigint;
  snaps bigint;
  memories bigint;
  projected bigint;
begin
  -- storage.objects carries the byte size in its metadata. It can be null for
  -- an object still uploading or one written before Supabase recorded it, and
  -- coalescing to 0 is right: an unknown size must not poison the total with
  -- nulls, and it will be counted on tomorrow's run anyway.
  select coalesce(sum((o.metadata->>'size')::bigint), 0), count(*)
    into total_bytes, total_objects
    from storage.objects o
   where o.bucket_id = 'media';

  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)
    into stories
    from public.stories s
    join storage.objects o on o.bucket_id = 'media' and o.name = s.media_path
   where s.created_at >= from_ts and s.created_at < to_ts;

  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)
    into snaps
    from public.messages m
    join storage.objects o on o.bucket_id = 'media' and o.name = m.media_path
   where m.created_at >= from_ts and m.created_at < to_ts and m.media_path is not null;

  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)
    into memories
    from public.memories mem
    join storage.objects o on o.bucket_id = 'media' and o.name = mem.media_path
   where mem.created_at >= from_ts and mem.created_at < to_ts;

  -- The multiplier that matters. A story is downloaded once by every accepted
  -- friend of its author, which is why stories get the most aggressive
  -- downscale in lib/image.js. A snap goes to one person. Counting stories at
  -- face value is what made egress look inexplicable next to storage size.
  select coalesce(sum(
           coalesce((o.metadata->>'size')::bigint, 0)
           * (select count(*) from public.friendships f
               where f.status = 'accepted'
                 and (f.user_a = s.user_id or f.user_b = s.user_id))
         ), 0)
    into projected
    from public.stories s
    join storage.objects o on o.bucket_id = 'media' and o.name = s.media_path
   where s.created_at >= from_ts and s.created_at < to_ts;

  projected := projected + snaps;

  insert into public.ops_metrics as t
    (on_date, stored_bytes, object_count, story_bytes, snap_bytes, memory_bytes,
     projected_daily_egress, recorded_at)
  values (day, total_bytes, total_objects, stories, snaps, memories, projected, now())
  on conflict (on_date) do update
    set stored_bytes = excluded.stored_bytes,
        object_count = excluded.object_count,
        story_bytes = excluded.story_bytes,
        snap_bytes = excluded.snap_bytes,
        memory_bytes = excluded.memory_bytes,
        projected_daily_egress = excluded.projected_daily_egress,
        recorded_at = excluded.recorded_at
  returning * into row;

  -- A warning in the Postgres log is where an operator actually looks, and it
  -- is the only channel this database has that reaches a human without the app
  -- being open. The threshold is a third of the 5 GB monthly allowance spent in
  -- a rolling week — early enough to change something, not so twitchy that it
  -- cries every time somebody posts a video.
  if (select coalesce(sum(projected_daily_egress), 0)
        from public.ops_metrics
       where on_date > day - 7) > 1717986918 then
    raise warning 'Meera egress projection: % MB served in the last 7 days, against a 5 GB month',
      round((select coalesce(sum(projected_daily_egress), 0) from public.ops_metrics where on_date > day - 7) / 1048576.0, 1);
  end if;

  return row;
end
$fn$;

-- Operator-only, like credit_balance(). Nothing signed in should be able to ask
-- how much everyone is storing.
revoke all on function public.record_ops_metrics(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: one row for today so the table is never empty and the first cron
-- run has something to compare against.
-- ---------------------------------------------------------------------------
select public.record_ops_metrics();

notify pgrst, 'reload schema';
