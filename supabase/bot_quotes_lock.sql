-- ============================================================================
-- Security-audit finding (LOW): bot_quotes was the one public table with RLS
-- OFF and default grants, so any authenticated user could INSERT/UPDATE quotes
-- that send_morning_quotes() then DMs to every real user (incl. the owner) as a
-- trusted "bot" each morning — a phishing/abuse vector. Clients never read this
-- table directly; send_morning_quotes() is SECURITY DEFINER and keeps working.
-- Lock it: enable RLS (no policy → no client access) AND revoke grants.
-- ============================================================================
alter table public.bot_quotes enable row level security;
revoke all on public.bot_quotes from anon, authenticated;

notify pgrst, 'reload schema';
select 'bot_quotes locked (RLS on, grants revoked)' as status;
