-- Follow-up audit upgrade. Apply to an existing Meera project after the
-- 202609070011 credits migration; do not rebuild the fresh-install baseline.
begin;

-- A message thumbnail is still a live media reference. The cleanup claim used
-- to check only messages.media_path, which let a due thumbnail be deleted
-- after its message had committed. Purging a message must also queue its
-- thumbnail, otherwise kept-media thumbnails accumulate forever.
create or replace function public.purge_expired()
returns void language plpgsql security definer set search_path=public as $fn$
begin
  with gone as (
    delete from public.messages
     where kind <> 'call' and saved_by='{}' and (
       (opened_at is not null and opened_at<now()-interval '24 hours') or
       (opened_at is null and created_at<now()-interval '31 days') or
       (unsent_at is not null and unsent_at<now()-interval '1 hour') or
       cardinality(cleared_by)>=2
     )
     returning media_path, thumb_path
  )
  insert into public.media_cleanup(path,due_at)
  select distinct path, now()
    from gone cross join lateral unnest(array[media_path, thumb_path]) as f(path)
   where path is not null
  on conflict(path) do update set due_at=excluded.due_at;

  with gone as (
    delete from public.stories where expires_at<now() returning media_path
  )
  insert into public.media_cleanup(path,due_at)
  select distinct media_path,now() from gone where media_path is not null
  on conflict(path) do update set due_at=excluded.due_at;

  delete from public.message_visits where created_at<now()-interval '7 days';
end $fn$;

create or replace function public.claim_media_cleanup(object_path text)
returns boolean language plpgsql security definer set search_path=public as $fn$
begin
  perform 1 from public.media_cleanup where path=object_path and due_at<=now() for update;
  if not found then return false; end if;
  if exists(select 1 from public.messages where media_path=object_path or thumb_path=object_path)
     or exists(select 1 from public.stories where media_path=object_path)
     or exists(select 1 from public.memories where media_path=object_path or thumb_path=object_path) then
    delete from public.media_cleanup where path=object_path;
    return false;
  end if;
  update public.media_cleanup set deleting=true where path=object_path;
  return true;
end $fn$;
revoke all on function public.claim_media_cleanup(text) from public,anon,authenticated;
grant execute on function public.claim_media_cleanup(text) to service_role;

-- Serialize asks for a friendship while checking the daily cap. Counting and
-- inserting without a pair lock allowed simultaneous requests to bypass 3/day.
create or replace function public.ask_question(other uuid, body text)
returns public.pair_questions
language plpgsql volatile security definer set search_path = public as $fn$
declare pk uuid[]; d date; used int; row public.pair_questions;
begin
  if auth.uid() is null or other is null or other = auth.uid() then
    raise exception 'not allowed';
  end if;
  if body is null or length(btrim(body)) = 0 then
    raise exception 'Write a question first';
  end if;
  if length(btrim(body)) > 300 then
    raise exception 'Questions can be up to 300 characters';
  end if;

  pk := public.pair_key(auth.uid(), other);
  -- The friendship row is the stable, unique lock for this pair.
  perform 1 from public.friendships f
   where f.status = 'accepted' and f.user_a = pk[1] and f.user_b = pk[2]
   for update;
  if not found then raise exception 'not allowed'; end if;

  d := public.ist_date();
  select count(*) into used from public.pair_questions q
   where q.user_a = pk[1] and q.user_b = pk[2]
     and q.asker = auth.uid() and q.on_date = d;
  if used >= 3 then raise exception 'That is your three questions for today'; end if;

  insert into public.pair_questions (user_a, user_b, asker, body, on_date)
  values (pk[1], pk[2], auth.uid(), btrim(body), d)
  returning * into row;
  return row;
end $fn$;
revoke all on function public.ask_question(uuid, text) from public, anon;
grant execute on function public.ask_question(uuid, text) to authenticated;

-- The chat-list badge is a “needs you today” signal, so historical questions
-- that are no longer shown in the card must not keep an unread badge alive.
create or replace function public.pending_questions_all()
returns table (other uuid, pending int)
language sql stable security definer set search_path = public as $fn$
  with me as (select auth.uid() as id),
  friends as (
    select case when f.user_a = me.id then f.user_b else f.user_a end as other
      from public.friendships f, me
     where f.status = 'accepted' and me.id in (f.user_a, f.user_b)
  )
  select fr.other, (
    select count(*)
      from public.pair_questions q, me
     where q.user_a = least(me.id, fr.other) and q.user_b = greatest(me.id, fr.other)
       and q.asker = fr.other and q.answer is null and q.on_date = public.ist_date()
  )::int as pending
  from friends fr;
$fn$;
revoke all on function public.pending_questions_all() from public, anon;
grant execute on function public.pending_questions_all() to authenticated;

-- Credits are prepaid. Do not create debt when a balance cannot fund the next
-- period, and do not keep a user entitled from a paid period they cannot cover.
create or replace function public.post_monthly_credits(for_period text default null)
returns int language plpgsql volatile security definer set search_path = public as $fn$
declare p text := coalesce(for_period, public.billing_period()); rate int; posted int;
begin
  if p !~ '^\d{4}-\d{2}$' then raise exception 'period must be YYYY-MM, got %', p; end if;
  select credits_per_month into rate from public.billing_settings where id;
  if rate is null then raise exception 'billing_settings row is missing'; end if;

  insert into public.credit_ledger (user_id, delta, reason, period)
  select u.id, -rate, 'monthly', p
    from auth.users u left join public.subscriptions s on s.user_id = u.id
   where coalesce(s.status, 'none') <> 'grandfathered'
     and coalesce((select sum(l.delta) from public.credit_ledger l where l.user_id = u.id), 0) >= rate
  on conflict (user_id, period) where period is not null do nothing;
  get diagnostics posted = row_count;
  return posted;
end $fn$;
revoke all on function public.post_monthly_credits(text) from public, anon, authenticated;

create or replace function public.entitlement()
returns table (allowed boolean, status text, plan text, until timestamptz, enforced boolean, credits int, credits_until timestamptz)
language sql stable security definer set search_path = public as $fn$
  with cfg as (select s.enforced, s.credits_per_month as rate from public.billing_settings s where s.id),
  sub as (select * from public.subscriptions s where s.user_id = auth.uid()),
  bal as (select public.credit_balance(auth.uid()) as credits),
  paid as (select exists(select 1 from public.credit_ledger l where l.user_id=auth.uid() and l.period=public.billing_period()) as this_month)
  select
    (not (select enforced from cfg))
      or coalesce((select status from sub) = 'grandfathered', false)
      or coalesce((select status from sub) = 'active' and (select current_period_end from sub) > now(), false)
      or coalesce((select status from sub) = 'trialing' and (select trial_ends_at from sub) > now(), false)
      or ((select credits from bal) >= (select rate from cfg))
      or ((select this_month from paid) and (select credits from bal) >= 0) as allowed,
    coalesce((select status from sub), 'none') as status,
    (select plan from sub) as plan,
    coalesce((select current_period_end from sub), (select trial_ends_at from sub)) as until,
    (select enforced from cfg) as enforced,
    (select credits from bal)::int as credits,
    ((date_trunc('month', public.ist_date()::timestamp)
      + make_interval(months => (case when (select this_month from paid) then 1 else 0 end)
        + greatest(floor((select credits from bal)::numeric / (select rate from cfg))::int, 0))
      - interval '5 hours 30 minutes') at time zone 'UTC') as credits_until
  where auth.uid() is not null;
$fn$;
revoke all on function public.entitlement() from public, anon;
grant execute on function public.entitlement() to authenticated;

notify pgrst, 'reload schema';
commit;
