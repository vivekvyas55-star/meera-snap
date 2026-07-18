-- ============================================================================
-- Snapchat "Delete after viewing" — the default chat behaviour.
-- A chat disappears for a viewer once they have seen it AND left the
-- conversation. Per-user, so it never vanishes for the other party before they
-- have read it. Saved messages are exempt.
-- ============================================================================

alter table public.messages add column if not exists cleared_by uuid[] not null default '{}';
grant update (cleared_by) on public.messages to authenticated;

-- Called when a user leaves a conversation: marks every chat they have already
-- opened as cleared for them alone. One statement, server-side, so a client
-- cannot clear on someone else's behalf (auth.uid() is the only id written).
create or replace function public.clear_viewed_chats(other uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set cleared_by = array_append(cleared_by, auth.uid())
   where kind = 'chat'
     and array[user_a, user_b] = public.pair_key(auth.uid(), other)
     and opened_at is not null
     and saved_by = '{}'
     and not (auth.uid() = any(cleared_by));
$$;
revoke all on function public.clear_viewed_chats(uuid) from public;
grant execute on function public.clear_viewed_chats(uuid) to authenticated;

-- Let the existing update guard treat cleared_by like saved_by: a caller may
-- only add or remove their OWN id.
create or replace function public.guard_message_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.opened_at     is not null and new.opened_at     is distinct from old.opened_at     then raise exception 'opened_at is immutable'; end if;
  if old.screenshot_at is not null and new.screenshot_at is distinct from old.screenshot_at then raise exception 'screenshot_at is immutable'; end if;
  if old.replayed_at   is not null and new.replayed_at   is distinct from old.replayed_at   then raise exception 'replayed_at is immutable'; end if;
  if old.unsent_at is not null and new.unsent_at is distinct from old.unsent_at then raise exception 'message already unsent'; end if;
  if new.unsent_at is not null and old.unsent_at is null and old.sender_id <> auth.uid() then
    raise exception 'only the sender may unsend'; end if;
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
