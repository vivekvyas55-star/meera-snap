-- ============================================================================
-- "Together since" — a per-pair anniversary date, so a friendship can show how
-- long you've been together (days together + a celebration on the day). Pair-
-- keyed like friendships/streaks (user_a < user_b); either party can read/set it.
-- ============================================================================
create table if not exists public.anniversaries (
  user_a     uuid not null references public.profiles(id) on delete cascade,
  user_b     uuid not null references public.profiles(id) on delete cascade,
  started_on date not null,
  updated_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint anniversaries_ordered check (user_a < user_b)
);
alter table public.anniversaries enable row level security;

drop policy if exists anniv_read on public.anniversaries;
create policy anniv_read on public.anniversaries
  for select to authenticated using (auth.uid() in (user_a, user_b));

drop policy if exists anniv_write on public.anniversaries;
create policy anniv_write on public.anniversaries
  for all to authenticated
  using (auth.uid() in (user_a, user_b))
  with check (auth.uid() in (user_a, user_b));

grant select, insert, update, delete on public.anniversaries to authenticated;

-- Seed vivek + sneha: together since 28 May 2018 (4 years reached 28 May 2022).
insert into public.anniversaries (user_a, user_b, started_on)
select least(v.id, s.id), greatest(v.id, s.id), date '2018-05-28'
  from (select id from public.profiles where username = 'vivek') v,
       (select id from public.profiles where username = 'sneha') s
on conflict (user_a, user_b) do update set started_on = excluded.started_on;

notify pgrst, 'reload schema';
select 'anniversaries table ready; vivek+sneha seeded 2018-05-28' as status;
