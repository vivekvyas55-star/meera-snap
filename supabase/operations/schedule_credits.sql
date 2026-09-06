-- Meera production only. Apply AFTER 202609070011_credits.sql, and only when
-- you actually want the meter to start ticking — scheduling this is what turns
-- the credit meter from a display into a charge.
--
-- Run standalone in the SQL editor, not batched with a migration: pg_cron
-- statements have aborted batched transactions on some projects (see the note
-- in the baseline), and CLAUDE.md keeps cron out of migrations for that reason.
--
-- DAILY, not monthly-on-the-1st, and that is deliberate. post_monthly_credits()
-- is idempotent on (user_id, period), so 30 of these 31 runs insert nothing.
-- What the extra runs buy is self-healing: a single monthly trigger that fails
-- (function timeout, database restarted mid-run, a user created after it ran)
-- silently skips a whole month's billing and nobody notices until the numbers
-- are wrong. A daily no-op fixes it the next morning.
--
-- 01:00 UTC = 06:30 IST, comfortably inside the new IST day, so the period the
-- job computes is never the one that is still turning over.
select cron.schedule('meera-monthly-credits', '0 1 * * *', $job$
  select public.post_monthly_credits();
$job$);

-- To stop it:  select cron.unschedule('meera-monthly-credits');
-- To backfill a missed month by hand (safe to repeat):
--   select public.post_monthly_credits('2026-09');
