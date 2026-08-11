-- ============================================================================
-- "Together" features: birthdays, status notes, and a daily question.
--
-- All three are per-user or per-pair state with no media, so none of them touch
-- the storage policies. Day boundaries use IST (Asia/Kolkata) throughout, like
-- friendship_charms — "today's question" must roll over at the users' midnight,
-- not UTC's.
-- ============================================================================

-- The users' local day. Everything dated in this file goes through it.
create or replace function public.ist_date()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- ---------------------------------------------------------------------------
-- 1. Birthdays
--    status.js has referenced a 🎂 friendship emoji since the beginning with
--    no column behind it. This is that column.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists birthday date;

-- hardening.sql revoked table-wide UPDATE on profiles and re-granted per
-- column, so a new writable column NEEDS its own grant or the write fails with
-- 42501 before RLS is even consulted. SELECT is still granted table-wide.
grant update (birthday) on public.profiles to authenticated;

-- Whose birthday is today, among the caller's accepted friends. SECURITY
-- DEFINER only to keep the date maths server-side; it never returns a profile
-- the caller couldn't already read.
create or replace function public.birthdays_today()
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id
    from public.profiles p
   where p.birthday is not null
     and to_char(p.birthday, 'MM-DD') = to_char(public.ist_date(), 'MM-DD')
     and exists (
       select 1 from public.friendships f
        where f.status = 'accepted'
          and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), p.id));
$$;
revoke all on function public.birthdays_today() from public;
grant execute on function public.birthdays_today() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Status notes — a line under your name that expires after 24h.
--    One row per user (upsert), so a note replaces rather than accumulates.
-- ---------------------------------------------------------------------------
create table if not exists public.status_notes (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

alter table public.status_notes enable row level security;

-- Readable by you and your accepted friends, and only while unexpired — an
-- expired note is invisible immediately rather than waiting for a purge.
drop policy if exists status_read on public.status_notes;
create policy status_read on public.status_notes
  for select to authenticated using (
    expires_at > now()
    and (
      user_id = auth.uid()
      or exists (
        select 1 from public.friendships f
         where f.status = 'accepted'
           and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), status_notes.user_id))
    )
  );

drop policy if exists status_write on public.status_notes;
create policy status_write on public.status_notes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.status_notes to authenticated;

-- Housekeeping: expired notes are already invisible, this just stops the table
-- growing forever. Safe to call from anywhere.
create or replace function public.purge_status_notes()
returns void language sql security definer set search_path = public as $$
  delete from public.status_notes where expires_at < now() - interval '7 days';
$$;

-- ---------------------------------------------------------------------------
-- 3. Question of the day
--    One shared prompt per day. You answer; you only get to SEE their answer
--    once you've written your own. That reveal rule is the whole point — it
--    has to be enforced in RLS, not the client, or it's just a UI suggestion.
-- ---------------------------------------------------------------------------
create table if not exists public.prompts (
  id   int primary key,
  body text not null
);

-- Locked down exactly like bot_quotes (see bot_quotes_lock.sql): RLS on with no
-- policy and grants revoked, so no signed-in user can inject a "question" that
-- every pair is then shown. Clients read it only through todays_prompt().
alter table public.prompts enable row level security;
revoke all on public.prompts from anon, authenticated;

insert into public.prompts (id, body) values
  (1,  'What''s something small I did recently that you appreciated?'),
  (2,  'Where should we go the next time we get a free weekend?'),
  (3,  'What''s a song that reminds you of us?'),
  (4,  'What were you like as a kid?'),
  (5,  'What''s something you want to get better at this year?'),
  (6,  'What''s the best meal we''ve had together?'),
  (7,  'What''s something you''re worried about right now?'),
  (8,  'What''s a moment you wish you could relive?'),
  (9,  'What made you laugh today?'),
  (10, 'What''s something you''ve never told me?'),
  (11, 'What does a perfect ordinary day look like for you?'),
  (12, 'What''s the bravest thing you''ve done?'),
  (13, 'Which of my habits would you keep forever?'),
  (14, 'What are you looking forward to most this month?'),
  (15, 'What''s something you changed your mind about recently?'),
  (16, 'Where do you feel most like yourself?'),
  (17, 'What''s a compliment you got that stuck with you?'),
  (18, 'What''s the first thing you noticed about me?'),
  (19, 'What''s something you want us to do more of?'),
  (20, 'What''s the hardest thing about this week?'),
  (21, 'What''s a smell that takes you straight back somewhere?'),
  (22, 'If money didn''t matter, what would you spend your days doing?'),
  (23, 'What''s something you''re proud of that nobody noticed?'),
  (24, 'What do you need more of from me right now?'),
  (25, 'What''s a tiny thing that always cheers you up?'),
  (26, 'What''s a story from your family you love telling?'),
  (27, 'What''s something you find beautiful that most people walk past?'),
  (28, 'What would you tell yourself five years ago?'),
  (29, 'What''s the kindest thing anyone has done for you?'),
  (30, 'What are we better at now than we were a year ago?')
on conflict (id) do update set body = excluded.body;

create table if not exists public.prompt_answers (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid not null references public.profiles(id) on delete cascade,
  user_b     uuid not null references public.profiles(id) on delete cascade,
  responder  uuid not null references public.profiles(id) on delete cascade,
  on_date    date not null default public.ist_date(),
  prompt_id  int  not null references public.prompts(id),
  body       text not null check (length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now(),
  constraint prompt_answers_ordered check (user_a < user_b),
  unique (user_a, user_b, responder, on_date)
);
create index if not exists prompt_answers_pair_idx
  on public.prompt_answers (user_a, user_b, on_date);

-- Has the caller already answered for this pair/day? SECURITY DEFINER on
-- purpose: the reveal policy below queries prompt_answers, and a policy that
-- reads its OWN table directly recurses infinitely. Going through a definer
-- function breaks the cycle.
create or replace function public.has_answered(ua uuid, ub uuid, d date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.prompt_answers
     where user_a = ua and user_b = ub and on_date = d and responder = auth.uid());
$$;
revoke all on function public.has_answered(uuid, uuid, date) from public;
grant execute on function public.has_answered(uuid, uuid, date) to authenticated;

alter table public.prompt_answers enable row level security;

-- Your own answer always. Theirs ONLY once you've answered that day.
drop policy if exists prompt_read on public.prompt_answers;
create policy prompt_read on public.prompt_answers
  for select to authenticated using (
    auth.uid() in (user_a, user_b)
    and (
      responder = auth.uid()
      or public.has_answered(user_a, user_b, on_date)
    )
  );

-- You may only write your OWN answer, into a pair you belong to, dated today.
-- No UPDATE grant below: an answer is final once written, which is what makes
-- the simultaneous reveal mean anything.
drop policy if exists prompt_write on public.prompt_answers;
create policy prompt_write on public.prompt_answers
  for insert to authenticated
  with check (
    responder = auth.uid()
    and auth.uid() in (user_a, user_b)
    and array[user_a, user_b] = public.pair_key(user_a, user_b)
    and on_date = public.ist_date()
  );

grant select, insert on public.prompt_answers to authenticated;

-- Today's prompt, chosen deterministically from the day number so both people
-- (and every pair) see the same question without storing a schedule.
create or replace function public.todays_prompt()
returns table (id int, body text)
language sql stable security definer set search_path = public as $$
  select p.id, p.body
    from public.prompts p
   where p.id = (
     (extract(epoch from public.ist_date())::bigint / 86400)
       % (select count(*) from public.prompts)
   ) + 1;
$$;
revoke all on function public.todays_prompt() from public;
grant execute on function public.todays_prompt() to authenticated;

-- Whether the OTHER person has answered today, without leaking what they said.
-- Lets the UI say "they're waiting on you" before the reveal.
create or replace function public.prompt_status(other uuid)
returns json language sql stable security definer set search_path = public as $$
  with pk as (select least(auth.uid(), other) ua, greatest(auth.uid(), other) ub)
  select json_build_object(
    'mine_done',   exists (select 1 from public.prompt_answers a, pk
                            where a.user_a = pk.ua and a.user_b = pk.ub
                              and a.on_date = public.ist_date() and a.responder = auth.uid()),
    'theirs_done', exists (select 1 from public.prompt_answers a, pk
                            where a.user_a = pk.ua and a.user_b = pk.ub
                              and a.on_date = public.ist_date() and a.responder = other)
  );
$$;
revoke all on function public.prompt_status(uuid) from public;
grant execute on function public.prompt_status(uuid) to authenticated;

notify pgrst, 'reload schema';
select 'together: birthdays, status notes, question of the day' as status;
