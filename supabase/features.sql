-- ============================================================================
-- avatar_emoji (make the ad-hoc column reproducible) + message reactions.
-- ============================================================================

-- avatar_emoji: column, grant, and expose it in the username lookup so friends
-- see each other's chosen emoji.
alter table public.profiles add column if not exists avatar_emoji text;
grant update (avatar_emoji) on public.profiles to authenticated;

-- Return-type changed (added avatar_emoji), so the old signature must be dropped.
drop function if exists public.lookup_username(citext);
create or replace function public.lookup_username(u citext)
returns table (id uuid, username citext, display_name text, avatar_seed text, avatar_hue int, avatar_emoji text)
language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.display_name, p.avatar_seed, p.avatar_hue, p.avatar_emoji
    from public.profiles p where p.username = u;
$$;
revoke all on function public.lookup_username(citext) from public;
grant execute on function public.lookup_username(citext) to authenticated;

-- ----------------------------------------------------------------------------
-- Reactions: a jsonb map of user_id -> emoji on each message (Apple-style
-- tapback; one reaction per user). Written ONLY via the RPC (which is
-- SECURITY DEFINER and touches just the caller's own key), so no direct
-- table-update grant is given — that prevents overwriting others' reactions.
-- ----------------------------------------------------------------------------
alter table public.messages add column if not exists reactions jsonb not null default '{}';

create or replace function public.react_to_message(msg uuid, emoji text)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set reactions = case
           when emoji is null or emoji = ''
             then reactions - auth.uid()::text
           else jsonb_set(reactions, array[auth.uid()::text], to_jsonb(emoji), true)
         end
   where id = msg and auth.uid() in (user_a, user_b);
$$;
revoke all on function public.react_to_message(uuid, text) from public;
grant execute on function public.react_to_message(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Profile changes (emoji / name) should reach friends live, so publish the
-- profiles table for realtime.
-- ----------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end $$;

-- ----------------------------------------------------------------------------
-- Atomic save/unsave (B3): avoids the client read-modify-write race that could
-- silently drop the other party's entry and trip the guard.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- Also purge fully-cleared messages so "delete after viewing" actually removes
-- them server-side (both parties cleared, none saved).
-- ----------------------------------------------------------------------------
create or replace function public.purge_expired()
returns void language plpgsql security definer set search_path = public as $$
begin
  with gone as (
    delete from public.messages
     where saved_by = '{}'
       and ((opened_at is not null and opened_at < now() - interval '24 hours')
            or (opened_at is null and created_at < now() - interval '31 days')
            or (unsent_at is not null and unsent_at < now() - interval '1 hour')
            or (cardinality(cleared_by) >= 2))
    returning media_path)
  delete from storage.objects
   where bucket_id = 'media' and name in (select media_path from gone where media_path is not null);

  with dead as (delete from public.stories where expires_at < now() returning media_path)
  delete from storage.objects
   where bucket_id = 'media' and name in (select media_path from dead where media_path is not null);
end $$;
