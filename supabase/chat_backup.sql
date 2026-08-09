-- ============================================================================
-- Backend-only 3-day chat backup (safety net). Every message is snapshotted at
-- insert time into private.message_backup and kept for 3 days, independent of
-- the app's ephemerality (UI clears / message purges never touch the backup).
--
-- This is invisible to the app: the table lives in the `private` schema, which
-- PostgREST does not expose, and the app roles have no access. Only the backend
-- (service_role / postgres via the SQL editor) can read it. No client, UI, or
-- app change is involved — a trigger does the copying passively.
-- ============================================================================

create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.message_backup (
  backup_id      bigint generated always as identity primary key,
  message_id     uuid not null,
  user_a         uuid,
  user_b         uuid,
  sender_id      uuid,
  kind           text,
  body           text,
  media_path     text,
  media_type     text,
  view_seconds   int,
  has_audio      boolean,
  msg_created_at timestamptz,
  archived_at    timestamptz not null default now()
);
create index if not exists message_backup_archived_idx on private.message_backup (archived_at);
create index if not exists message_backup_pair_idx on private.message_backup (user_a, user_b);

-- Snapshot every new message. SECURITY DEFINER so it runs regardless of the
-- inserting user's (deliberately narrow) grants; it only ever writes the backup.
create or replace function private.backup_message()
returns trigger language plpgsql security definer set search_path = private, public as $$
begin
  -- The backup is a best-effort safety net. It runs inside the user's INSERT
  -- transaction, so wrap it: a backup failure must NEVER roll back a real
  -- message send (the hottest path in the app).
  begin
    insert into private.message_backup
      (message_id, user_a, user_b, sender_id, kind, body, media_path,
       media_type, view_seconds, has_audio, msg_created_at)
    values
      (new.id, new.user_a, new.user_b, new.sender_id, new.kind, new.body, new.media_path,
       new.media_type, new.view_seconds, new.has_audio, new.created_at);
  exception when others then
    null; -- swallow: never block the send on a backup problem
  end;
  return new;
end $$;

drop trigger if exists trg_backup_message on public.messages;
create trigger trg_backup_message
  after insert on public.messages
  for each row execute function private.backup_message();

-- Retention: keep 3 days, then drop.
create or replace function private.purge_message_backup()
returns void language sql security definer set search_path = private as $$
  delete from private.message_backup where archived_at < now() - interval '3 days';
$$;

-- Schedule the purge hourly via pg_cron; don't fail the migration if cron is
-- unavailable — the table + trigger are the essential parts.
do $$
begin
  perform cron.unschedule('purge-message-backup');
exception when others then null;
end $$;
do $$
begin
  perform cron.schedule('purge-message-backup', '23 * * * *', 'select private.purge_message_backup()');
exception when others then raise notice 'cron scheduling skipped: %', sqlerrm;
end $$;

select 'private.message_backup enabled — 3-day backend-only chat backup' as status;
