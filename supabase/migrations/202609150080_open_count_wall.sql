-- ===========================================================================
-- The snap reopen limit was enforced by a door with no wall behind it.
--
-- `record_snap_open()` is SECURITY DEFINER, guarded `sender_id <> auth.uid()`,
-- and increments `open_count` by exactly one. Both `message_visible` (server)
-- and `isVisibleTo` (client) then hide a snap once `open_count >= 6`
-- (SNAP_MAX_OPENS = 1 view + 5 reopens). That is the whole reopen limit.
--
-- But the baseline also issued
--
--     grant update (open_count) on public.messages to authenticated;
--
-- and `messages_update` is `using (auth.uid() in (user_a, user_b))` — either
-- party. Nothing anywhere constrained the column. So a recipient could send
--
--     PATCH /rest/v1/messages?id=eq.<id>   {"open_count": 0}
--
-- and view a snap as many times as they liked. Verified against a real
-- database with every migration applied: as the recipient, the UPDATE
-- succeeded and the row came back `open_count = 0`. The client never writes
-- this column — `Chat.jsx`, `SnapViewer.jsx` and `isVisibleTo` only read it —
-- so the grant existed solely to serve a path nothing used, which is the exact
-- shape of the `opened_at` hole closed in 202609150050 and of `saved_by` in
-- 202609090032. **The RPC is a door; the grant is the wall.**
--
-- `cleared_by` is revoked in the same breath and for the same reason. It is
-- currently held by `guard_message_update` ("may only clear for yourself"), so
-- unlike open_count it is not exploitable today — but the client only ever
-- reads it too, and leaving a write grant open because a trigger happens to
-- cover it is how the next audit finds the third instance of this.
--
-- Scope of the bug being closed: an ephemerality bypass, not a data leak. The
-- 24h-after-first-open rule in `message_visible` still applies, so this bought
-- unlimited opens within that window rather than forever. It is still a limit
-- the sender was told existed and that the recipient could simply switch off.
-- ===========================================================================
begin;

-- 1 -------------------------------------------------------------------------
-- The wall. Every legitimate writer is SECURITY DEFINER and therefore
-- indifferent to a column grant.
revoke update (open_count, cleared_by) on public.messages from authenticated;

-- 2 -------------------------------------------------------------------------
-- Defence in depth, as an INVARIANT rather than a role check — the same shape
-- as `guard_message_open_at`, and for the same reason: a later migration
-- silently re-widening the grant must not reopen this. It has happened twice
-- in this repo already (`stories_fix.sql`, and `202609090022` leaving
-- `saved_by` granted after hardening `toggle_saved`).
--
-- `record_snap_open` is the only writer in the whole schema and it does
-- `open_count = open_count + 1`, so "never decreases" cannot affect any
-- sanctioned path, while a reset to zero — the actual attack — is refused.
create or replace function public.guard_message_open_count()
returns trigger language plpgsql as $fn$
begin
  if coalesce(new.open_count, 0) < coalesce(old.open_count, 0) then
    raise exception 'open_count cannot decrease';
  end if;
  return new;
end $fn$;

drop trigger if exists guard_message_open_count on public.messages;
create trigger guard_message_open_count
  before update of open_count on public.messages
  for each row execute function public.guard_message_open_count();

insert into public.schema_migrations(id) values ('202609150080_open_count_wall') on conflict do nothing;
notify pgrst, 'reload schema';
commit;
