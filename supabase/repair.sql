-- ============================================================================
-- Repair: re-create RPCs that aren't resolving (react_to_message, toggle_saved,
-- record_snap_open), ensure real users are mutually accepted friends, and force
-- a PostgREST schema-cache reload. Idempotent.
-- ============================================================================

-- Schema repair must preserve relationship consent and blocked state.

-- 1b. Ensure the columns the RPCs depend on exist FIRST (snap_reopen.sql may
--     have truncated on paste, so open_count/reactions/cleared_by can be absent).
alter table public.messages add column if not exists open_count int not null default 0;
alter table public.messages add column if not exists reactions jsonb not null default '{}';
alter table public.messages add column if not exists cleared_by uuid[] not null default '{}';
alter table public.messages add column if not exists pending_clear_by uuid[] not null default '{}';
grant update (open_count) on public.messages to authenticated;

-- 2. Re-create the RPCs (idempotent).
create or replace function public.record_snap_open(msg uuid)
returns int language sql security definer set search_path = public as $$
  update public.messages
     set open_count = open_count + 1, opened_at = coalesce(opened_at, now())
   where id = msg and auth.uid() in (user_a, user_b) and sender_id <> auth.uid()
   returning open_count;
$$;
revoke all on function public.record_snap_open(uuid) from public;
grant execute on function public.record_snap_open(uuid) to authenticated;

create or replace function public.react_to_message(msg uuid, emoji text)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set reactions = case when emoji is null or emoji = ''
                          then reactions - auth.uid()::text
                          else jsonb_set(reactions, array[auth.uid()::text], to_jsonb(emoji), true) end
   where id = msg and auth.uid() in (user_a, user_b);
$$;
revoke all on function public.react_to_message(uuid, text) from public;
grant execute on function public.react_to_message(uuid, text) to authenticated;

create or replace function public.toggle_saved(msg uuid)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare result uuid[];
begin
  update public.messages
     set saved_by = case when auth.uid() = any(saved_by)
                         then array_remove(saved_by, auth.uid())
                         else array_append(saved_by, auth.uid()) end
   where id = msg and auth.uid() in (user_a, user_b)
   returning saved_by into result;
  return coalesce(result, '{}');
end $$;
revoke all on function public.toggle_saved(uuid) from public;
grant execute on function public.toggle_saved(uuid) to authenticated;

-- 3. Re-apply the full update guard (covers every mutable column).
create or replace function public.guard_message_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.opened_at     is not null and new.opened_at     is distinct from old.opened_at     then raise exception 'opened_at is immutable'; end if;
  if old.screenshot_at is not null and new.screenshot_at is distinct from old.screenshot_at then raise exception 'screenshot_at is immutable'; end if;
  if old.replayed_at   is not null and new.replayed_at   is distinct from old.replayed_at   then raise exception 'replayed_at is immutable'; end if;
  if old.unsent_at is not null and new.unsent_at is distinct from old.unsent_at then raise exception 'message already unsent'; end if;
  if new.unsent_at is not null and old.unsent_at is null and old.sender_id <> auth.uid() then raise exception 'only the sender may unsend'; end if;
  if new.open_count <> old.open_count then
    if new.open_count < old.open_count then raise exception 'open_count cannot decrease'; end if;
    if auth.uid() = old.sender_id then raise exception 'sender cannot open own snap'; end if;
  end if;
  if new.saved_by is distinct from old.saved_by then
    if (select coalesce(array_agg(x order by x),'{}') from unnest(new.saved_by) x where x <> auth.uid())
       is distinct from (select coalesce(array_agg(x order by x),'{}') from unnest(old.saved_by) x where x <> auth.uid())
    then raise exception 'may only save/unsave for yourself'; end if;
  end if;
  if new.cleared_by is distinct from old.cleared_by then
    if (select coalesce(array_agg(x order by x),'{}') from unnest(new.cleared_by) x where x <> auth.uid())
       is distinct from (select coalesce(array_agg(x order by x),'{}') from unnest(old.cleared_by) x where x <> auth.uid())
    then raise exception 'may only clear for yourself'; end if;
  end if;
  return new;
end $$;
drop trigger if exists on_message_update on public.messages;
create trigger on_message_update before update on public.messages
  for each row execute function public.guard_message_update();

-- 4. Force PostgREST to reload its schema cache so the new functions resolve.
notify pgrst, 'reload schema';

select 'repaired' as status;
