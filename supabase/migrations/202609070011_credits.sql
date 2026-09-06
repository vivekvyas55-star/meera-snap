-- Credit meter on top of the (still inert) billing module.
--
-- Everyone holds a balance of credits; a month of Meera costs
-- `billing_settings.credits_per_month` (99). Founding users were granted a
-- balance large enough that this changes nothing for them for years — the
-- meter exists so that access has a cost that is *visible and auditable*, not
-- so that anyone currently here loses the app.
--
-- Three rules drive the design, and each one is a scar from somebody else's
-- billing system:
--
-- 1. THE LEDGER IS THE TRUTH. Balance is `sum(delta)` over append-only rows,
--    never a mutable `credits` column. A column that is UPDATEd in place
--    drifts the first time two writers race, and once it has drifted you can
--    never answer "why is this number what it is". Every credit that exists
--    has a row saying where it came from.
-- 2. POSTING IS IDEMPOTENT. `(user_id, period)` is unique, so a cron that
--    double-fires, a retried transaction, or a human re-running the monthly
--    job by hand CANNOT charge anyone twice. This is the single most important
--    property in the file. Grants and manual adjustments carry period NULL and
--    are exempt via a partial index.
-- 3. THE CLIENT NEVER WRITES CREDITS. `credit_ledger` grants SELECT to
--    authenticated and nothing else, and RLS scopes that to your own rows.
--    Someone who can POST their own credit row has bought nothing.
--
-- Also, per CLAUDE.md's hardest-won lesson: privileges are checked BEFORE RLS,
-- so every grant here is stated explicitly. A policy without a matching grant
-- fails with 42501 and the policy never even runs.
begin;

-- ---------------------------------------------------------------------------
-- The monthly price, in credits, lives in settings next to `enforced`.
-- Server-controlled and in exactly one place, so the deduction job and
-- entitlement() can never disagree about what a month costs.
-- ---------------------------------------------------------------------------
alter table public.billing_settings
  add column if not exists credits_per_month int not null default 99;

do $$ begin
  alter table public.billing_settings
    add constraint billing_settings_credits_sane check (credits_per_month > 0);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- credit_ledger: append-only
-- ---------------------------------------------------------------------------
create table if not exists public.credit_ledger (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      int  not null,               -- + granted, - charged
  reason     text not null,
  -- 'YYYY-MM' for a monthly charge; NULL for grants and one-off adjustments,
  -- which are allowed to repeat and so must stay out of the unique index.
  period     text check (period ~ '^\d{4}-\d{2}$'),
  created_at timestamptz not null default now(),
  constraint credit_ledger_reason_present check (length(btrim(reason)) > 0),
  constraint credit_ledger_delta_nonzero check (delta <> 0)
);

-- The idempotency guarantee. One charge per user per period, enforced by the
-- database rather than by the job remembering to check.
create unique index if not exists credit_ledger_period_uniq
  on public.credit_ledger (user_id, period)
  where period is not null;

-- The opening grant must survive this migration being run twice. The insert
-- below also guards with NOT EXISTS, but a guard in a query is a convention
-- and this is a constraint: nothing can hand out a second founding balance,
-- including a human pasting the INSERT again on its own.
create unique index if not exists credit_ledger_one_grant
  on public.credit_ledger (user_id, reason)
  where reason in ('founding_grant', 'signup_grant');

-- Balance is a SUM per user, so that is the access pattern to index for.
create index if not exists credit_ledger_user_idx
  on public.credit_ledger (user_id, created_at desc);

alter table public.credit_ledger enable row level security;

-- Read your own rows. There is deliberately NO insert, update or delete policy
-- for authenticated: writes come from service_role or the SECURITY DEFINER
-- functions below. Append-only is also enforced by the absence of grants —
-- nobody but the owner can UPDATE or DELETE a posted row, so history cannot be
-- rewritten to hide a charge.
drop policy if exists credit_ledger_read_own on public.credit_ledger;
create policy credit_ledger_read_own on public.credit_ledger
  for select to authenticated using (user_id = auth.uid());

revoke all on public.credit_ledger from public, anon, authenticated;
grant select on public.credit_ledger to authenticated;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- The fast balance read. SECURITY DEFINER because entitlement() and the
-- monthly job need it for a user who is not the caller (pg_cron has no
-- auth.uid() at all), and a plain SUM under RLS would return 0 there.
--
-- It is therefore NOT granted to authenticated: a definer function taking an
-- arbitrary uuid is a read of anyone's balance by anyone. Clients get their
-- own number through entitlement(), which pins it to auth.uid().
create or replace function public.credit_balance(target uuid)
returns int language sql stable security definer set search_path = public as $fn$
  select coalesce(sum(delta), 0)::int
    from public.credit_ledger where user_id = target;
$fn$;
revoke all on function public.credit_balance(uuid) from public, anon, authenticated;

-- The current billing period, as the 'YYYY-MM' the ledger stores.
--
-- IST, not UTC — the same boundary `ist_date()` gives the question of the day
-- and `friendship_charms`. A UTC month rolls over at 05:30 IST, which would
-- charge a user for a new month while it is still the small hours of the last
-- night of the old one.
create or replace function public.billing_period()
returns text language sql stable set search_path = public as $fn$
  select to_char(public.ist_date(), 'YYYY-MM');
$fn$;
revoke all on function public.billing_period() from public, anon;
grant execute on function public.billing_period() to authenticated;

-- ---------------------------------------------------------------------------
-- entitlement(): extended, not replaced.
--
-- `create or replace` cannot widen a function's return type, so the old
-- signature is dropped first. Nothing in the database depends on it (no policy
-- gates on entitlement yet), so this is safe; if that ever changes, the drop
-- will fail loudly rather than silently leaving a stale definition.
-- ---------------------------------------------------------------------------
drop function if exists public.start_trial();
drop function if exists public.entitlement();

create or replace function public.entitlement()
returns table (
  allowed       boolean,
  status        text,
  plan          text,
  until         timestamptz,
  enforced      boolean,
  credits       int,
  credits_until timestamptz
)
language sql stable security definer set search_path = public as $fn$
  with cfg as (
    select s.enforced, s.credits_per_month as rate from public.billing_settings s where s.id
  ),
  sub as (select * from public.subscriptions s where s.user_id = auth.uid()),
  bal as (select public.credit_balance(auth.uid()) as credits),
  -- Has this month already been charged? Without this the runway is a month
  -- short for everyone from the moment the monthly job runs — the current
  -- month is paid for, so it is not one of the months the balance still has
  -- to buy. Off-by-one months are how billing screens lose people's trust.
  paid as (
    select exists (
      select 1 from public.credit_ledger l
       where l.user_id = auth.uid() and l.period = public.billing_period()
    ) as this_month
  )
  select
    -- While billing is off, everyone is allowed — the module stays inert and
    -- switching it on is a deliberate act, never a side effect of this file.
    -- Grandfathered is allowed regardless of balance: those accounts predate
    -- plans entirely and must never be locked out by a meter they never opted
    -- into.
    (not (select enforced from cfg))
      or coalesce((select status from sub) in ('active','grandfathered'), false)
      or coalesce((select status from sub) = 'trialing'
                  and (select trial_ends_at from sub) > now(), false)
      -- In credit while the balance still covers a whole month...
      or ((select credits from bal) >= (select rate from cfg))
      -- ...and for the rest of any month already charged for. Taking the 99
      -- credits and then cutting access on the same day the balance dips below
      -- the next month's price is charging someone for a month they don't get.
      -- This keeps `allowed` and `credits_until` saying the same thing: you
      -- have access right up to credits_until, and not a day less.
      or (select this_month from paid)
      as allowed,
    coalesce((select status from sub), 'none') as status,
    (select plan from sub) as plan,
    coalesce((select current_period_end from sub), (select trial_ends_at from sub)) as until,
    (select enforced from cfg) as enforced,
    (select credits from bal)::int as credits,
    -- How far the balance stretches: the start of the first IST month the
    -- balance cannot pay for — i.e. the instant `allowed` would flip. It is
    -- the next unpaid month plus however many whole months the balance buys;
    -- floor() because a part month buys nothing. A balance already below the
    -- rate lands this in the past, which is exactly right.
    (
      (date_trunc('month', public.ist_date()::timestamp)
        + make_interval(months =>
            (case when (select this_month from paid) then 1 else 0 end)
            + greatest(floor((select credits from bal)::numeric
                             / (select rate from cfg))::int, 0))
        - interval '5 hours 30 minutes')     -- IST midnight expressed in UTC
      at time zone 'UTC'
    ) as credits_until
  where auth.uid() is not null;
$fn$;
revoke all on function public.entitlement() from public, anon;
grant execute on function public.entitlement() to authenticated;

-- Unchanged behaviour; recreated only because its return type follows
-- entitlement()'s. Still only ever moves 'none' -> 'trialing', so it cannot be
-- replayed to extend a trial or to downgrade a paid or grandfathered row.
create or replace function public.start_trial()
returns table (
  allowed       boolean,
  status        text,
  plan          text,
  until         timestamptz,
  enforced      boolean,
  credits       int,
  credits_until timestamptz
)
language plpgsql volatile security definer set search_path = public as $fn$
declare days int;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  select trial_days into days from public.billing_settings where id;

  insert into public.subscriptions (user_id, status, trial_ends_at)
  values (auth.uid(), 'trialing', now() + make_interval(days => days))
  on conflict (user_id) do update
    set status = 'trialing',
        trial_ends_at = now() + make_interval(days => days),
        updated_at = now()
  where public.subscriptions.status = 'none'
    and public.subscriptions.trial_ends_at is null;

  return query select * from public.entitlement();
end $fn$;
revoke all on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated;

-- ---------------------------------------------------------------------------
-- Monthly deduction
-- ---------------------------------------------------------------------------

-- One -99 row per non-grandfathered user for the current period. Safe to run
-- as often as you like: the unique index on (user_id, period) turns a second
-- run in the same month into a no-op, so a double-fired cron, a retry after a
-- timeout, and a manual re-run all cost the same as running it once.
--
-- Balances are allowed to go negative. Skipping the charge for a user who
-- cannot afford it would make "why is this balance what it is" unanswerable —
-- the ledger has to record every month the account was open, and access is
-- decided separately by entitlement()'s `credits >= rate`.
create or replace function public.post_monthly_credits(for_period text default null)
returns int language plpgsql volatile security definer set search_path = public as $fn$
declare
  p       text := coalesce(for_period, public.billing_period());
  rate    int;
  posted  int;
begin
  if p !~ '^\d{4}-\d{2}$' then
    raise exception 'period must be YYYY-MM, got %', p;
  end if;
  select credits_per_month into rate from public.billing_settings where id;
  -- Refuse rather than guess. A missing settings row would otherwise insert a
  -- NULL delta and fail halfway through the batch with a constraint error.
  if rate is null then raise exception 'billing_settings row is missing'; end if;

  insert into public.credit_ledger (user_id, delta, reason, period)
  select u.id, -rate, 'monthly', p
    from auth.users u
    left join public.subscriptions s on s.user_id = u.id
   where coalesce(s.status, 'none') <> 'grandfathered'
  on conflict (user_id, period) where period is not null do nothing;

  get diagnostics posted = row_count;
  return posted;
end $fn$;
-- Owner/cron only. Nobody signed in has any business triggering a billing run.
revoke all on function public.post_monthly_credits(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Opening balances
-- ---------------------------------------------------------------------------

-- New signups start with 10,000. Wrapped in an exception block for the same
-- reason chat_backup.sql's trigger is: a credits problem must NEVER roll back
-- account creation. A missing grant is a row someone can add later; a signup
-- that 500s is a user who never gets in at all.
create or replace function public.grant_signup_credits()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  begin
    insert into public.credit_ledger (user_id, delta, reason)
    values (new.id, 10000, 'signup_grant')
    on conflict do nothing;
  exception when others then null;
  end;
  return new;
end $fn$;

-- Its own trigger rather than an edit to handle_new_user(). That function is
-- redefined across migrations and last-applied-wins; folding credits into it
-- here would quietly make this file the live definition of profile creation.
drop trigger if exists on_profile_created_credits on public.profiles;
create trigger on_profile_created_credits
  after insert on public.profiles
  for each row execute function public.grant_signup_credits();

-- Founding balances: 50,000 for vivek and sneha, 10,000 for everyone else who
-- is already here. Resolved through profiles.username rather than hardcoded
-- uuids so this reads the same in any environment.
--
-- Idempotent twice over: the NOT EXISTS guard, and credit_ledger_one_grant
-- above which makes a duplicate physically impossible. The guard covers
-- signup_grant too, so re-running this after new users have joined cannot top
-- them up a second time.
insert into public.credit_ledger (user_id, delta, reason)
select p.id,
       case when p.username in ('vivek', 'sneha') then 50000 else 10000 end,
       'founding_grant'
  from public.profiles p
 where not exists (
   select 1 from public.credit_ledger l
    where l.user_id = p.id
      and l.reason in ('founding_grant', 'signup_grant')
 );

notify pgrst, 'reload schema';
commit;
