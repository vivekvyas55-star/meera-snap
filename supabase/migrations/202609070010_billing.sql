-- Subscription plumbing. Built INERT: `billing.enforced` defaults to false, so
-- entitlement() returns full access to everyone and nothing in the app changes
-- until that flag is deliberately turned on.
--
-- Two rules drive the whole design:
--
-- 1. Entitlement is decided in the DATABASE, never by the client. The anon key
--    ships in the bundle, so a client-side `isSubscribed` boolean is one
--    devtools edit away from free. Features gate on entitlement() under RLS.
-- 2. The client can never write its own subscription. Every row here is written
--    by the payment webhook running as service_role, or by the trial RPC which
--    is SECURITY DEFINER and only ever grants a trial the user does not have.
--    A user who could POST their own `status = 'active'` has bought nothing.
begin;

-- ---------------------------------------------------------------------------
-- settings: one row, server-controlled
-- ---------------------------------------------------------------------------
create table if not exists public.billing_settings (
  id        boolean primary key default true,
  enforced  boolean not null default false,
  trial_days int    not null default 3,
  constraint billing_settings_single check (id)
);
insert into public.billing_settings (id) values (true) on conflict (id) do nothing;

alter table public.billing_settings enable row level security;
drop policy if exists billing_settings_read on public.billing_settings;
create policy billing_settings_read on public.billing_settings
  for select to authenticated using (true);
revoke all on public.billing_settings from public, anon, authenticated;
grant select on public.billing_settings to authenticated;

-- ---------------------------------------------------------------------------
-- plans
-- ---------------------------------------------------------------------------
create table if not exists public.billing_plans (
  code        text primary key,
  name        text not null,
  paise       int  not null,           -- store money as integer minor units
  period      text not null check (period in ('month', 'year')),
  active      boolean not null default true,
  sort        int not null default 0,
  constraint billing_plans_paise_sane check (paise > 0 and paise <= 10000000)
);

insert into public.billing_plans (code, name, paise, period, sort) values
  ('monthly', 'Monthly', 9900, 'month', 1),
  ('annual',  'Annual',  99900, 'year',  2)
on conflict (code) do nothing;

alter table public.billing_plans enable row level security;
drop policy if exists billing_plans_read on public.billing_plans;
create policy billing_plans_read on public.billing_plans
  for select to authenticated using (active);
revoke all on public.billing_plans from public, anon, authenticated;
grant select on public.billing_plans to authenticated;

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  plan               text references public.billing_plans(code),
  status             text not null default 'none'
                       check (status in ('none','trialing','active','past_due','canceled','grandfathered')),
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  provider           text,
  provider_ref       text,
  updated_at         timestamptz not null default now()
);
create index if not exists subscriptions_status_idx on public.subscriptions (status);

alter table public.subscriptions enable row level security;

-- You may read your own row and nothing else. There is deliberately NO insert,
-- update or delete policy for authenticated: writes come from the webhook
-- (service_role, which bypasses RLS) or from start_trial() below.
drop policy if exists subscriptions_read_own on public.subscriptions;
create policy subscriptions_read_own on public.subscriptions
  for select to authenticated using (user_id = auth.uid());

revoke all on public.subscriptions from public, anon, authenticated;
grant select on public.subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- Grandfather everyone who is already here.
-- Turning billing on must never take the app away from the people using it.
-- ---------------------------------------------------------------------------
insert into public.subscriptions (user_id, status)
select id, 'grandfathered' from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- entitlement: the single source of truth
-- ---------------------------------------------------------------------------
create or replace function public.entitlement()
returns table (allowed boolean, status text, plan text, until timestamptz, enforced boolean)
language sql stable security definer set search_path = public as $fn$
  with cfg as (select s.enforced from public.billing_settings s where s.id),
  sub as (
    select * from public.subscriptions s where s.user_id = auth.uid()
  )
  select
    -- While billing is off, everyone is allowed. Once on: an active or
    -- grandfathered subscription, or a trial that has not run out.
    (not (select enforced from cfg))
      or coalesce((select status from sub) in ('active','grandfathered'), false)
      or coalesce((select status from sub) = 'trialing'
                  and (select trial_ends_at from sub) > now(), false)
      as allowed,
    coalesce((select status from sub), 'none') as status,
    (select plan from sub) as plan,
    coalesce((select current_period_end from sub), (select trial_ends_at from sub)) as until,
    (select enforced from cfg) as enforced
  where auth.uid() is not null;
$fn$;
revoke all on function public.entitlement() from public, anon;
grant execute on function public.entitlement() to authenticated;

-- Start the free trial. Only ever moves 'none' -> 'trialing', so it cannot be
-- replayed to extend a trial, and cannot downgrade a paid or grandfathered row.
create or replace function public.start_trial()
returns table (allowed boolean, status text, plan text, until timestamptz, enforced boolean)
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

notify pgrst, 'reload schema';
commit;
