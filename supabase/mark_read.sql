-- ============================================================================
-- Atomic "mark incoming chats read" when a conversation is opened — one
-- statement, one realtime event, so the chat-list clears the New indicator
-- reliably (no per-message race).
-- ============================================================================
create or replace function public.mark_chats_opened(other uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set opened_at = now()
   where array[user_a, user_b] = public.pair_key(auth.uid(), other)
     and kind = 'chat'
     and sender_id <> auth.uid()
     and opened_at is null;
$$;
revoke all on function public.mark_chats_opened(uuid) from public;
grant execute on function public.mark_chats_opened(uuid) to authenticated;
