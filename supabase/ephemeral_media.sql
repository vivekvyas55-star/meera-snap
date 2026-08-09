-- ============================================================================
-- Make voice notes and stickers ephemeral like chats. Previously
-- mark_chats_opened and clear_viewed_chats were kind='chat' only, so a RECEIVED
-- voice/sticker never got opened_at set and never entered the 3-view clear —
-- it lingered ~31 days AND showed a permanent "New" badge (the chat-list
-- indicator keys off the last message's opened_at for any kind).
--
-- After this: opening a conversation marks received voice/stickers seen (clears
-- New), and they clear across 3 visits via the same view_leaves counter as
-- chats. isVisibleTo already handles all non-snap kinds identically, so no
-- separate visibility rule is needed.
-- ============================================================================

create or replace function public.mark_chats_opened(other uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set opened_at = now()
   where array[user_a, user_b] = public.pair_key(auth.uid(), other)
     and kind in ('chat', 'voice', 'sticker')
     and sender_id <> auth.uid()
     and opened_at is null;
$$;
revoke all on function public.mark_chats_opened(uuid) from public;
grant execute on function public.mark_chats_opened(uuid) to authenticated;

create or replace function public.clear_viewed_chats(other uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set view_leaves = jsonb_set(
           view_leaves,
           array[auth.uid()::text],
           to_jsonb(coalesce((view_leaves ->> auth.uid()::text)::int, 0) + 1)
         ),
         cleared_by = case
           when coalesce((view_leaves ->> auth.uid()::text)::int, 0) + 1 >= 3
                and not (auth.uid() = any(cleared_by))
             then array_append(cleared_by, auth.uid())
           else cleared_by end
   where array[user_a, user_b] = public.pair_key(auth.uid(), other)
     and opened_at is not null
     and saved_by = '{}'
     and (kind in ('chat', 'voice', 'sticker') or sender_id = auth.uid())
     and not (auth.uid() = any(cleared_by));
$$;
revoke all on function public.clear_viewed_chats(uuid) from public;
grant execute on function public.clear_viewed_chats(uuid) to authenticated;

select 'voice + stickers now ephemeral (3-view, like chats)' as status;
