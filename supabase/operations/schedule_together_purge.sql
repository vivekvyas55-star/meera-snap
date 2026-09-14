-- Meera production only. Apply AFTER 202609140034_timeline_events.sql.
--
-- Run standalone in the SQL editor, not batched with a migration: pg_cron
-- statements have aborted batched transactions on some projects.
--
-- This is the SECOND half of the opt-out purge, and it exists because the first
-- half only fires when somebody taps the switch. set_together_optin(other,
-- false) deletes the pair's recorded events in the same transaction, so the tap
-- is covered exactly. Everything else that ends a pair is not:
--
--   * block_user() deletes the friendship — deliberately, because stories,
--     presence, call signaling and the push relay all gate on one — but the
--     together_optin rows reference profiles, not friendships, so they survive
--     it. Neither person has opted out; the pair simply no longer exists.
--   * removeFriend() has the same shape.
--   * A cascade that takes one side's opt-in row leaves the other's behind.
--
-- In every one of those the events are already invisible — together_events_read
-- requires together_pair_active(), which requires an accepted friendship and no
-- block — so this is data minimisation, not enforcement, the same distinction
-- schedule_location_expiry.sql draws. A record nobody is allowed to see should
-- not sit in the table relying on a policy to keep protecting it.
--
-- Every 15 minutes, matching the cleanup worker. It is idempotent: a run with
-- nothing to do deletes nothing and returns 0.
select cron.schedule('meera-together-purge', '*/15 * * * *', $job$
  select public.purge_together_events();
$job$);

-- To stop it:  select cron.unschedule('meera-together-purge');
--
-- To see what it would take before running it:
--   select count(*) from public.together_events e
--    where not public.together_pair_active(e.user_a, e.user_b);
