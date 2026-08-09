-- ============================================================================
-- Stories were never persisting. hardening.sql revoked table-wide privileges
-- and re-granted per table, but public.stories got SELECT + DELETE for the
-- authenticated role and never INSERT. So every "post story" failed with 42501
-- (permission denied) *before* the RLS write policy was even evaluated, and the
-- table stayed empty — the reason a user's own posted stories never showed.
--
-- Fix: grant INSERT, and extend the lifetime from 24h to 48h (2 days) as
-- requested. RLS (stories_write: with check user_id = auth.uid()) still gates
-- WHICH rows may be inserted; this grant just lets the role insert at all.
-- ============================================================================

grant insert on public.stories to authenticated;

alter table public.stories
  alter column expires_at set default now() + interval '48 hours';

-- Any stories already posted keep the full 2 days (none today, but harmless).
update public.stories
   set expires_at = created_at + interval '48 hours'
 where expires_at < created_at + interval '48 hours';

notify pgrst, 'reload schema';

select 'stories: INSERT granted + 48h (2-day) expiry' as status;
