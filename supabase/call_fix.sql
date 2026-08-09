-- ============================================================================
-- Call-log fixes (audit findings 2 & 4).
--
-- 2. `logCall` stores the call DURATION in messages.view_seconds, but the
--    `view_seconds_sane` constraint only allowed 1..60. A MISSED call (0s) or a
--    call longer than 60s violated the check → 23514, which useCall swallows
--    with .catch(() => {}), so the call log silently never wrote. That is
--    exactly the "call was made / they were unavailable" log the app is meant
--    to show. Exempt kind='call' from the range.
--
-- 4. `mark_chats_opened` didn't include 'call', so a received call log as the
--    last message left a permanent "unread" indicator in the chat list.
-- ============================================================================

-- 2 ------------------------------------------------------------------------
alter table public.messages drop constraint if exists view_seconds_sane;
alter table public.messages add constraint view_seconds_sane
  check (kind = 'call' or view_seconds is null or view_seconds between 1 and 60);

-- 4 ------------------------------------------------------------------------
create or replace function public.mark_chats_opened(other uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages
     set opened_at = coalesce(opened_at, now())
   where auth.uid() in (user_a, user_b)
     and sender_id = other
     and kind in ('chat', 'voice', 'sticker', 'call')
     and opened_at is null;
$$;
revoke all on function public.mark_chats_opened(uuid) from public;
grant execute on function public.mark_chats_opened(uuid) to authenticated;

notify pgrst, 'reload schema';
select 'call-log constraint + mark-opened fixed' as status;
