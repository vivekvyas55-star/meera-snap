-- ---------------------------------------------------------------------------
-- Two live findings from the deep audit, both reachable straight from
-- PostgREST with the anon key that ships in the bundle.
-- ---------------------------------------------------------------------------
begin;

-- CRITICAL. A blocked person can pin the whole conversation against the
-- ephemeral purge, permanently, and the victim has no way to undo it.
--
-- 202609090022 hardened `toggle_saved()` against exactly this — and left the
-- COLUMN GRANT in place, so it only closed the client path. A blocked user
-- PATCHes messages directly with {"saved_by": ["<self>"]}; `guard_message_update`
-- explicitly allows adding your own uid, and both `purge_expired` and the
-- 3-visit clear require `saved_by = '{}'`. Nothing ever deletes those messages
-- again. The victim cannot strip it either: a direct update raises "may only
-- save/unsave for yourself", and toggle_saved now refuses them because the
-- hardening locked them out of their own pair.
--
-- toggle_saved is the only path the client uses, so the grant is dead weight.
revoke update (saved_by) on public.messages from authenticated;

-- HIGH. `stories_fix.sql` silently reverted the "freeze expiry at insert"
-- control. The baseline deliberately narrows the grant to four columns; the
-- later fix re-issued a table-wide `grant insert`, which subsumes them. So any
-- signed-in user can post a story with a hand-picked `expires_at` — a hundred
-- years out — which `purge_expired()` never deletes and whose object
-- `claim_media_cleanup` treats as a live reference forever. `created_at` and
-- `id` are forgeable the same way.
--
-- `messages` was never affected: its INSERT grant is still column-scoped, which
-- is what makes this an inconsistency rather than a design choice.
revoke insert on public.stories from authenticated;
grant insert (user_id, media_path, media_type, caption) on public.stories to authenticated;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090032_audit_criticals') on conflict (id) do nothing;
