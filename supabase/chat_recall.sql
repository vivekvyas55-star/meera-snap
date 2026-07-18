-- ============================================================================
-- Two-stage "delete after viewing": an opened message survives the first
-- leave-and-return, and only vanishes on the second — so you get one recall
-- pass before it's gone. First leave marks it pending; second leave clears it.
-- ============================================================================

alter table public.messages add column if not exists pending_clear_by uuid[] not null default '{}';

create or replace function public.clear_viewed_chats(other uuid)
returns void language sql security definer set search_path = public as $$
  -- Both SET expressions read the OLD row, so on the first call the message is
  -- only marked pending; on the second (already pending) it's actually cleared.
  update public.messages
     set pending_clear_by = case
           when not (auth.uid() = any(pending_clear_by))
             then array_append(pending_clear_by, auth.uid())
           else pending_clear_by end,
         cleared_by = case
           when (auth.uid() = any(pending_clear_by)) and not (auth.uid() = any(cleared_by))
             then array_append(cleared_by, auth.uid())
           else cleared_by end
   where array[user_a, user_b] = public.pair_key(auth.uid(), other)
     and opened_at is not null
     and saved_by = '{}'
     and (kind = 'chat' or sender_id = auth.uid())
     and not (auth.uid() = any(cleared_by));
$$;
revoke all on function public.clear_viewed_chats(uuid) from public;
grant execute on function public.clear_viewed_chats(uuid) to authenticated;
