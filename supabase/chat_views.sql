-- ============================================================================
-- Chat messages are viewable 3 times (Snapchat allows 1). Each time the viewer
-- leaves the conversation counts as one view; after the 3rd, the message clears
-- for them. Per-user via a jsonb leave counter, so it never vanishes for the
-- other party early. Saved messages are exempt.
-- ============================================================================

alter table public.messages add column if not exists view_leaves jsonb not null default '{}';

create or replace function public.clear_viewed_chats(other uuid)
returns void language sql security definer set search_path = public as $$
  -- Both SET clauses read the OLD row: increment this viewer's leave count, and
  -- clear only once that count reaches 3.
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
     and (kind = 'chat' or sender_id = auth.uid())
     and not (auth.uid() = any(cleared_by));
$$;
revoke all on function public.clear_viewed_chats(uuid) from public;
grant execute on function public.clear_viewed_chats(uuid) to authenticated;

select 'chat 3-view enabled' as status;
