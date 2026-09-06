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

-- Personal anniversary values are user data; migration replay must not overwrite them.

notify pgrst, 'reload schema';
select 'anniversaries table ready; vivek+sneha seeded 2018-05-28' as status;
