-- ============================================================================
-- Snap reopens: a recipient may reopen a photo snap up to 3 times (4 views
-- total) before it's consumed, instead of the single Snapchat replay.
-- ============================================================================

alter table public.messages add column if not exists open_count int not null default 0;
grant update (open_count) on public.messages to authenticated;

-- Atomic increment so two quick opens can't race the count. Also stamps
-- opened_at on the first view. Only the recipient (not the sender) may open,
-- and only their own received snap.
create or replace function public.record_snap_open(msg uuid)
returns int language sql security definer set search_path = public as $$
  update public.messages
     set open_count = open_count + 1,
         opened_at  = coalesce(opened_at, now())
   where id = msg
     and auth.uid() in (user_a, user_b)
     and sender_id <> auth.uid()
   returning open_count;
$$;
revoke all on function public.record_snap_open(uuid) from public;
grant execute on function public.record_snap_open(uuid) to authenticated;

-- Leaving a conversation now also clears the *sender's* opened snap status rows
-- (so "Opened" snaps vanish on Back like Snapchat), while the recipient's snap
-- is left alone so they can still reopen it up to the limit. Chats clear for
-- whoever has opened them, as before.
create or replace function public.clear_viewed_chats(other uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set cleared_by = array_append(cleared_by, auth.uid())
   where array[user_a, user_b] = public.pair_key(auth.uid(), other)
     and saved_by = '{}'
     and not (auth.uid() = any(cleared_by))
     and opened_at is not null
     and (kind = 'chat' or sender_id = auth.uid());
$$;

-- Extend the update guard so open_count can only increase, and only for the
-- recipient. (SECURITY DEFINER functions still fire this trigger, and auth.uid()
-- inside them is the calling user, so the recipient check holds.)
create or replace function public.guard_message_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.opened_at     is not null and new.opened_at     is distinct from old.opened_at     then raise exception 'opened_at is immutable'; end if;
  if old.screenshot_at is not null and new.screenshot_at is distinct from old.screenshot_at then raise exception 'screenshot_at is immutable'; end if;
  if old.replayed_at   is not null and new.replayed_at   is distinct from old.replayed_at   then raise exception 'replayed_at is immutable'; end if;
  if old.unsent_at is not null and new.unsent_at is distinct from old.unsent_at then raise exception 'message already unsent'; end if;
  if new.unsent_at is not null and old.unsent_at is null and old.sender_id <> auth.uid() then
    raise exception 'only the sender may unsend'; end if;
  if new.open_count <> old.open_count then
    if new.open_count < old.open_count then raise exception 'open_count cannot decrease'; end if;
    if auth.uid() = old.sender_id then raise exception 'sender cannot open own snap'; end if;
  end if;
  if new.saved_by is distinct from old.saved_by then
    if (select coalesce(array_agg(x order by x), '{}') from unnest(new.saved_by) x where x <> auth.uid())
       is distinct from
       (select coalesce(array_agg(x order by x), '{}') from unnest(old.saved_by) x where x <> auth.uid())
    then raise exception 'may only save/unsave for yourself'; end if;
  end if;
  if new.cleared_by is distinct from old.cleared_by then
    if (select coalesce(array_agg(x order by x), '{}') from unnest(new.cleared_by) x where x <> auth.uid())
       is distinct from
       (select coalesce(array_agg(x order by x), '{}') from unnest(old.cleared_by) x where x <> auth.uid())
    then raise exception 'may only clear for yourself'; end if;
  end if;
  return new;
end $$;
