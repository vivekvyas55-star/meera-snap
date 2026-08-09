-- ============================================================================
-- Chat-list load: one query instead of N.
--
-- ChatList.load() called listMessages() once PER accepted friend — each pulling
-- a 200-row page — purely to find the newest visible message for each row. It
-- is also wired to unfiltered postgres_changes on messages / friendships /
-- streaks / profiles, so EVERY message insert anywhere in your conversations
-- re-ran the whole N x 200 sweep. On an active chat that is a full refetch per
-- message received.
--
-- latest_messages() returns just the newest few rows per conversation in a
-- single round trip. A few (not one) because visibility is decided client-side
-- by isVisibleTo — cleared / consumed / expired messages are filtered after the
-- fetch, so the row needs a little depth to fall back through before giving up
-- and showing "Tap to chat".
--
-- SECURITY INVOKER (the default): RLS on public.messages still restricts this
-- to conversations the caller is part of. The auth.uid() predicate is there to
-- narrow the scan, not to enforce access.
-- ============================================================================
create or replace function public.latest_messages(per_pair int default 4)
returns setof public.messages
language sql stable set search_path = public as $$
  select l.*
    from (
      select distinct user_a, user_b
        from public.messages
       where auth.uid() in (user_a, user_b)
    ) p
    cross join lateral (
      select m.*
        from public.messages m
       where m.user_a = p.user_a
         and m.user_b = p.user_b
         and m.unsent_at is null
       order by m.created_at desc
       limit greatest(1, least(per_pair, 20))
    ) l;
$$;
revoke all on function public.latest_messages(int) from public;
grant execute on function public.latest_messages(int) to authenticated;

-- Supports both the lateral lookup above and listMessages' newest-first paging.
create index if not exists messages_pair_recent_idx
  on public.messages (user_a, user_b, created_at desc);

notify pgrst, 'reload schema';
select 'latest_messages RPC + pair/recency index ready' as status;
