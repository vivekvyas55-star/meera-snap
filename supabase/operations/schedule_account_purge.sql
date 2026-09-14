-- Meera production only. Apply AFTER 202609140037_deletion_grace.sql.
--
-- Run standalone in the SQL editor, not batched with a migration: pg_cron
-- statements have aborted batched transactions on some projects.
--
-- This is the half of the grace period that actually deletes. Without it a
-- scheduled deletion is a row that sits there forever while the screen shows a
-- date in the past — the account is not gone and the person believes it is,
-- which is the worst failure available on this particular control.
--
-- Two things keep that from being silent anyway: the pending banner reads the
-- real purge_after off the server rather than counting down locally, and it
-- keeps an immediate "Delete now" beside it, so a stalled job never traps
-- somebody inside their own grace period.
--
-- Hourly. The grace period is seven days, so an hour of slack either side is
-- immaterial, and an hourly job is cheap and easy to reason about when reading
-- the Postgres log.
select cron.schedule('meera-account-purge', '7 * * * *', $job$
  select public.purge_due_accounts();
$job$);

-- To stop it:  select cron.unschedule('meera-account-purge');
--
-- To see what is waiting, as the operator:
--   select user_id, requested_at, purge_after from public.deletion_requests
--    order by purge_after;
