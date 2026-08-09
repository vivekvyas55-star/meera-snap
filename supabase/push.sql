-- ============================================================================
-- Web Push subscriptions — notifications when the app is CLOSED.
--
-- Until now a call only rang if the friend already had the app open, and a
-- message produced nothing at all. A push subscription is the browser's
-- delivery address; the `push` Edge Function signs a VAPID request to it.
--
-- One row per browser/device, keyed by endpoint (the same user on phone +
-- laptop has two). `endpoint` is unique so re-subscribing the same browser
-- updates rather than duplicates.
--
-- RLS: a user manages ONLY their own subscriptions and can never read anyone
-- else's — the endpoint plus keys is enough to push to that device, so this
-- table is a capability store, not just metadata. The Edge Function reads
-- recipients' rows with the service-role key, after checking the caller is an
-- accepted friend of the recipient.
-- ============================================================================
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,   -- client public key (base64url)
  auth       text not null,   -- client auth secret (base64url)
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subs_own on public.push_subscriptions;
create policy push_subs_own on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.push_subscriptions to authenticated;

notify pgrst, 'reload schema';
select 'push_subscriptions ready' as status;
