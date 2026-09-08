-- ---------------------------------------------------------------------------
-- Migrations are applied by hand in the SQL editor, and nothing recorded which
-- ones had been. Three features have now shipped in halves — a client calling
-- an RPC no applied migration defines, or a migration applied with no client to
-- use it — and each time the symptom was "the feature is broken" with no error
-- that pointed anywhere near the cause.
--
-- tests/schema-contract.test.js catches the repo being inconsistent with
-- itself. It cannot catch the repo being ahead of production, because it never
-- talks to production. This is the other half: the database says which
-- migrations it has, the bundle says which it was built against, and the client
-- can tell the difference at runtime instead of failing mysteriously.
-- ---------------------------------------------------------------------------

create table if not exists public.schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;

-- The version itself is not a secret and the client needs it on every boot, so
-- this is the one thing here that authenticated may call. It returns only the
-- newest id — the full list is operator data.
create or replace function public.schema_version()
returns text
language sql
stable
security definer
set search_path = public
as $fn$ select max(id) from public.schema_migrations $fn$;

revoke all on function public.schema_version() from public, anon;
grant execute on function public.schema_version() to authenticated;

-- Backfill. Everything up to and including this migration is applied in
-- production as of 8 Sep 2026 — that is the fact this table is recording, and
-- it is the last time the list has to be written by hand. From here every
-- migration registers itself on its own last line.
insert into public.schema_migrations(id) values
  ('202609060000_baseline'),
  ('202609060001_audit_fixes'),
  ('202609060002_cleanup_auth'),
  ('202609060003_private_updates'),
  ('202609060005_prompt_status_all'),
  ('202609060006_kept_and_skips'),
  ('202609060007_pair_questions'),
  ('202609070008_pending_questions'),
  ('202609070009_story_delete'),
  ('202609070010_billing'),
  ('202609070011_credits'),
  ('202609070012_integrity_followup'),
  ('202609070013_game_invites'),
  ('202609080014_game_invite_responses'),
  ('202609080015_game_rooms'),
  ('202609080016_egress'),
  ('202609080017_schema_version')
on conflict (id) do nothing;

notify pgrst, 'reload schema';
