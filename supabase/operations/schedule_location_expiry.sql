-- Meera production only. Apply AFTER 202609080018_privacy.sql.
--
-- Run standalone in the SQL editor, not batched with a migration: pg_cron
-- statements have aborted batched transactions on some projects.
--
-- Expired sharing is ALREADY invisible — `expires_at is null or expires_at >
-- now()` is in the read policy, not in a sweep — so this is data minimisation,
-- not enforcement. It deletes the row rather than flipping a flag, for the same
-- reason Go Ghost does: coordinates nobody is allowed to see should not sit in
-- the table waiting for a policy to keep protecting them.
--
-- Every 15 minutes. Location is the most sensitive thing this app stores, and
-- an hour of latency on deleting it is an hour it did not need to exist.
select cron.schedule('meera-location-expiry', '*/15 * * * *', $job$
  select public.purge_expired_locations();
$job$);

-- To stop it:  select cron.unschedule('meera-location-expiry');
