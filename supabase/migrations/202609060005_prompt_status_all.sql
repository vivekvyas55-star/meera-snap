-- The chat list could not show that a friend is waiting on your answer to
-- today's question without asking prompt_status() once per friend. This returns
-- the whole set in one round trip, which is what listLatestPerFriend already
-- does for message previews.
--
-- It reveals only the two booleans, never the answer text — the simultaneous
-- reveal is still enforced by RLS on prompt_answers.
begin;

create or replace function public.prompt_status_all()
returns table (other uuid, mine_done boolean, theirs_done boolean)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as id),
  friends as (
    select case when f.user_a = me.id then f.user_b else f.user_a end as other
    from public.friendships f, me
    where f.status = 'accepted' and me.id in (f.user_a, f.user_b)
  )
  select
    fr.other,
    exists (
      select 1 from public.prompt_answers a, me
      where a.user_a = least(me.id, fr.other) and a.user_b = greatest(me.id, fr.other)
        and a.on_date = public.ist_date() and a.responder = me.id
    ) as mine_done,
    exists (
      select 1 from public.prompt_answers a, me
      where a.user_a = least(me.id, fr.other) and a.user_b = greatest(me.id, fr.other)
        and a.on_date = public.ist_date() and a.responder = fr.other
    ) as theirs_done
  from friends fr;
$$;

revoke all on function public.prompt_status_all() from public, anon;
grant execute on function public.prompt_status_all() to authenticated;

notify pgrst, 'reload schema';
commit;
