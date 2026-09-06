-- Taking down your own story needs an explicit DELETE grant. The stories_delete
-- policy has existed since the baseline, but table-wide privileges were revoked
-- in hardening and only INSERT was re-granted — so the delete would have failed
-- with 42501 before RLS was ever consulted. Policy without grant is the exact
-- trap that silently emptied `stories` once before.
begin;
grant delete on public.stories to authenticated;
notify pgrst, 'reload schema';
commit;
