-- ---------------------------------------------------------------------------
-- Security audit follow-up. Three findings on the surface added today.
-- ---------------------------------------------------------------------------
begin;

-- (3) A block severs the friendship, but Together stayed switched ON.
-- `together_optin_read`, `scrapbook_read`, `together_timeline` and
-- `together_on_this_day` consult neither the friendship nor `blocked_between`,
-- unlike `set_together_optin` and `add_scrapbook_item`, which both do. So after
-- a block the screen still said Together was active — inviting more sharing
-- into a severed relationship — and because the opt-in rows outlived the block,
-- an unblock plus a re-friend silently re-activated a shared scrapbook with no
-- fresh consent from either side.
--
-- The rows go, the scrapbook stays readable. Hiding what two people already
-- made is the hostage problem 0025's own header rejects; the opt-in is a
-- standing consent, and severing the relationship withdraws it.
create or replace function public.block_user(target uuid)
returns void language plpgsql security definer set search_path=public as $fn$
declare pair uuid[];
begin
  if auth.uid() is null or target is null or target = auth.uid() then
    raise exception 'not allowed';
  end if;
  pair := public.pair_key(auth.uid(), target);
  insert into public.blocks(blocker, blocked) values (auth.uid(), target)
    on conflict do nothing;
  delete from public.friendships f where f.user_a = pair[1] and f.user_b = pair[2];
  -- Standing consent does not survive the relationship it was given in.
  delete from public.together_optin t where t.user_a = pair[1] and t.user_b = pair[2];
end $fn$;
revoke all on function public.block_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;

-- (5) `add_scrapbook_item` is the only media-writing path that skips the
-- `guard_media_reference` checks. messages/stories/memories all get them from a
-- trigger. The realistic failure is ordinary rather than adversarial: the
-- upload succeeds, the RPC fails on a flaky connection, the user retries
-- tomorrow, the 24h cleanup has already collected the object, and the retry
-- writes a permanent scrapbook entry pointing at nothing. The scrapbook is the
-- one DURABLE surface in this app, so a dead reference there is forever.
create or replace function public.guard_scrapbook_media()
returns trigger language plpgsql security definer set search_path=public as $fn$
declare p text;
begin
  foreach p in array array_remove(array[new.media_path, new.thumb_path], null) loop
    if not exists (select 1 from storage.objects o where o.bucket_id='media' and o.name=p) then
      raise exception 'Media upload expired; use a new upload';
    end if;
    if exists (select 1 from public.media_cleanup c where c.path=p and c.deleting) then
      raise exception 'Media upload expired; use a new upload';
    end if;
  end loop;
  return new;
end $fn$;
drop trigger if exists scrapbook_media_guard on public.scrapbook_items;
create trigger scrapbook_media_guard before insert on public.scrapbook_items
  for each row execute function public.guard_scrapbook_media();

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090030_audit_followup') on conflict (id) do nothing;
