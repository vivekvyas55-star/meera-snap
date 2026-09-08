-- Meera production only. Apply AFTER 202609080016_egress.sql.
--
-- Run standalone in the SQL editor, not batched with a migration: pg_cron
-- statements have aborted batched transactions on some projects (see the note
-- in the baseline), and CLAUDE.md keeps cron out of migrations for that reason.
--
-- 20:00 UTC = 01:30 IST, so it runs shortly after the IST day it measures has
-- closed. Measuring the current day would report a half-finished one and make
-- every trend look like a collapse at the right-hand edge.
select cron.schedule('meera-ops-metrics', '0 20 * * *', $job$
  select public.record_ops_metrics(public.ist_date() - 1);
$job$);

-- To stop it:  select cron.unschedule('meera-ops-metrics');
--
-- To read it (the whole point — this is an operator query, the table is not
-- readable by any signed-in client):
--
--   select on_date,
--          pg_size_pretty(stored_bytes)            as stored,
--          object_count,
--          pg_size_pretty(projected_daily_egress)  as projected_out
--     from public.ops_metrics
--    order by on_date desc
--    limit 30;
--
-- And the number to compare against the 5 GB allowance:
--
--   select pg_size_pretty(sum(projected_daily_egress))
--     from public.ops_metrics
--    where on_date >= date_trunc('month', public.ist_date())::date;
--
-- Remember what this is: a projection built from the objects served and the
-- audience each one has, NOT Supabase's own transfer counter. The real figure
-- is on the dashboard under Settings → Usage. If the two diverge badly, the
-- gap is re-downloads — which is what the signed-URL cache in db.js exists to
-- stop, and the first thing to check.
--
-- To backfill by hand (safe to repeat; the primary key is the day):
--   select public.record_ops_metrics('2026-09-07');
