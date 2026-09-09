-- ---------------------------------------------------------------------------
-- Audit finding: intimate-game photos would never be collected, and the
-- obvious workaround would have collected them while still in use.
--
-- 0026 promises the object stops being readable two minutes after it is opened
-- and is then deleted by the cleanup worker. The first half holds. The second
-- could not: `queue_media_cleanup`'s prefix allowlist has no `intimate`, so
-- queuing raises `invalid media owner`, and 0026's own functions only ever
-- UPDATE `media_cleanup` — with no row to update they are silent no-ops. Net
-- effect: the bytes stay in the bucket forever.
--
-- The second-order bug is the dangerous one. Whoever writes the client hits
-- `invalid media owner` on the first upload and reaches for the obvious
-- workaround — upload under an already-allowed prefix, `<uid>/snaps/…`. At that
-- moment `claim_media_cleanup`, which knows nothing about `intimate_rounds`,
-- claims the object 24h later and the worker deletes a photo a live session
-- still references. The two bugs currently cancel into "never collected"; the
-- natural workaround flips them into "collected while live".
--
-- Applied BEFORE 0026 so the prefix and the reference check exist the moment
-- that surface goes live.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.queue_media_cleanup(object_path text)
returns void language plpgsql security definer set search_path=public as $fn$
begin
  if auth.uid() is null
     or split_part(object_path, '/', 1) is distinct from auth.uid()::text
     or object_path !~ '^[0-9a-f-]+/(snaps|voice|stories|memories|scrapbook|intimate)/[0-9a-zA-Z_.-]+$'
  then
    raise exception 'invalid media owner';
  end if;
  insert into public.media_cleanup(path, due_at)
  values (object_path, now() + interval '24 hours')
  on conflict (path) do nothing;
end $fn$;
revoke all on function public.queue_media_cleanup(text) from public, anon;
grant execute on function public.queue_media_cleanup(text) to authenticated;

-- `claim_media_cleanup` must refuse an object a live intimate round still
-- references, mirroring `intimate_media_readable` EXACTLY so the object becomes
-- collectable at precisely the moment it stops being readable. The
-- `to_regclass` guard lets this migration apply before 0026 creates the table.
create or replace function public.claim_media_cleanup(object_path text)
returns boolean language plpgsql security definer set search_path=public as $fn$
declare referenced boolean;
begin
  perform 1 from public.media_cleanup where path=object_path and due_at<=now() for update;
  if not found then return false; end if;

  if exists(select 1 from public.messages where media_path=object_path or thumb_path=object_path)
     or exists(select 1 from public.stories where media_path=object_path)
     or exists(select 1 from public.memories where media_path=object_path or thumb_path=object_path)
     or exists(select 1 from public.scrapbook_items where media_path=object_path or thumb_path=object_path)
  then
    delete from public.media_cleanup where path=object_path;
    return false;
  end if;

  if to_regclass('public.intimate_rounds') is not null then
    execute $q$
      select exists (
        select 1 from public.intimate_rounds r
          join public.intimate_sessions s on s.id = r.session_id
         where r.media_path = $1
           and s.ended_at is null and s.expires_at > now()
           and (r.photo_opened_at is null
                or r.photo_opened_at > now() - interval '2 minutes'))
    $q$ into referenced using object_path;
    if referenced then
      delete from public.media_cleanup where path=object_path;
      return false;
    end if;
  end if;

  update public.media_cleanup set deleting=true where path=object_path;
  return true;
end $fn$;
revoke all on function public.claim_media_cleanup(text) from public,anon,authenticated;
grant execute on function public.claim_media_cleanup(text) to service_role;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090031_intimate_cleanup') on conflict (id) do nothing;
