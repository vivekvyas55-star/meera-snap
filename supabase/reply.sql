-- ============================================================================
-- Quoted replies (swipe-left to reply, like Snapchat/WhatsApp). A message can
-- reference the message it replies to. Nullable; `on delete set null` so a reply
-- never dangles if the original is unsent/purged. Column grants added to the
-- existing per-column grant model (INSERT to write it, SELECT to read it back).
-- ============================================================================
alter table public.messages
  add column if not exists reply_to uuid references public.messages(id) on delete set null;

grant insert (reply_to), select (reply_to) on public.messages to authenticated;

notify pgrst, 'reload schema';
select 'reply_to column added' as status;
