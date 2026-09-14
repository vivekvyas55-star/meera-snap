-- Meera production only. Apply AFTER 202609150040_scheduled_messages.sql.
--
-- Run standalone in the SQL editor, not batched with a migration: pg_cron
-- statements have aborted batched transactions on some projects.
--
-- EVERY MINUTE, not every 15. This is the one cron here whose latency is a
-- promise made to a user's face: they picked 09:00 and the compose sheet says
-- "sends at 09:00". Fifteen minutes of slop would make that sentence false for
-- fourteen of them, and a surprise that lands at 09:13 is a different surprise.
-- The job is cheap when there is nothing due — one index scan on
-- scheduled_messages_due_idx against a table that is capped at 20 rows per
-- sender and empties itself as it delivers.
--
-- Overlap is safe: deliver_scheduled_messages() takes its batch with
-- `for update skip locked`, so a run that starts while the previous one is
-- still going picks up nothing rather than sending anything twice. It returns
-- the number of messages it actually sent.
select cron.schedule('meera-scheduled-messages', '* * * * *', $job$
  select public.deliver_scheduled_messages();
$job$);

-- To stop it:  select cron.unschedule('meera-scheduled-messages');
--
-- Stopping it is not neutral: pending rows keep accumulating and nothing sends,
-- and the sender's list will go on saying "sends at 09:00" about a message that
-- never will. If this job is ever disabled for more than a moment, clear the
-- table too:
--     delete from public.scheduled_messages;
-- (Deleting is the right call over delivering a week of stale messages at once.)
