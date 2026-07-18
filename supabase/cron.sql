-- ============================================================================
-- Daily motivation cron. Run standalone (not batched) — enabling pg_cron inside
-- a large transaction can abort it. 01:30 UTC ≈ 07:00 IST.
-- ============================================================================
create extension if not exists pg_cron;
select cron.schedule('meera-morning-quotes', '30 1 * * *', $$select public.send_morning_quotes()$$);
