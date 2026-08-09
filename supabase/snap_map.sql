-- ============================================================================
-- Snap Map: opt-in live location. Ghost Mode is the DEFAULT — a row is only
-- visible to friends when sharing = true, and users start not sharing. An
-- accepted friend can read your location only while you're sharing; you can
-- always read/write your own.
-- ============================================================================
create table if not exists public.locations (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  sharing    boolean not null default false, -- Ghost Mode is the default
  updated_at timestamptz not null default now()
);

alter table public.locations enable row level security;

drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations
  for select to authenticated using (
    user_id = auth.uid()
    or (
      sharing
      and exists (
        select 1 from public.friendships f
         where f.status = 'accepted'
           and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), locations.user_id)
      )
    )
  );

drop policy if exists locations_write on public.locations;
create policy locations_write on public.locations
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.locations to authenticated;

notify pgrst, 'reload schema';
select 'snap map: locations table (Ghost Mode default) enabled' as status;
